import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CREDS_PATH = path.join(__dirname, "auth", "creds.json");
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
                const nested =
                    parsed.session ??
                    parsed.sessionId ??
                    parsed.session_id ??
                    parsed.data ??
                    parsed.result ??
                    parsed.value ??
                    parsed.creds;
                if (typeof nested === "string") {
                    candidate = nested.trim();
                } else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
                    candidate = JSON.stringify(nested);
                } else if (
                    parsed.noiseKey ||
                    parsed.signedIdentityKey ||
                    parsed.registrationId !== undefined ||
                    parsed.me
                ) {
                    candidate = JSON.stringify(parsed);
                } else {
                    return null;
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

async function fetchShortSessionFromServers(cleanedInput, payload, fetchImpl) {
    const baseUrls = SESSION_SERVER_URLS;
    const lookupIds = cleanedInput !== payload ? [payload, cleanedInput] : [payload];
    let lastError = null;

    for (const baseUrl of baseUrls) {
        for (const lookupId of lookupIds) {
            const paths = [
                `${baseUrl}/session/${encodeURIComponent(lookupId)}`,
                `${baseUrl}/api/session/${encodeURIComponent(lookupId)}`,
            ];

            for (const url of paths) {
                try {
                    const response = await fetchImpl(url, {
                        headers: { accept: "text/plain, application/json;q=0.9, */*;q=0.8" },
                        signal: AbortSignal.timeout(15_000),
                    });

                    if (!response.ok) {
                        lastError = new Error(
                            `Short Spider-Man session lookup failed (${response.status}) at ${baseUrl}`
                        );
                        if (response.status === 404) {
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
                    const detail = error?.cause?.code || error?.cause?.message || error?.message || String(error);
                    lastError = new Error(`Short Spider-Man session lookup failed (${detail}) at ${baseUrl}`);
                    break;
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
        credsPath = DEFAULT_CREDS_PATH,
        loadEnv = true,
        fetchImpl = globalThis.fetch,
    } = options;

    if (loadEnv) {
        dotenv.config({ path: ".env" });
    }

    for (const variable of SESSION_ENV_VARS) {
        const rawValue = process.env[variable];
        if (!rawValue || !rawValue.trim()) continue;

        const cleaned = stripWrappingQuotes(rawValue);
        if (!isShortLilSession(cleaned)) continue;

        const payload = cleaned.replace(SESSION_PREFIX_RE, "").replace(/\s+/g, "");
        try {
            const fullSession = await fetchShortSessionFromServers(cleaned, payload, fetchImpl);
            process.env[variable] = fullSession;
        } catch (error) {
            const existingCreds = readExistingCredsBase64(credsPath);
            if (existingCreds) {
                console.warn(
                    `⚠️ ${error.message}; reusing existing credentials from ${credsPath}.`
                );
                process.env[variable] = existingCreds;
                continue;
            }
            throw error;
        }
    }
}
