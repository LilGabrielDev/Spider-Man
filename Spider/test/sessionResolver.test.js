import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
    isShortLilSession,
    normalizeSession,
    resolveShortSession,
} from "../../spider/session-resolver.js";

function makeFullLilSession(creds = { registrationId: 12345, noiseKey: { private: "abc", public: "def" } }) {
    const json = JSON.stringify(creds);
    const gz = gzipSync(Buffer.from(json, "utf8"));
    return `LIL~${gz.toString("base64")}`;
}

function makePlainBase64Session(creds = { registrationId: 12345, noiseKey: { private: "abc", public: "def" } }) {
    return Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
}

function withTempEnvSnapshot(fn) {
    const prev = {
        SESSION: process.env.SESSION,
        SESSION_ID: process.env.SESSION_ID,
        SESSION_SERVER_URL: process.env.SESSION_SERVER_URL,
    };
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            for (const [key, val] of Object.entries(prev)) {
                if (val === undefined) delete process.env[key];
                else process.env[key] = val;
            }
        });
}

async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await fn(baseUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("isShortLilSession detects compact LIL~, PANTHER~, and SPIDER~ short IDs and ignores full sessions", () => {
    assert.equal(isShortLilSession("LIL~abc123"), true);
    assert.equal(isShortLilSession('"LIL~abc123_XYZ"'), true);
    assert.equal(isShortLilSession("LIL~gzip/base64 short_id-1"), true);
    assert.equal(isShortLilSession("PANTHER~short99"), true);
    assert.equal(isShortLilSession("SPIDER~short99"), true);

    assert.equal(isShortLilSession(makeFullLilSession()), false);
    assert.equal(isShortLilSession(makePlainBase64Session()), false);
    assert.equal(isShortLilSession(""), false);
    assert.equal(isShortLilSession("not-a-prefixed-session"), false);
});

test("normalizeSession accepts LIL~, PANTHER~, SPIDER~, plain base64, URL-safe base64, quoted strings, and raw JSON", () => {
    const creds = { registrationId: 99, me: { id: "254700000000@s.whatsapp.net" } };
    const expectedB64 = Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
    const lil = makeFullLilSession(creds);
    const panther = lil.replace(/^LIL~/, "PANTHER~");
    const spider = lil.replace(/^LIL~/, "SPIDER~");
    const urlSafe = Buffer.from(gzipSync(Buffer.from(JSON.stringify(creds), "utf8")))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    assert.equal(normalizeSession(lil), expectedB64);
    assert.equal(normalizeSession(`"${lil}"`), expectedB64);
    assert.equal(normalizeSession(panther), expectedB64);
    assert.equal(normalizeSession(spider), expectedB64);
    assert.equal(normalizeSession(`LIL~${urlSafe}`), expectedB64);
    assert.equal(normalizeSession(expectedB64), expectedB64);
    assert.equal(normalizeSession(JSON.stringify(creds)), expectedB64);

    assert.throws(() => normalizeSession("LIL~short123"), /LIL~ session must contain valid gzip\/base64 credentials/);
    assert.throws(() => normalizeSession("invalid"), /SESSION must be base64-encoded credentials/);
});

test("resolveShortSession resolves short SESSION_ID from plain text server response", async () => {
    const full = makeFullLilSession();
    await withTempEnvSnapshot(async () => {
        await withServer((req, res) => {
            if (req.url === "/session/abc123") {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(full);
                return;
            }
            res.writeHead(404);
            res.end("Not found");
        }, async (baseUrl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~abc123";
            process.env.SESSION_SERVER_URL = `${baseUrl}/session/`;

            await resolveShortSession({ loadEnv: false, credsPath: "/nonexistent/creds.json" });
            assert.equal(process.env.SESSION_ID, full);
            assert.ok(normalizeSession(process.env.SESSION_ID));
        });
    });
});

test("resolveShortSession resolves short SESSION when SESSION_ID is also present and handles JSON responses", async () => {
    const creds = { registrationId: 777, noiseKey: { private: "p", public: "q" } };
    const full = makeFullLilSession(creds);
    await withTempEnvSnapshot(async () => {
        await withServer((req, res) => {
            if (req.url === "/session/first99") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ session: full }));
                return;
            }
            if (req.url === "/api/session/second88") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(creds));
                return;
            }
            res.writeHead(404);
            res.end("Not found");
        }, async (baseUrl) => {
            process.env.SESSION = '"LIL~first99"';
            process.env.SESSION_ID = "PANTHER~second88";
            process.env.SESSION_SERVER_URL = baseUrl;

            await resolveShortSession({ loadEnv: false, credsPath: "/nonexistent/creds.json" });
            assert.equal(process.env.SESSION, full);
            assert.equal(process.env.SESSION_ID, makePlainBase64Session(creds));
        });
    });
});

test("resolveShortSession falls back to prefixed lookup key on 404 and skips already-full sessions", async () => {
    const full = makeFullLilSession();
    let requestCount = 0;
    await withTempEnvSnapshot(async () => {
        await withServer((req, res) => {
            requestCount += 1;
            if (req.url === `/session/${encodeURIComponent("LIL~prefixed1")}`) {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(full);
                return;
            }
            res.writeHead(404);
            res.end("Not found");
        }, async (baseUrl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~prefixed1";
            process.env.SESSION_SERVER_URL = baseUrl;

            await resolveShortSession({ loadEnv: false, credsPath: "/nonexistent/creds.json" });
            assert.equal(process.env.SESSION_ID, full);

            const countBeforeSecondCall = requestCount;
            await resolveShortSession({ loadEnv: false, credsPath: "/nonexistent/creds.json" });
            assert.equal(requestCount, countBeforeSecondCall);
        });
    });
});

test("resolveShortSession reuses existing creds.json on restart when short session expired", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spider-session-test-"));
    const credsPath = path.join(tmpDir, "creds.json");
    const creds = { registrationId: 555, me: { id: "254711111111@s.whatsapp.net" } };
    fs.writeFileSync(credsPath, JSON.stringify(creds), "utf8");

    try {
        await withTempEnvSnapshot(async () => {
            await withServer((_req, res) => {
                res.writeHead(404);
                res.end("Expired");
            }, async (baseUrl) => {
                delete process.env.SESSION;
                process.env.SESSION_ID = "LIL~expired123";
                process.env.SESSION_SERVER_URL = baseUrl;

                await resolveShortSession({ loadEnv: false, credsPath });
                assert.equal(
                    process.env.SESSION_ID,
                    Buffer.from(JSON.stringify(creds), "utf8").toString("base64")
                );
            });
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("resolveShortSession throws descriptive error when lookup fails and no creds.json exists", async () => {
    await withTempEnvSnapshot(async () => {
        await withServer((_req, res) => {
            res.writeHead(503);
            res.end("No database configured");
        }, async (baseUrl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~missing123";
            process.env.SESSION_SERVER_URL = baseUrl;

            await assert.rejects(
                () => resolveShortSession({ loadEnv: false, credsPath: "/nonexistent/creds.json" }),
                /Short Spider-Man session lookup failed \(503\)/
            );
        });
    });
});
