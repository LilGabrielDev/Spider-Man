import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CREDS_PATH = path.join(__dirname, "auth", "creds.json");
export const DEFAULT_SESSIONS_ROOT_NAME = "sessions";
export const SESSION_FINGERPRINT_FILE = ".session-fingerprint";
export const SESSION_META_FILE = ".session-meta.json";
export const SESSION_SERVER_URL = "https://lilgabriel-session.onrender.com/";
const SESSION_SERVER_URLS = [
    SESSION_SERVER_URL.trim().replace(/\/+$/, "").replace(/\/session$/i, ""),
];
const SESSION_PREFIX_RE = /^(?:LIL|SPIDER)~(?:\s*gzip\/base64)?\s*/i;
const SESSION_ENV_VARS = ["SESSION", "SESSION_ID"];

export function stripWrappingQuotes(value) {
    let trimmed = String(value ?? "").trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        trimmed = trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

export function getRawSessionInput(env = process.env) {
    for (const variable of SESSION_ENV_VARS) {
        const cleaned = stripWrappingQuotes(env?.[variable] || "");
        if (cleaned) {
            return { variable, raw: cleaned };
        }
    }
    return { variable: null, raw: "" };
}

export function getSessionFingerprint(value) {
    const cleaned = stripWrappingQuotes(value);
    if (!cleaned) return "";
    return crypto.createHash("sha256").update(cleaned, "utf8").digest("hex");
}

function isCredsLikeObject(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    return Boolean(
        obj.noiseKey ||
            obj.signedIdentityKey ||
            obj.registrationId !== undefined ||
            obj.me ||
            obj.signedPreKey
    );
}

function isSafeAuthFileName(fileName) {
    const raw = String(fileName || "").trim();
    if (!raw || raw.includes("\0") || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
        return false;
    }
    const base = path.basename(raw);
    if (base !== raw) return false;
    if (base === "creds.json" || base === "creds.json.bak" || base === ".spider-retry-store.json") {
        return true;
    }
    return /^[A-Za-z0-9._@+-]+\.json$/.test(base);
}

function normalizeBundledFileName(fileName) {
    const sanitized = String(fileName || "")
        .trim()
        .replace(/:/g, "-");
    return sanitized;
}

function serializeFileContent(value, replacer) {
    if (typeof value === "string") {
        JSON.parse(value);
        return value;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return replacer ? JSON.stringify(value, replacer) : JSON.stringify(value);
    }
    return null;
}

function collectNestedBaileysKeys(keysObj, outFiles) {
    if (!keysObj || typeof keysObj !== "object" || Array.isArray(keysObj)) return false;
    let added = false;
    for (const [keyOrCategory, entry] of Object.entries(keysObj)) {
        if (entry === null || entry === undefined) continue;
        if (keyOrCategory.endsWith(".json")) {
            const safeName = normalizeBundledFileName(keyOrCategory);
            if (isSafeAuthFileName(safeName)) {
                outFiles[safeName] = entry;
                added = true;
            }
            continue;
        }
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            for (const [id, val] of Object.entries(entry)) {
                if (val === null || val === undefined) continue;
                const candidate = normalizeBundledFileName(`${keyOrCategory}-${id}.json`).replace(/\//g, "__");
                if (isSafeAuthFileName(candidate)) {
                    outFiles[candidate] = val;
                    added = true;
                }
            }
        }
    }
    return added;
}

export function extractSessionFolderBundle(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const fileMapSource =
        parsed.files ??
        parsed.folder ??
        parsed.auth ??
        parsed.sessionFiles ??
        (parsed["creds.json"] !== undefined ? parsed : null);

    if (fileMapSource && typeof fileMapSource === "object" && !Array.isArray(fileMapSource)) {
        const files = {};
        for (const [rawName, val] of Object.entries(fileMapSource)) {
            const safeName = normalizeBundledFileName(rawName);
            if (!isSafeAuthFileName(safeName)) continue;
            if (val === null || val === undefined) continue;
            if (typeof val === "string") {
                try {
                    files[safeName] = JSON.parse(val);
                } catch {
                    continue;
                }
            } else if (typeof val === "object") {
                files[safeName] = val;
            }
        }
        if (isCredsLikeObject(files["creds.json"])) {
            return { kind: "folder", files };
        }
    }

    if (parsed.creds && typeof parsed.creds === "object" && isCredsLikeObject(parsed.creds)) {
        const files = { "creds.json": parsed.creds };
        if (parsed.keys && typeof parsed.keys === "object") {
            collectNestedBaileysKeys(parsed.keys, files);
        }
        return { kind: "folder", files };
    }

    if (isCredsLikeObject(parsed)) {
        return { kind: "creds", creds: parsed, files: { "creds.json": parsed } };
    }

    return null;
}

function decodeBase64Variants(candidate) {
    const attempts = [candidate];
    try {
        const uriDecoded = decodeURIComponent(candidate);
        if (uriDecoded !== candidate) attempts.push(uriDecoded);
    } catch {}

    for (const attempt of attempts) {
        const normalizedB64 = attempt.replace(/-/g, "+").replace(/_/g, "/");
        const paddedB64 =
            normalizedB64.length % 4 === 0
                ? normalizedB64
                : normalizedB64 + "=".repeat(4 - (normalizedB64.length % 4));

        for (const b64 of [attempt, paddedB64]) {
            try {
                const decoded = Buffer.from(b64, "base64");
                if (!decoded.length) continue;

                let text;
                try {
                    text = gunzipSync(decoded).toString("utf8");
                } catch {
                    try {
                        text = inflateRawSync(decoded.subarray(10)).toString("utf8");
                    } catch {
                        text = decoded.toString("utf8");
                    }
                }

                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    return Buffer.from(text, "utf8").toString("base64");
                }
            } catch {}
        }
    }

    return null;
}

export function normalizeSession(value) {
    const input = stripWrappingQuotes(value);
    if (!input) return null;

    if (input.startsWith("{")) {
        try {
            const parsed = JSON.parse(input);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64");
            }
        } catch {}
    }

    const isPrefixed = SESSION_PREFIX_RE.test(input);
    const payload = (isPrefixed ? input.replace(SESSION_PREFIX_RE, "") : input).replace(/\s+/g, "");
    const normalized = decodeBase64Variants(payload);
    if (normalized) return normalized;

    if (isPrefixed) {
        throw new Error("LIL~ session must contain valid gzip/base64 credentials.");
    }
    throw new Error("SESSION must be base64-encoded credentials, or SESSION_ID must use the LIL~ format.");
}

export function parseSessionPayload(value, reviver) {
    const normalizedB64 = normalizeSession(value);
    if (!normalizedB64) return null;
    const rawJson = Buffer.from(normalizedB64, "base64").toString("utf8");
    const parsed = reviver ? JSON.parse(rawJson, reviver) : JSON.parse(rawJson);
    const bundle = extractSessionFolderBundle(parsed);
    if (bundle) return bundle;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { kind: "creds", creds: parsed, files: { "creds.json": parsed } };
    }
    return null;
}

function canDecodeCredentials(value) {
    try {
        return Boolean(normalizeSession(value));
    } catch {
        return false;
    }
}

export function isShortLilSession(value) {
    const cleaned = stripWrappingQuotes(value);
    if (!SESSION_PREFIX_RE.test(cleaned)) return false;
    const payload = cleaned.replace(SESSION_PREFIX_RE, "").replace(/\s+/g, "");
    if (!payload || payload.length > 128 || !/^[A-Za-z0-9._-]+$/.test(payload)) {
        return false;
    }
    return !canDecodeCredentials(cleaned);
}

export function deriveSessionFolderName(value) {
    const cleaned = stripWrappingQuotes(value);
    if (!cleaned) return "default";
    if (isShortLilSession(cleaned)) {
        const prefixMatch = cleaned.match(/^(LIL|SPIDER)~/i);
        const prefix = (prefixMatch?.[1] || "LIL").toUpperCase();
        const payload = cleaned.replace(SESSION_PREFIX_RE, "").replace(/\s+/g, "");
        const safePayload = payload.replace(/[^A-Za-z0-9._-]/g, "_");
        if (safePayload && safePayload.length <= 64) {
            return `${prefix}_${safePayload}`;
        }
        const shortHash = getSessionFingerprint(cleaned).slice(0, 12);
        return `${prefix}_${safePayload.slice(0, 32)}_${shortHash}`;
    }
    return `session_${getSessionFingerprint(cleaned).slice(0, 16)}`;
}

function isDirWritable(dirPath, fsImpl = fs) {
    try {
        fsImpl.mkdirSync(dirPath, { recursive: true });
        const probe = path.join(dirPath, `.wp-${process.pid}-${Date.now()}`);
        fsImpl.writeFileSync(probe, "");
        fsImpl.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

export function resolveSessionFolder({
    cwd = REPO_ROOT,
    authDir,
    sessionDir,
    env = process.env,
    rawSession,
    fallbackDir = path.join(__dirname, "auth"),
    tmpDir = os.tmpdir(),
    fsImpl = fs,
} = {}) {
    const explicitAuthDir = stripWrappingQuotes(authDir ?? env?.AUTH_DIR ?? "");
    if (explicitAuthDir) {
        const resolved = path.resolve(explicitAuthDir);
        if (isDirWritable(resolved, fsImpl)) return resolved;
        const fb = path.join(tmpDir, "spider-auth");
        isDirWritable(fb, fsImpl);
        return fb;
    }

    const explicitSessionDir = stripWrappingQuotes(sessionDir ?? env?.SESSION_DIR ?? "");
    const sessionValue = stripWrappingQuotes(rawSession ?? getRawSessionInput(env).raw ?? "");
    const folderKey = stripWrappingQuotes(env?.SPIDER_SESSION_FOLDER_KEY ?? "") || sessionValue;

    if (explicitSessionDir) {
        const resolved = path.resolve(explicitSessionDir);
        if (isDirWritable(resolved, fsImpl)) return resolved;
        const fb = path.join(tmpDir, "spider-sessions");
        isDirWritable(fb, fsImpl);
        return fb;
    }

    if (folderKey) {
        const folderName = deriveSessionFolderName(folderKey);
        const sessionsRoot = path.join(path.resolve(cwd || REPO_ROOT), DEFAULT_SESSIONS_ROOT_NAME);
        const target = path.join(sessionsRoot, folderName);
        if (isDirWritable(target, fsImpl)) return target;
        const fb = path.join(tmpDir, "spider-sessions", folderName);
        isDirWritable(fb, fsImpl);
        return fb;
    }

    if (fallbackDir) {
        const resolvedFallback = path.resolve(fallbackDir);
        if (isDirWritable(resolvedFallback, fsImpl)) return resolvedFallback;
    }

    const defaultSessionDir = path.join(path.resolve(cwd || REPO_ROOT), DEFAULT_SESSIONS_ROOT_NAME, "default");
    if (isDirWritable(defaultSessionDir, fsImpl)) return defaultSessionDir;
    const tmpFallback = path.join(tmpDir, "spider-auth");
    isDirWritable(tmpFallback, fsImpl);
    return tmpFallback;
}

export function readSessionFingerprint(sessionDir, fsImpl = fs) {
    if (!sessionDir) return null;
    try {
        const fpPath = path.join(sessionDir, SESSION_FINGERPRINT_FILE);
        if (!fsImpl.existsSync(fpPath)) return null;
        const val = String(fsImpl.readFileSync(fpPath, "utf8") || "").trim();
        return val || null;
    } catch {
        return null;
    }
}

export function hasMatchingSessionFingerprint(sessionDir, rawSessionInput, fsImpl = fs) {
    const cleaned = stripWrappingQuotes(rawSessionInput);
    if (!cleaned) return null;
    const stored = readSessionFingerprint(sessionDir, fsImpl);
    if (!stored) return null;
    return stored === getSessionFingerprint(cleaned);
}

export function markSessionActive(sessionDir, { rawSessionInput, nowMs = Date.now(), fsImpl = fs } = {}) {
    if (!sessionDir) return false;
    try {
        if (!fsImpl.existsSync(sessionDir)) return false;
        const metaPath = path.join(sessionDir, SESSION_META_FILE);
        let prev = {};
        try {
            if (fsImpl.existsSync(metaPath)) {
                prev = JSON.parse(fsImpl.readFileSync(metaPath, "utf8")) || {};
            }
        } catch {}
        const next = {
            ...prev,
            folder: path.basename(sessionDir),
            ...(rawSessionInput ? { fingerprint: getSessionFingerprint(rawSessionInput) } : {}),
            lastActiveAt: new Date(nowMs).toISOString(),
        };
        fsImpl.writeFileSync(metaPath, JSON.stringify(next, null, 2), { mode: 0o600 });
        if (typeof fsImpl.utimesSync === "function") {
            const nowDate = new Date(nowMs);
            try {
                fsImpl.utimesSync(sessionDir, nowDate, nowDate);
            } catch {}
        }
        return true;
    } catch {
        return false;
    }
}

const STALE_ACCOUNT_FILE_PREFIXES = [
    "sender-key-",
    "session-",
    "pre-key-",
    "tctoken-",
    "app-state-sync-",
    "lid-mapping-",
    "device-list-",
];

function clearPreviousAccountFiles(targetDir, fsImpl = fs) {
    try {
        if (!fsImpl.existsSync(targetDir)) return;
        for (const name of fsImpl.readdirSync(targetDir)) {
            if (
                name === "creds.json.bak" ||
                name === ".spider-retry-store.json" ||
                name === "retry-message-store.json" ||
                STALE_ACCOUNT_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))
            ) {
                try {
                    fsImpl.unlinkSync(path.join(targetDir, name));
                } catch {}
            }
        }
    } catch {}
}

function toCanonicalKeyString(val) {
    if (!val) return "";
    if (Buffer.isBuffer(val)) return val.toString("base64");
    if (typeof val === "object" && val.type === "Buffer" && Array.isArray(val.data)) {
        return Buffer.from(val.data).toString("base64");
    }
    try {
        return JSON.stringify(val);
    } catch {
        return "";
    }
}

function hasSameCredsIdentity(credsPath, newCreds, bufferJsonReviver, fsImpl = fs) {
    try {
        if (!fsImpl.existsSync(credsPath)) return false;
        const raw = fsImpl.readFileSync(credsPath, "utf8");
        const existing = bufferJsonReviver ? JSON.parse(raw, bufferJsonReviver) : JSON.parse(raw);
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
        if (
            existing.registrationId !== undefined &&
            newCreds?.registrationId !== undefined &&
            existing.registrationId !== newCreds.registrationId
        ) {
            return false;
        }
        const existingNoise = toCanonicalKeyString(existing.noiseKey?.public);
        const newNoise = toCanonicalKeyString(newCreds?.noiseKey?.public);
        if (existingNoise && newNoise && existingNoise !== newNoise) {
            return false;
        }
        const existingMe = String(existing.me?.id || "").split(":")[0].split("@")[0];
        const newMe = String(newCreds?.me?.id || "").split(":")[0].split("@")[0];
        if (existingMe && newMe && existingMe !== newMe) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function hydrateSessionToFolder(sessionValue, targetDir, options = {}) {
    if (!sessionValue || !targetDir) return false;
    const {
        rawSessionInput = "",
        onlyIfChanged = false,
        replaceOnMismatch = true,
        normalizeCredsFn = null,
        bufferJsonReviver = undefined,
        bufferJsonReplacer = undefined,
        nowMs = Date.now(),
        fsImpl = fs,
    } = options;

    const parsed = parseSessionPayload(sessionValue, bufferJsonReviver);
    if (!parsed || !parsed.files || !isCredsLikeObject(parsed.files["creds.json"])) {
        return false;
    }

    const credsPath = path.join(targetDir, "creds.json");
    const credsObj = parsed.files["creds.json"];
    const effectiveRaw = stripWrappingQuotes(rawSessionInput) || stripWrappingQuotes(sessionValue);
    const nextFingerprint = getSessionFingerprint(effectiveRaw);
    const prevFingerprint = readSessionFingerprint(targetDir, fsImpl);
    const credsExists = fsImpl.existsSync(credsPath) || fsImpl.existsSync(`${credsPath}.bak`);
    const fingerprintMatches = Boolean(prevFingerprint && nextFingerprint && prevFingerprint === nextFingerprint);
    const legacyIdentityMatches = !prevFingerprint && credsExists
        ? hasSameCredsIdentity(credsPath, credsObj, bufferJsonReviver, fsImpl)
        : false;

    if (onlyIfChanged && credsExists) {
        if (fingerprintMatches || legacyIdentityMatches) {
            if (nextFingerprint && !prevFingerprint) {
                try {
                    fsImpl.writeFileSync(path.join(targetDir, SESSION_FINGERPRINT_FILE), nextFingerprint, {
                        encoding: "utf8",
                        mode: 0o600,
                    });
                } catch {}
            }
            markSessionActive(targetDir, { rawSessionInput: effectiveRaw, nowMs, fsImpl });
            return true;
        }
    }

    fsImpl.mkdirSync(targetDir, { recursive: true });

    const isMismatchedAccount = credsExists && (
        (prevFingerprint && nextFingerprint && prevFingerprint !== nextFingerprint) ||
        (!prevFingerprint && !legacyIdentityMatches)
    );
    if (replaceOnMismatch && isMismatchedAccount) {
        clearPreviousAccountFiles(targetDir, fsImpl);
    }

    const bundledFileNames = Object.keys(parsed.files);
    const hasBundledPreKeys = bundledFileNames.some((name) => name.startsWith("pre-key-"));

    if (typeof normalizeCredsFn === "function") {
        normalizeCredsFn(credsObj);
    }
    if (credsObj.registered && credsObj.me?.id && !(credsObj.accountSyncCounter > 0)) {
        credsObj.accountSyncCounter = 1;
    }
    if (!hasBundledPreKeys && Number(credsObj.nextPreKeyId) > 1) {
        credsObj.firstUnuploadedPreKeyId = Number(credsObj.nextPreKeyId);
    }

    for (const [fileName, fileValue] of Object.entries(parsed.files)) {
        if (!isSafeAuthFileName(fileName)) continue;
        const destPath = path.join(targetDir, fileName);
        if (fileName === "creds.json") {
            const jsonText = bufferJsonReplacer
                ? JSON.stringify(fileValue, bufferJsonReplacer)
                : JSON.stringify(fileValue);
            fsImpl.writeFileSync(destPath, jsonText, { encoding: "utf8", mode: 0o600 });
        } else {
            const jsonText = serializeFileContent(fileValue, bufferJsonReplacer);
            if (!jsonText) continue;
            fsImpl.writeFileSync(destPath, jsonText, { encoding: "utf8", mode: 0o600 });
        }
    }

    if (nextFingerprint) {
        try {
            fsImpl.writeFileSync(path.join(targetDir, SESSION_FINGERPRINT_FILE), nextFingerprint, {
                encoding: "utf8",
                mode: 0o600,
            });
        } catch {}
    }
    markSessionActive(targetDir, { rawSessionInput: effectiveRaw, nowMs, fsImpl });
    return true;
}

function extractSessionFromResponse(rawText) {
    const trimmed = stripWrappingQuotes(rawText);
    if (!trimmed) return null;

    let candidate = trimmed;
    if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "string") {
                candidate = parsed.trim();
            } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const directBundle = extractSessionFolderBundle(parsed);
                if (directBundle) {
                    candidate = JSON.stringify(parsed);
                } else {
                    const nested =
                        parsed.session ??
                        parsed.sessionId ??
                        parsed.session_id ??
                        parsed.data ??
                        parsed.result ??
                        parsed.value ??
                        parsed.creds ??
                        parsed.files ??
                        parsed.folder ??
                        parsed.auth;
                    if (typeof nested === "string") {
                        candidate = nested.trim();
                    } else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
                        candidate = JSON.stringify(nested);
                    } else {
                        return null;
                    }
                }
            }
        } catch {}
    }

    let normalized;
    try {
        normalized = normalizeSession(candidate);
    } catch {
        return null;
    }
    if (!normalized) return null;

    if (SESSION_PREFIX_RE.test(candidate)) {
        return candidate;
    }
    return normalized;
}

function isTransientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function fetchShortSessionFromServers(
    cleanedInput,
    payload,
    fetchImpl,
    { retries = 2, retryDelayMs = 200, timeoutMs = 15_000 } = {}
) {
    const baseUrls = SESSION_SERVER_URLS;
    const lookupIds = cleanedInput !== payload ? [payload, cleanedInput] : [payload];
    const maxAttempts = Math.max(1, (Number(retries) || 0) + 1);
    const reqTimeoutMs = Math.max(500, Number(timeoutMs) || 15_000);
    let lastError = null;

    for (const baseUrl of baseUrls) {
        for (const lookupId of lookupIds) {
            const paths = [
                `${baseUrl}/session/${encodeURIComponent(lookupId)}`,
                `${baseUrl}/api/session/${encodeURIComponent(lookupId)}`,
            ];

            for (const url of paths) {
                for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                    const controller = new AbortController();
                    const timer = setTimeout(() => {
                        controller.abort(new Error(`Request timed out after ${reqTimeoutMs}ms`));
                    }, reqTimeoutMs);
                    try {
                        const response = await fetchImpl(url, {
                            headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.8" },
                            signal: controller.signal,
                        });

                        if (!response.ok) {
                            lastError = new Error(
                                `Short Spider-Man session lookup failed (${response.status}) at ${baseUrl}`
                            );
                            if (response.status === 404) {
                                break;
                            }
                            if (isTransientStatus(response.status) && attempt < maxAttempts) {
                                await waitMs(retryDelayMs * attempt);
                                continue;
                            }
                            break;
                        }

                        const bodyText = await response.text();
                        const resolved = extractSessionFromResponse(bodyText);
                        if (!resolved) {
                            lastError = new Error(
                                `Short Spider-Man session lookup returned an invalid session from ${baseUrl}`
                            );
                            break;
                        }

                        return resolved;
                    } catch (error) {
                        const detail =
                            error?.cause?.code || error?.cause?.message || error?.message || String(error);
                        lastError = new Error(`Short Spider-Man session lookup failed (${detail}) at ${baseUrl}`);
                        if (attempt < maxAttempts) {
                            await waitMs(retryDelayMs * attempt);
                            continue;
                        }
                        break;
                    } finally {
                        clearTimeout(timer);
                    }
                }
            }
        }
    }

    throw lastError || new Error("Short Spider-Man session lookup failed");
}

function readExistingCredsBase64(credsPath) {
    try {
        if (!credsPath || !fs.existsSync(credsPath)) return null;
        const raw = fs.readFileSync(credsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return Buffer.from(raw, "utf8").toString("base64");
        }
    } catch {}
    return null;
}

export async function resolveShortSession(options = {}) {
    const {
        credsPath,
        authDir,
        sessionDir,
        cwd = process.cwd(),
        loadEnv = true,
        hydrate,
        fetchImpl = globalThis.fetch,
        retries = 2,
        retryDelayMs = 200,
        timeoutMs = 15_000,
    } = options;

    if (loadEnv) {
        dotenv.config({ path: ".env" });
    }

    let resolvedFolder = null;
    if (sessionDir || authDir) {
        resolvedFolder = path.resolve(sessionDir || authDir);
    } else if (!credsPath) {
        resolvedFolder = resolveSessionFolder({
            cwd,
            env: process.env,
            fallbackDir: path.dirname(DEFAULT_CREDS_PATH),
        });
    }

    const effectiveCredsPath = credsPath || path.join(resolvedFolder || path.dirname(DEFAULT_CREDS_PATH), "creds.json");
    const effectiveDir = path.dirname(effectiveCredsPath);
    const shouldHydrate =
        hydrate !== undefined
            ? Boolean(hydrate)
            : Boolean(resolvedFolder || (effectiveDir && fs.existsSync(effectiveDir)));

    for (const variable of SESSION_ENV_VARS) {
        const rawValue = process.env[variable];
        if (!rawValue || !rawValue.trim()) continue;

        const cleaned = stripWrappingQuotes(rawValue);
        if (!isShortLilSession(cleaned)) {
            if (shouldHydrate && effectiveDir) {
                try {
                    hydrateSessionToFolder(cleaned, effectiveDir, {
                        rawSessionInput: cleaned,
                        onlyIfChanged: true,
                    });
                } catch {}
            }
            continue;
        }

        const payload = cleaned.replace(SESSION_PREFIX_RE, "").replace(/\s+/g, "");
        try {
            const fullSession = await fetchShortSessionFromServers(cleaned, payload, fetchImpl, {
                retries,
                retryDelayMs,
                timeoutMs,
            });
            process.env[variable] = fullSession;
            if (shouldHydrate && effectiveDir) {
                try {
                    hydrateSessionToFolder(fullSession, effectiveDir, {
                        rawSessionInput: cleaned,
                        replaceOnMismatch: true,
                    });
                } catch {}
            }
        } catch (error) {
            const fingerprintMatch = hasMatchingSessionFingerprint(effectiveDir, cleaned);
            const existingCreds = fingerprintMatch !== false ? readExistingCredsBase64(effectiveCredsPath) : null;
            if (existingCreds) {
                console.warn(
                    `⚠️ ${error.message}; reusing existing credentials from ${effectiveCredsPath}.`
                );
                process.env[variable] = existingCreds;
                markSessionActive(effectiveDir, { rawSessionInput: cleaned });
                continue;
            }
            throw error;
        }
    }
}
