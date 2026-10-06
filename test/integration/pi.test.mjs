import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { rpcFixture, packageRoot } from "../rpc.mjs";
import { temporary } from "../helpers.mjs";

test("actual Pi RPC loads retrieval by default, calls it, and preserves built-in tools", { timeout: 60000 }, async t => {
  const f = await rpcFixture(t, { archive: true }); f.behavior.tool = true;
  await f.prompt("Recall OBS_0 from archived records.");
  assert.equal(f.requests.length, 2, f.stderr());
  const names = f.requests[0].tools.map(tool => tool.function.name);
  for (const name of ["read", "bash", "edit", "write", "triage_retrieve"]) assert.ok(names.includes(name), name);
  assert.ok(f.events.some(event => event.type === "tool_execution_end" && event.toolName === "triage_retrieve"));
  const result = (await f.rows()).find(row => row.message?.toolName === "triage_retrieve").message;
  assert.equal(result.details.result.archive_available, true);
  assert.match(result.content[0].text, /exact_value=0/);
  assert.ok(JSON.stringify(f.requests[0].messages).includes("exact_value=0"));
  assert.equal(f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens, 32768);
});

test("actual Pi native compactor receives Laya failure instead of cancellation", { timeout: 60000 }, async t => {
  const f = await rpcFixture(t, { ambiguous: true });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.requests.length, 1);
  const rows = await f.rows();
  assert.ok(rows.some(row => row.type === "compaction" && !row.details?.triage));
  assert.ok(rows.some(row => row.customType === "knowledge_triage_fallback" && /worker|ENOENT/.test(row.data.reason)));
});

for (const failure of ["corrupt", "oversized"]) test(`actual Pi blocks provider requests when archived context is ${failure}`, { timeout: 60000 }, async t => {
  const f = await rpcFixture(t, { archive: true, [failure]: true });
  await f.prompt("Recall OBS_0.");
  assert.equal(f.requests.length, 0, f.stderr());
  assert.ok((await f.rows()).some(row => row.customType === "knowledge_triage_error" && row.data.stage === "context"));
});

test("npm tarball installs through Pi package discovery and exposes retrieval", { timeout: 60000 }, async t => {
  const root = await temporary(t), installed = join(root, "installed"); await mkdir(installed);
  const { stdout } = await promisify(execFile)("npm", ["pack", "--json", "--pack-destination", root], { cwd: packageRoot });
  const packed = JSON.parse(stdout), manifest = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const paths = manifest.files.map(file => file.path);
  assert.ok(paths.includes("src/extension.ts")); assert.ok(paths.includes("scripts/laya-classify.py"));
  assert.ok(paths.every(path => !/node_modules|\.safetensors$|\.venv|\.audit|(^|\/)test\//.test(path)));
  await promisify(execFile)("npm", ["install", "--prefix", installed, "--cache", join(root, "npm-cache"), "--ignore-scripts", "--omit=dev",
    "--legacy-peer-deps", "--no-audit", "--no-fund", "--offline", "--package-lock=false", join(root, manifest.filename)],
    { cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  const f = await rpcFixture(t, { archive: true, extension: join(installed, "node_modules/pi-knowledge-triage-compactor"), install: true });
  await f.prompt("Recall OBS_0.");
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === "triage_retrieve"));
  const commands = await f.send({ type: "get_commands" });
  assert.ok(commands.data.commands.some(command => command.name === "triage"));
});
