import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import {
    SESSION_FINGERPRINT_FILE,
    SESSION_META_FILE,
    SESSION_SERVER_URL,
    deriveSessionFolderName,
    hasMatchingSessionFingerprint,
    hydrateSessionToFolder,
    isShortLilSession,
    normalizeSession,
    parseSessionPayload,
    resolveSessionFolder,
    resolveShortSession,
} from "../../spider/session-resolver.js";

const require = createRequire(import.meta.url);

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

test("index.js supervisor + worker binds PORT before plugin loading and never blocks on short LIL~ lookup", async () => {
    const port = await getFreePort();
    const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "spider-supervisor-boot-"));
    const child = spawn(process.execPath, ["index.js"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(port),
            AUTH_DIR: tmpAuthDir,
            SESSION: "",
            SESSION_ID: "LIL~renderbootcheck1",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    try {
        let ready = false;
        let lastErr = null;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`Supervisor exited prematurely with code ${child.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            }
            try {
                const res = await fetch(`http://127.0.0.1:${port}/`);
                if (res.status === 200) {
                    const body = await res.text();
                    assert.match(body, /Running/);
                    ready = true;
                    break;
                }
            } catch (err) {
                lastErr = err;
            }
            await new Promise((r) => setTimeout(r, 50));
        }

        assert.equal(ready, true, `Supervisor did not expose HTTP PORT ${port} in time: ${lastErr?.message || ""}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
        assert.doesNotMatch(stderr, /unsettled top-level await/i);

        // Wait briefly for startup logs if plugin loading is still finishing
        const logDeadline = Date.now() + 5_000;
        while (Date.now() < logDeadline && !stdout.includes("[LEGACY] Registered")) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const httpIdx = stdout.indexOf(`HTTP server listening on 0.0.0.0:${port}`);
        const legacyIdx = stdout.indexOf("[LEGACY] Registered");
        assert.ok(httpIdx !== -1, `Expected HTTP listening log in stdout:\n${stdout}`);
        if (legacyIdx !== -1) {
            assert.ok(httpIdx < legacyIdx, `Expected HTTP server to listen before plugin registration.\nSTDOUT:\n${stdout}`);
        }

        const exitPromise = new Promise((resolve) => child.once("exit", (code, sig) => resolve({ code, sig })));
        child.kill("SIGTERM");
        const exited = await exitPromise;
        assert.equal(exited.code, 0, `Expected clean exit 0 on SIGTERM, got ${JSON.stringify(exited)}\nSTDERR:\n${stderr}`);
    } finally {
        if (child.exitCode === null) {
            child.kill("SIGKILL");
        }
        fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    }
});

test("top-level await resolveShortSession completes retries without Node exit code 13", async () => {
    let attempts = 0;
    await withServer((_req, res) => {
        attempts += 1;
        res.writeHead(503);
        res.end("Service Unavailable");
    }, async (baseUrl) => {
        const script = `
            import { resolveShortSession } from "./spider/session-resolver.js";
            process.env.SESSION = "";
            process.env.SESSION_ID = "LIL~topawait503";
            const localBase = ${JSON.stringify(baseUrl)};
            const fetchImpl = (url, init) => {
                const target = String(url).replace("https://lilgabriel-session.onrender.com", localBase);
                return globalThis.fetch(target, init);
            };
            await resolveShortSession({
                loadEnv: false,
                credsPath: "/nonexistent/creds.json",
                fetchImpl,
                retries: 2,
                retryDelayMs: 40,
                timeoutMs: 2000,
            });
        `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

        const exited = await new Promise((resolve) => {
            child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        assert.notEqual(exited.code, 13, `Node exited with status 13 (unsettled top-level await):\n${stderr}`);
        assert.equal(exited.code, 1, `Expected normal rejection exit code 1, got ${JSON.stringify(exited)}\n${stderr}`);
        assert.doesNotMatch(stderr, /unsettled top-level await/i);
        assert.match(stderr, /Short Spider-Man session lookup failed \(503\)/);
        assert.ok(attempts >= 3, `Expected retries to execute cleanly, saw ${attempts} attempts`);
    });
});

test("resolveSessionFolder maps distinct sessions to isolated folders under sessions/ and respects overrides", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spider-folder-route-"));
    try {
        const shortA = resolveSessionFolder({
            cwd: tmpRoot,
            env: { SESSION_ID: "LIL~alpha01" },
        });
        const shortB = resolveSessionFolder({
            cwd: tmpRoot,
            env: { SESSION_ID: "SPIDER~beta02" },
        });
        const fullCreds = makeFullLilSession({ registrationId: 9001, me: { id: "254700000001@s.whatsapp.net" } });
        const fullFolder = resolveSessionFolder({
            cwd: tmpRoot,
            env: { SESSION: fullCreds },
        });
        const preservedFolder = resolveSessionFolder({
            cwd: tmpRoot,
            env: {
                SESSION_ID: fullCreds,
                SPIDER_SESSION_FOLDER_KEY: "LIL~alpha01",
            },
        });
        const explicitAuth = resolveSessionFolder({
            cwd: tmpRoot,
            env: {
                AUTH_DIR: path.join(tmpRoot, "custom-auth"),
                SESSION_ID: "LIL~alpha01",
            },
        });

        assert.equal(shortA, path.join(tmpRoot, "sessions", "LIL_alpha01"));
        assert.equal(shortB, path.join(tmpRoot, "sessions", "SPIDER_beta02"));
        assert.equal(fullFolder, path.join(tmpRoot, "sessions", deriveSessionFolderName(fullCreds)));
        assert.notEqual(shortA, fullFolder);
        assert.equal(preservedFolder, shortA);
        assert.equal(explicitAuth, path.join(tmpRoot, "custom-auth"));
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("parseSessionPayload & hydrateSessionToFolder extract multi-file session bundles and sanitize unsafe paths", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spider-bundle-hydrate-"));
    const targetDir = path.join(tmpRoot, "sessions", "LIL_bundle01");
    try {
        const creds = {
            registrationId: 4242,
            noiseKey: { private: "priv1", public: "pub1" },
            nextPreKeyId: 35,
            registered: true,
            me: { id: "254722222222@s.whatsapp.net" },
        };
        const bundlePayload = {
            files: {
                "creds.json": creds,
                "app-state-sync-key-AAAA1.json": { keyData: "sync1" },
                "session-254733333333.0.json": { currentSession: { indexInfo: { baseKey: "bk" } } },
                "../outside-escape.json": { malicious: true },
                "nested/bad.json": { malicious: true },
            },
        };
        const encodedBundle = `LIL~${gzipSync(Buffer.from(JSON.stringify(bundlePayload), "utf8")).toString("base64")}`;

        const parsed = parseSessionPayload(encodedBundle);
        assert.equal(parsed.kind, "folder");
        assert.ok(parsed.files["creds.json"]);
        assert.ok(parsed.files["app-state-sync-key-AAAA1.json"]);
        assert.ok(parsed.files["session-254733333333.0.json"]);
        assert.equal(parsed.files["../outside-escape.json"], undefined);

        const ok = hydrateSessionToFolder(encodedBundle, targetDir, {
            rawSessionInput: "LIL~bundle01",
        });
        assert.equal(ok, true);
        assert.equal(fs.existsSync(path.join(targetDir, "creds.json")), true);
        assert.equal(fs.existsSync(path.join(targetDir, "app-state-sync-key-AAAA1.json")), true);
        assert.equal(fs.existsSync(path.join(targetDir, "session-254733333333.0.json")), true);
        assert.equal(fs.existsSync(path.join(targetDir, SESSION_FINGERPRINT_FILE)), true);
        assert.equal(fs.existsSync(path.join(targetDir, SESSION_META_FILE)), true);
        assert.equal(fs.existsSync(path.join(tmpRoot, "sessions", "outside-escape.json")), false);

        const writtenCreds = JSON.parse(fs.readFileSync(path.join(targetDir, "creds.json"), "utf8"));
        assert.equal(writtenCreds.registrationId, 4242);
        assert.equal(writtenCreds.firstUnuploadedPreKeyId, 35);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("resolveShortSession hydrates nested {creds, keys} server bundle into sessions/<folder> and enforces fingerprint mismatch guard", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spider-short-bundle-"));
    try {
        const serverBundle = {
            creds: {
                registrationId: 8181,
                noiseKey: { private: "privB", public: "pubB" },
                me: { id: "254744444444@s.whatsapp.net" },
            },
            keys: {
                "app-state-sync-key": {
                    key99: { keyData: "sync99" },
                },
                "pre-key": {
                    1: { private: "p1", public: "u1" },
                },
            },
        };

        await withTempEnvSnapshot(async () => {
            await withServer((req, res) => {
                if (req.url === "/session/bundle99") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(serverBundle));
                    return;
                }
                res.writeHead(404);
                res.end("Not found");
            }, async (_baseUrl, fetchImpl) => {
                delete process.env.SESSION;
                process.env.SESSION_ID = "LIL~bundle99";

                await resolveShortSession({
                    cwd: tmpRoot,
                    loadEnv: false,
                    fetchImpl,
                });

                const expectedDir = path.join(tmpRoot, "sessions", "LIL_bundle99");
                assert.equal(fs.existsSync(path.join(expectedDir, "creds.json")), true);
                assert.equal(fs.existsSync(path.join(expectedDir, "app-state-sync-key-key99.json")), true);
                assert.equal(fs.existsSync(path.join(expectedDir, "pre-key-1.json")), true);
                assert.equal(hasMatchingSessionFingerprint(expectedDir, "LIL~bundle99"), true);
                assert.equal(hasMatchingSessionFingerprint(expectedDir, "LIL~different00"), false);

                // Switching SESSION_ID inside the same folder must refuse stale creds reuse on 404
                process.env.SESSION_ID = "LIL~different00";
                await assert.rejects(
                    () => resolveShortSession({
                        authDir: expectedDir,
                        loadEnv: false,
                        fetchImpl,
                    }),
                    /Short Spider-Man session lookup failed \(404\)/
                );

                // Switching to another full session replaces old account files cleanly
                const nextFull = makeFullLilSession({
                    registrationId: 9292,
                    noiseKey: { private: "privC", public: "pubC" },
                    me: { id: "254755555555@s.whatsapp.net" },
                });
                const hydratedNew = hydrateSessionToFolder(nextFull, expectedDir, {
                    rawSessionInput: "LIL~newaccount",
                    replaceOnMismatch: true,
                });
                assert.equal(hydratedNew, true);
                assert.equal(fs.existsSync(path.join(expectedDir, "app-state-sync-key-key99.json")), false);
                assert.equal(fs.existsSync(path.join(expectedDir, "pre-key-1.json")), false);
                const updatedCreds = JSON.parse(fs.readFileSync(path.join(expectedDir, "creds.json"), "utf8"));
                assert.equal(updatedCreds.registrationId, 9292);
            });
        });
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test("legacy Spider/legacy/lil/utils/session.js resolveSession hydrates per-session folder and multi-file bundles", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spider-legacy-session-"));
    try {
        const { resolveSession } = require("../legacy/lil/utils/session.js");
        const creds = { registrationId: 3131, noiseKey: { private: "lp", public: "lu" } };
        const bundle = `SPIDER~${gzipSync(Buffer.from(JSON.stringify({
            files: {
                "creds.json": creds,
                "session-legacy.0.json": { ok: true },
            },
        }), "utf8")).toString("base64")}`;

        const res = await resolveSession({
            cwd: tmpRoot,
            env: { SESSION_ID: bundle },
        });
        assert.equal(res.hydrated, true);
        assert.ok(res.sessionDir.startsWith(path.join(tmpRoot, "sessions", "session_")));
        assert.equal(fs.existsSync(path.join(res.sessionDir, "creds.json")), true);
        assert.equal(fs.existsSync(path.join(res.sessionDir, "session-legacy.0.json")), true);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});


