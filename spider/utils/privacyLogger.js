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
        const local = str.slice(0, atIdx).split(':')[0];
        const domain = str.slice(atIdx);
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

    // Redact WhatsApp JIDs / LIDs / newsletter / broadcast identifiers
    text = text.replace(
        /[A-Za-z0-9+._:-]+@(?:s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)/gi,
        (match) => redactPhoneOrJid(match)
    );

    // Redact standalone phone numbers (7+ digits, optional + / spaces / hyphens)
    text = text.replace(/\+?\d[\d\s-]{5,}\d/g, (match) => {
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
