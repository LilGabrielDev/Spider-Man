import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveShortSession } from "./spider/session-resolver.js";
import { RESTART_EXIT_CODE } from "./spider/utils/runtimeControl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, "spider", "index.js");

try {
    await resolveShortSession();
} catch (error) {
    console.error(`❌ Short session lookup failed: ${error.message}`);
    process.exitCode = 1;
    throw error;
}

let activeChild = null;
let shuttingDown = false;

function forwardSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

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
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        env: {
            ...process.env,
            SPIDER_SUPERVISED: "1",
        },
    });

    activeChild = child;

    child.on("message", (msg) => {
        if (msg && typeof msg === "object" && msg.type === "spider:restart") {
            restartRequested = true;
        }
    });

    child.on("exit", async (code, signal) => {
        if (activeChild === child) {
            activeChild = null;
        }

        if (shuttingDown) {
            process.exit(typeof code === "number" ? code : 0);
            return;
        }

        if (restartRequested || code === RESTART_EXIT_CODE) {
            console.log("🔄 [SUPERVISOR] Reloading Spider Man bot worker without stopping panel process...");
            try {
                await resolveShortSession();
            } catch (error) {
                console.warn(`⚠️ Short session refresh warning during reload: ${error.message}`);
            }
            setTimeout(() => {
                if (!shuttingDown) startWorker();
            }, 500);
            return;
        }

        if (signal) {
            process.exit(1);
            return;
        }

        process.exit(typeof code === "number" ? code : 0);
    });
}

startWorker();
