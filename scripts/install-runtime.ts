import { isAbsolute } from "node:path";
import { installRuntime } from "../src/laya/setup.ts";

const root = process.argv[2];
if (!root || !isAbsolute(root)) throw new Error("An absolute runtime cache path is required");
try {
  await installRuntime(root, AbortSignal.timeout(30 * 60_000), message => process.stdout.write(message + "\n"), process.argv[3] === "--repair");
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
}
