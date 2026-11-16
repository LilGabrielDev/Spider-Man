'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

const SESSION_PREFIX_RE = /^(?:LIL|SPIDER)~(?:\s*gzip\/base64)?\s*/i;

function stripWrappingQuotes(value) {
    let trimmed = String(value ?? '').trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        trimmed = trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function getRawSessionValue(env = process.env) {
    for (const key of ['SESSION', 'SESSION_ID']) {
        const val = stripWrappingQuotes(env?.[key] || '');
        if (val) return val;
    }
    return '';
}

function canDecodeSync(cleaned) {
    if (!cleaned) return false;
    if (cleaned.startsWith('{')) {
        try {
            const parsed = JSON.parse(cleaned);
            return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
        } catch {
            return false;
        }
    }
    const isPrefixed = SESSION_PREFIX_RE.test(cleaned);
    const payload = (isPrefixed ? cleaned.replace(SESSION_PREFIX_RE, '') : cleaned).replace(/\s+/g, '');
    if (!payload) return false;
    try {
        const normalizedB64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const paddedB64 =
            normalizedB64.length % 4 === 0
                ? normalizedB64
                : normalizedB64 + '='.repeat(4 - (normalizedB64.length % 4));
        const decoded = Buffer.from(paddedB64, 'base64');
        if (!decoded.length) return false;
        let text;
        try {
            text = zlib.gunzipSync(decoded).toString('utf8');
        } catch {
            try {
                text = zlib.inflateRawSync(decoded.subarray(10)).toString('utf8');
            } catch {
                text = decoded.toString('utf8');
            }
        }
        const parsed = JSON.parse(text);
        return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    } catch {
        return false;
    }
}

function deriveSyncFolderName(value) {
    const cleaned = stripWrappingQuotes(value);
    if (!cleaned) return 'default';
    if (SESSION_PREFIX_RE.test(cleaned)) {
        const payload = cleaned.replace(SESSION_PREFIX_RE, '').replace(/\s+/g, '');
        if (payload && payload.length <= 128 && /^[A-Za-z0-9._-]+$/.test(payload) && !canDecodeSync(cleaned)) {
            const prefixMatch = cleaned.match(/^(LIL|SPIDER)~/i);
            const prefix = (prefixMatch?.[1] || 'LIL').toUpperCase();
            const safePayload = payload.replace(/[^A-Za-z0-9._-]/g, '_');
            if (safePayload && safePayload.length <= 64) {
                return `${prefix}_${safePayload}`;
            }
            const shortHash = crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 12);
            return `${prefix}_${safePayload.slice(0, 32)}_${shortHash}`;
        }
    }
    const hash = crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex').slice(0, 16);
    return `session_${hash}`;
}

function resolveSessionDirSync(env = process.env, cwd = process.cwd()) {
    const explicitAuth = stripWrappingQuotes(env?.AUTH_DIR || '');
    const explicitSession = stripWrappingQuotes(env?.SESSION_DIR || '');
    const rawKey = stripWrappingQuotes(env?.SPIDER_SESSION_FOLDER_KEY || '') || getRawSessionValue(env);

    let preferred;
    if (explicitAuth) {
        preferred = path.resolve(explicitAuth);
    } else if (explicitSession) {
        preferred = path.resolve(explicitSession);
    } else if (rawKey) {
        preferred = path.join(cwd, 'sessions', deriveSyncFolderName(rawKey));
    } else {
        preferred = path.join(cwd, 'sessions', 'default');
    }

    try {
        if (!fs.existsSync(preferred)) fs.mkdirSync(preferred, { recursive: true });
        const probe = path.join(preferred, `.wp-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return preferred;
    } catch {
        const fallback = path.join(os.tmpdir(), 'spider-sessions', path.basename(preferred));
        try {
            if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
        } catch {}
        return fallback;
    }
}

const SESSION_DIR = resolveSessionDirSync();

let _resolverPromise = null;
function loadSessionResolver() {
    if (!_resolverPromise) {
        const resolverPath = path.resolve(__dirname, '../../../../spider/session-resolver.js');
        _resolverPromise = import(pathToFileURL(resolverPath).href);
    }
    return _resolverPromise;
}

async function resolveSession(options = {}) {
    const resolver = await loadSessionResolver();
    const targetDir = resolver.resolveSessionFolder({
        cwd: options.cwd || process.cwd(),
        authDir: options.authDir,
        sessionDir: options.sessionDir,
        env: options.env || process.env,
        fallbackDir: SESSION_DIR,
    });

    try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    } catch {}

    const { raw } = resolver.getRawSessionInput(options.env || process.env);
    if (!raw) {
        console.log('\n⚡ SPIDER MAN MD — Session Setup\n');
        console.log('No SESSION or SESSION_ID found in environment.');
        console.log('Configure SESSION_ID from your Spider Man pairing setup.\n');
        return { sessionDir: targetDir, hydrated: false };
    }

    if (resolver.isShortLilSession(raw)) {
        await resolver.resolveShortSession({
            authDir: targetDir,
            credsPath: path.join(targetDir, 'creds.json'),
            cwd: options.cwd || process.cwd(),
            loadEnv: false,
            fetchImpl: options.fetchImpl,
            retries: options.retries,
            retryDelayMs: options.retryDelayMs,
            timeoutMs: options.timeoutMs,
        });
        console.log(`[SESSION] Resolved short session into folder ${targetDir}.`);
        return { sessionDir: targetDir, hydrated: true };
    }

    const hydrated = resolver.hydrateSessionToFolder(raw, targetDir, {
        rawSessionInput: raw,
        onlyIfChanged: true,
        replaceOnMismatch: true,
    });
    if (!hydrated) {
        const errMsg = `[SESSION] Failed to hydrate session into ${targetDir}.`;
        console.error(errMsg);
        throw new Error(errMsg);
    }
    console.log(`[SESSION] Session ready in folder ${targetDir}.`);
    return { sessionDir: targetDir, hydrated: true };
}

module.exports = {
    resolveSession,
    resolveSessionDir: resolveSessionDirSync,
    SESSION_DIR,
};