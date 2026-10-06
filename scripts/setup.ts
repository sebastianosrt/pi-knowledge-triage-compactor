import { LayaRuntime } from "../src/laya/runtime.ts";
const runtime = new LayaRuntime();
runtime.setProgress(message => process.stderr.write(message + "\n"));
const stop = () => runtime.shutdown();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try { await runtime.setup(); process.stdout.write(JSON.stringify(await runtime.status(), null, 2) + "\n"); }
catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
finally { runtime.shutdown(); }
