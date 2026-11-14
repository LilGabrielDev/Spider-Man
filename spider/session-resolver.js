const DEFAULT_SESSION_SERVER_URL = "https://session.Lilgabriel.co.ke";

function getSessionInput() {
    if (process.env.SESSION_ID?.trim()) {
        return { variable: "SESSION_ID", value: process.env.SESSION_ID.trim() };
    }
    if (process.env.SESSION?.trim()) {
        return { variable: "SESSION", value: process.env.SESSION.trim() };
    }
    return null;
}

function isShortLilSession(value) {
    const payload = value.replace(/^LIL~(?:\s*gzip\/base64)?\s*/i, "").replace(/\s+/g, "");
    return /^LIL~/i.test(value) && payload.length > 0 && payload.length < 50 && /^[A-Za-z0-9_-]+$/.test(payload);
}

export async function resolveShortSession() {
    const input = getSessionInput();
    if (!input || !isShortLilSession(input.value)) return;

    const baseUrl = (process.env.SESSION_SERVER_URL || DEFAULT_SESSION_SERVER_URL).replace(/\/+$/, "");
    const payload = input.value.replace(/^LIL~(?:\s*gzip\/base64)?\s*/i, "").replace(/\s+/g, "");
    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(payload)}`, {
        headers: { accept: "text/plain" },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        throw new Error(`Short Spider-Man session lookup failed (${response.status})`);
    }

    const fullSession = (await response.text()).trim();
    if (!/^LIL~/i.test(fullSession) || fullSession.length < 50) {
        throw new Error("Short Spider-Man session lookup returned an invalid session");
    }

    process.env[input.variable] = fullSession;
}
