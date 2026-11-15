import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
    SESSION_SERVER_URL,
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

function createRedirectingFetch(localBaseUrl) {
    const expectedOrigin = "https://lilgabriel-session.onrender.com";
    return async (url, init) => {
        const rawUrl = String(url);
        assert.ok(
            rawUrl.startsWith(`${expectedOrigin}/`),
            `Expected request to ${expectedOrigin}, got ${rawUrl}`
        );
        const rewritten = `${localBaseUrl}${rawUrl.slice(expectedOrigin.length)}`;
        return globalThis.fetch(rewritten, init);
    };
}

async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await fn(baseUrl, createRedirectingFetch(baseUrl));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("SESSION_SERVER_URL constant is fixed to https://lilgabriel-session.onrender.com/", () => {
    assert.equal(SESSION_SERVER_URL, "https://lilgabriel-session.onrender.com/");
});

test("isShortLilSession detects compact LIL~ and SPIDER~ short IDs and ignores full sessions", () => {
    assert.equal(isShortLilSession("LIL~abc123"), true);
    assert.equal(isShortLilSession('"LIL~abc123_XYZ"'), true);
    assert.equal(isShortLilSession("LIL~gzip/base64 short_id-1"), true);
    assert.equal(isShortLilSession("SPIDER~short99"), true);

    assert.equal(isShortLilSession(makeFullLilSession()), false);
    assert.equal(isShortLilSession(makePlainBase64Session()), false);
    assert.equal(isShortLilSession(""), false);
    assert.equal(isShortLilSession("not-a-prefixed-session"), false);
});

test("normalizeSession accepts LIL~, SPIDER~, plain base64, URL-safe base64, quoted strings, and raw JSON", () => {
    const creds = { registrationId: 99, me: { id: "254700000000@s.whatsapp.net" } };
    const expectedB64 = Buffer.from(JSON.stringify(creds), "utf8").toString("base64");
    const lil = makeFullLilSession(creds);
    const spider = lil.replace(/^LIL~/, "SPIDER~");
    const urlSafe = Buffer.from(gzipSync(Buffer.from(JSON.stringify(creds), "utf8")))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    assert.equal(normalizeSession(lil), expectedB64);
    assert.equal(normalizeSession(`"${lil}"`), expectedB64);
    assert.equal(normalizeSession(spider), expectedB64);
    assert.equal(normalizeSession(`LIL~${urlSafe}`), expectedB64);
    assert.equal(normalizeSession(expectedB64), expectedB64);
    assert.equal(normalizeSession(JSON.stringify(creds)), expectedB64);

    assert.throws(() => normalizeSession("LIL~short123"), /LIL~ session must contain valid gzip\/base64 credentials/);
    assert.throws(() => normalizeSession("invalid"), /SESSION must be base64-encoded credentials/);
});

test("resolveShortSession resolves short SESSION_ID from plain text server response and ignores SESSION_SERVER_URL env", async () => {
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
        }, async (_baseUrl, fetchImpl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~abc123";
            process.env.SESSION_SERVER_URL = "https://should-be-ignored.example.com";

            await resolveShortSession({
                loadEnv: false,
                credsPath: "/nonexistent/creds.json",
                fetchImpl,
            });
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
        }, async (_baseUrl, fetchImpl) => {
            process.env.SESSION = '"LIL~first99"';
            process.env.SESSION_ID = "SPIDER~second88";

            await resolveShortSession({
                loadEnv: false,
                credsPath: "/nonexistent/creds.json",
                fetchImpl,
            });
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
        }, async (_baseUrl, fetchImpl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~prefixed1";

            await resolveShortSession({
                loadEnv: false,
                credsPath: "/nonexistent/creds.json",
                fetchImpl,
            });
            assert.equal(process.env.SESSION_ID, full);

            const countBeforeSecondCall = requestCount;
            await resolveShortSession({
                loadEnv: false,
                credsPath: "/nonexistent/creds.json",
                fetchImpl,
            });
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
            }, async (_baseUrl, fetchImpl) => {
                delete process.env.SESSION;
                process.env.SESSION_ID = "LIL~expired123";

                await resolveShortSession({ loadEnv: false, credsPath, fetchImpl });
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
        }, async (_baseUrl, fetchImpl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~missing123";

            await assert.rejects(
                () => resolveShortSession({
                    loadEnv: false,
                    credsPath: "/nonexistent/creds.json",
                    fetchImpl,
                    retryDelayMs: 5,
                }),
                /Short Spider-Man session lookup failed \(503\)/
            );
        });
    });
});

test("resolveShortSession retries transient 503 responses and recovers when server comes up", async () => {
    const full = makeFullLilSession();
    let attempts = 0;
    await withTempEnvSnapshot(async () => {
        await withServer((req, res) => {
            if (req.url === "/session/transient42") {
                attempts += 1;
                if (attempts <= 2) {
                    res.writeHead(503);
                    res.end("Cold starting");
                    return;
                }
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(full);
                return;
            }
            res.writeHead(404);
            res.end("Not found");
        }, async (_baseUrl, fetchImpl) => {
            delete process.env.SESSION;
            process.env.SESSION_ID = "LIL~transient42";

            await resolveShortSession({
                loadEnv: false,
                credsPath: "/nonexistent/creds.json",
                fetchImpl,
                retries: 2,
                retryDelayMs: 5,
            });
            assert.equal(attempts, 3);
            assert.equal(process.env.SESSION_ID, full);
        });
    });
});

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = addr && typeof addr === "object" ? addr.port : 0;
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

test("spider/index.js binds HTTP PORT immediately and stays alive in standby mode without session crash", async () => {
    const port = await getFreePort();
    const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "spider-standby-auth-"));
    const child = spawn(process.execPath, ["spider/index.js"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(port),
            AUTH_DIR: tmpAuthDir,
            SESSION: "",
            SESSION_ID: "invalid-standby-session",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    try {
        let ready = false;
        let lastErr = null;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`Worker exited prematurely with code ${child.exitCode}`);
            }
            try {
                const res = await fetch(`http://127.0.0.1:${port}/`);
                if (res.status === 200) {
                    const body = await res.text();
                    assert.match(body, /Running/);
                    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
                    assert.equal(healthRes.status, 503);
                    const healthJson = await healthRes.json();
                    assert.equal(healthJson.whatsapp, "disconnected");
                    ready = true;
                    break;
                }
            } catch (err) {
                lastErr = err;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(ready, true, `HTTP server did not bind PORT ${port} in time: ${lastErr?.message || ""}`);

        const exitPromise = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, sig })));
        child.kill("SIGTERM");
        const exited = await exitPromise;
        assert.equal(exited.code, 0);
    } finally {
        if (child.exitCode === null) {
            child.kill("SIGKILL");
        }
        fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    }
});

