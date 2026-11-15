import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveShortSession } from "./spider/session-resolver.js";
import { RESTART_EXIT_CODE } from "./spider/utils/runtimeControl.js";
import {
    clearTemporarySessionsAndCache,
    getWorkerMemoryExecArgv,
} from "./spider/utils/resourceGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "spider", "index.js");

clearTemporarySessionsAndCache({ cwd: __dirname, maxAgeMs: 60 * 1000, tempMaxAgeMs: 60 * 1000, preserveSignalKeys: true });

try {
    await resolveShortSession();
} catch (error) {
    console.error(`❌ Short session lookup failed: ${error.message}`);
    process.exitCode = 1;
    throw error;
}

let activeChild = null;
let restartTimer = null;
let shuttingDown = false;
let workerRestartAttempts = 0;
let workerStartedAt = 0;

function scheduleWorkerRestart(reason) {
    if (shuttingDown || restartTimer) return;
    workerRestartAttempts += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(workerRestartAttempts - 1, 5));
    console.warn(`⚠️ [SUPERVISOR] Worker stopped (${reason}); restarting in ${delayMs} ms...`);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!shuttingDown) startWorker();
    }, delayMs);
}

function forwardSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }

    if (activeChild && !activeChild.killed) {
        try {
            activeChild.kill(signal);
        } catch {}
        const forceTimer = setTimeout(() => {
            try {
                activeChild?.kill("SIGKILL");
            } catch {}
            process.exit(0);
        }, 5000);
        forceTimer.unref();
    } else {
        process.exit(0);
    }
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

function startWorker() {
    let restartRequested = false;

    const child = spawn(process.execPath, [WORKER_SCRIPT], {
        cwd: __dirname,
        execArgv: getWorkerMemoryExecArgv(),
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: {
            ...process.env,
            SPIDER_SUPERVISED: "1",
        },
    });

    activeChild = child;
    workerStartedAt = Date.now();

    child.on("error", (error) => {
        console.error(`❌ [SUPERVISOR] Worker process error: ${error.message}`);
    });

    child.on("message", (msg) => {
        if (msg && typeof msg === "object" && msg.type === "spider:restart") {
            restartRequested = true;
        }
    });

    child.on("exit", async (code, signal) => {
        if (activeChild === child) {
            activeChild = null;
        }
        child.removeAllListeners();

        if (shuttingDown) {
            process.exit(typeof code === "number" ? code : 0);
            return;
        }

        if (restartRequested || code === RESTART_EXIT_CODE) {
            workerRestartAttempts = 0;
            console.log("🔄 [SUPERVISOR] Reloading Spider Man bot worker without stopping panel process...");
            clearTemporarySessionsAndCache({ cwd: __dirname, preserveSignalKeys: true });
            try {
                await resolveShortSession();
            } catch (error) {
                console.warn(`⚠️ Short session refresh warning during reload: ${error.message}`);
            }
            restartTimer = setTimeout(() => {
                restartTimer = null;
                if (!shuttingDown) startWorker();
            }, 500);
            return;
        }

        if (Date.now() - workerStartedAt >= 30_000) {
            workerRestartAttempts = 0;
        }

        const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        scheduleWorkerRestart(reason);
    });
}

startWorker();
