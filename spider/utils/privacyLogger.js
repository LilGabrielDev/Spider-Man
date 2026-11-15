const noop = () => {};

export const SILENT_LOGGER = Object.freeze({
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child() {
        return SILENT_LOGGER;
    }
});

export function redactPhoneOrJid(value) {
    if (value === undefined || value === null) return '';
    const str = String(value).trim();
    if (!str) return '';

    const atIdx = str.indexOf('@');
    if (atIdx > 0) {
        if (str.toLowerCase() === 'status@broadcast') return 'status@broadcast';
        const local = str.slice(0, atIdx).split(':')[0];
        const domain = str.slice(atIdx);
        if (local.startsWith('••••') || local === '[redacted]') {
            return `${local}${domain}`;
        }
        if (local.length <= 2) return `[redacted]${domain}`;
        return `••••${local.slice(-2)}${domain}`;
    }

    const digits = str.replace(/\D/g, '');
    if (digits.length >= 6) {
        return `••••${digits.slice(-2)}`;
    }
    if (str.length <= 2) return '••••';
    return `••••${str.slice(-2)}`;
}

export function sanitizeConsoleText(value) {
    if (value === undefined || value === null) return '';
    let text = typeof value === 'string' ? value : (value?.message ? String(value.message) : String(value));

    // Redact session & auth tokens
    text = text.replace(/\b(?:LIL|SPIDER)~[A-Za-z0-9+/=_:-]+/g, '[redacted-token]');
    text = text.replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');

    // Redact WhatsApp JIDs / LIDs / newsletter / broadcast identifiers (skip already-redacted •••• tokens)
    text = text.replace(
        /(••••|\[redacted\])?([A-Za-z0-9+._:-]+@(?:s\.whatsapp\.net|g\.us|lid|newsletter|broadcast))/gi,
        (full, maskPrefix, match) => (maskPrefix ? full : redactPhoneOrJid(match))
    );

    // Redact standalone phone numbers (7+ digits, optional + / spaces / hyphens), skipping keyId=...
    text = text.replace(/(\bkeyId=)?(\+?\d[\d\s-]{5,}\d)/gi, (match, prefix) => {
        if (prefix) return match;
        const digits = match.replace(/\D/g, '');
        if (digits.length < 7) return match;
        return `••••${digits.slice(-2)}`;
    });

    return text;
}

// Intentionally silent no-ops so incoming messages, commands, and status content never print to console.
export function logIncomingMessage() {
    return undefined;
}

export function logCommandExecution() {
    return undefined;
}

export function logStatusUpdate() {
    return undefined;
}

function summarizeErrorPayload(arg) {
    if (!arg) return '';
    if (typeof arg === 'string') return sanitizeConsoleText(arg);
    if (arg instanceof Error) return sanitizeConsoleText(arg.message || arg.name || 'Error');
    if (typeof arg === 'object') {
        const parts = [];
        const err = arg.err || arg.error;
        if (err) {
            const rawErrText = typeof err === 'string'
                ? err
                : (err?.message ? String(err.message) : String(err));
            const singleLineErr = rawErrText.split(/\r?\n\s*at\s+/)[0].trim();
            parts.push(sanitizeConsoleText(singleLineErr));
        }
        if (arg.reason) parts.push(`reason=${sanitizeConsoleText(String(arg.reason))}`);
        if (arg.statusCode) parts.push(`status=${Number(arg.statusCode) || sanitizeConsoleText(String(arg.statusCode))}`);
        const effectiveJid = arg.jid || (!arg.from ? arg.key?.remoteJid : '');
        const effectiveParticipant = arg.participant || arg.key?.participant;
        const effectiveFrom = arg.from || arg.attrs?.from;
        if (effectiveJid) parts.push(`jid=${redactPhoneOrJid(effectiveJid)}`);
        if (effectiveParticipant) parts.push(`participant=${redactPhoneOrJid(effectiveParticipant)}`);
        if (effectiveFrom) parts.push(`from=${redactPhoneOrJid(effectiveFrom)}`);
        if (arg.attrs?.class) parts.push(`class=${sanitizeConsoleText(String(arg.attrs.class))}`);
        if (arg.attrs?.type) parts.push(`type=${sanitizeConsoleText(String(arg.attrs.type))}`);
        if (arg.attrs?.error) parts.push(`ackError=${sanitizeConsoleText(String(arg.attrs.error))}`);
        if (arg.attrs?.code) parts.push(`code=${sanitizeConsoleText(String(arg.attrs.code))}`);
        if (arg.retryCount !== undefined) parts.push(`retry=${Number(arg.retryCount) || 0}`);
        return parts.join(' ');
    }
    return sanitizeConsoleText(String(arg));
}

const LIBSIGNAL_CONSOLE_NOISE_PATTERNS = [
    /Failed to decrypt message with any known session/i,
    /^Session error:/i,
    /\bSession error:\s*Error:\s*Bad MAC\b/i,
    /\bat Object\.verifyMAC\b/i,
    /\bat SessionCipher\.(?:doDecryptWhisperMessage|decryptWithSessions|decryptWhisperMessage)\b/i,
    /\b(?:Closing open session|Closing session:|Removing old closed session:|Decrypted message with closed session:)/i,
];

function consoleArgToText(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.message || arg.name || 'Error'} ${arg.stack || ''}`;
    if (arg && typeof arg === 'object') {
        try {
            return JSON.stringify(arg);
        } catch {
            return String(arg);
        }
    }
    return String(arg ?? '');
}

export function isLibsignalConsoleNoise(args) {
    if (!Array.isArray(args) || args.length === 0) return false;
    const joined = args.map(consoleArgToText).join(' ');
    if (LIBSIGNAL_CONSOLE_NOISE_PATTERNS.some((re) => re.test(joined))) {
        return true;
    }
    if (
        args.some(
            (arg) =>
                arg &&
                typeof arg === 'object' &&
                !Array.isArray(arg) &&
                !(arg instanceof Error) &&
                (arg._chains || arg.currentRatchet || (arg.indexInfo && arg.registrationId)),
        )
    ) {
        return true;
    }
    return false;
}

export function installConsoleSignalSanitizer() {
    if (console.__spiderSignalSanitizerInstalled) return true;
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    const wrapMethod = (origFn) => (...args) => {
        if (isLibsignalConsoleNoise(args)) {
            return;
        }
        const sanitizedArgs = args.map((arg) =>
            typeof arg === 'string' ? sanitizeConsoleText(arg) : arg,
        );
        return origFn(...sanitizedArgs);
    };

    try {
        console.error = wrapMethod(origError);
        console.warn = wrapMethod(origWarn);
        console.__spiderSignalSanitizerInstalled = true;
    } catch {
        return false;
    }
    return true;
}

function isRedundantOrBenignBaileysMessage(lowerSummary) {
    if (!lowerSummary) return false;
    if (lowerSummary.startsWith('transaction failed, rolling back')) return true;
    if (
        lowerSummary.includes('invalid mex newsletter notification content') ||
        lowerSummary.includes('invalid mex newsletter notification') ||
        lowerSummary.includes('unknown newsletter notification child')
    ) {
        return true;
    }
    if (
        lowerSummary.includes('blocked on missing key') &&
        lowerSummary.includes('parking after')
    ) {
        return true;
    }
    if (
        lowerSummary === 'url generation failed' ||
        lowerSummary.startsWith('url generation failed |')
    ) {
        return true;
    }
    if (
        lowerSummary.startsWith('failed to decrypt message') &&
        (
            lowerSummary.includes('invalid prekey id') ||
            (
                lowerSummary.includes('status@broadcast') &&
                (
                    lowerSummary.includes('no session found') ||
                    lowerSummary.includes('no session record') ||
                    lowerSummary.includes('no senderkeyrecord found') ||
                    lowerSummary.includes('no matching sessions found') ||
                    lowerSummary.includes('no sessions available') ||
                    lowerSummary.includes('key used already') ||
                    lowerSummary.includes('bad mac')
                )
            )
        )
    ) {
        return true;
    }
    if (lowerSummary.startsWith('received error in ack')) {
        return true;
    }
    return false;
}

export function createBaileysSignalLogger({
    onEvent = null,
    onMissingAppStateKey = null,
    level = 'warn',
    throttleMs = 10_000,
} = {}) {
    const diagnostics = {
        warnings: 0,
        errors: 0,
        decryptFailures: 0,
        encryptFailures: 0,
        retryFailures: 0,
        sessionErrors: 0,
        lastEventAt: 0,
        lastSummary: '',
    };
    const recentMessages = new Map();

    function recordAndEmit(severity, args) {
        const [first, second] = args;
        const msgPart = typeof first === 'string' ? first : (typeof second === 'string' ? second : '');
        const metaPart = typeof first === 'object' && first !== null ? first : null;
        const cleanMsg = sanitizeConsoleText(msgPart);
        const cleanMeta = summarizeErrorPayload(metaPart);
        const combined = [cleanMsg, cleanMeta].filter(Boolean).join(' | ');
        const lower = combined.toLowerCase();

        if (severity === 'warn') diagnostics.warnings += 1;
        else diagnostics.errors += 1;

        if (lower.includes('decrypt') || lower.includes('bad mac') || lower.includes('invalid prekey')) {
            diagnostics.decryptFailures += 1;
        }
        if (lower.includes('encrypt')) {
            diagnostics.encryptFailures += 1;
        }
        if (lower.includes('retry') || lower.includes('sending message again') || lower.includes('placeholder')) {
            diagnostics.retryFailures += 1;
        }
        if (lower.includes('session') || lower.includes('sender key') || lower.includes('sender-key') || lower.includes('identity')) {
            diagnostics.sessionErrors += 1;
        }

        if (typeof onMissingAppStateKey === 'function') {
            const keyMatch = combined.match(/failed to find key\s+"([^"]+)"/i);
            if (keyMatch?.[1]) {
                try {
                    onMissingAppStateKey(keyMatch[1]);
                } catch {}
            }
        }

        const summary = combined || 'Unknown Baileys diagnostic event';
        diagnostics.lastEventAt = Date.now();
        diagnostics.lastSummary = summary;

        if (typeof onEvent === 'function') {
            try {
                onEvent({ severity, summary, diagnostics: { ...diagnostics } });
            } catch {}
            return;
        }

        if (isRedundantOrBenignBaileysMessage(lower)) {
            return;
        }

        const now = Date.now();
        const dedupeSummary = summary.replace(/keyId=[^,\s]+/g, 'keyId=*');
        const dedupeKey = `${severity}:${dedupeSummary}`;
        const prev = recentMessages.get(dedupeKey) || 0;
        if (now - prev < throttleMs) return;
        recentMessages.set(dedupeKey, now);
        if (recentMessages.size > 100) {
            recentMessages.delete(recentMessages.keys().next().value);
        }

        const fn = severity === 'warn' ? console.warn : console.error;
        fn(`[BAILEYS ${severity.toUpperCase()}] ${summary}`);
    }

    const logger = {
        level,
        trace: noop,
        debug: noop,
        info: noop,
        warn: (...args) => recordAndEmit('warn', args),
        error: (...args) => recordAndEmit('error', args),
        fatal: (...args) => recordAndEmit('fatal', args),
        child() {
            return logger;
        },
        getDiagnostics() {
            return { ...diagnostics };
        },
    };

    return logger;
}


