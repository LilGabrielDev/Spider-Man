import { resolveShortSession } from "./spider/session-resolver.js";

try {
    await resolveShortSession();
} catch (error) {
    console.error(`❌ Short session lookup failed: ${error.message}`);
    process.exitCode = 1;
    throw error;
}

await import("./spider/index.js");
