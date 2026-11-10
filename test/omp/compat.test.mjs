import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setupFixture } from "../setup-fixture.mjs";
import { installedRuntime, cacheHome } from "../../src/laya/setup.ts";
import { temporary } from "../helpers.mjs";
import { rpcFixture, packageRoot } from "../rpc.mjs";

const fixture = (t, options = {}) => rpcFixture(t, { host: "omp", ...options });

test("OMP loads commands and retrieves archives across a tool continuation", { timeout: 60000 }, async t => {
  const f = await fixture(t, { archive: true });
  const commands = await f.send({ type: "get_available_commands" });
  assert.ok(commands.data.commands.some(c => c.name === "triage"), JSON.stringify(commands));
  f.behavior.tool = true;
  await f.prompt("Recall OBS_0 from archived records.");
  assert.equal(f.requests.length, 2, f.stderr() + JSON.stringify(f.events.slice(-8)));
  assert.ok(f.requests[0].tools.some(t => t.function.name === "triage_retrieve"));
  assert.ok(JSON.stringify(f.requests[0].messages).includes("exact_value=0"));
  assert.deepEqual(f.requests[1].messages.slice(0, f.requests[0].messages.length), f.requests[0].messages);
  const rows = await f.rows();
  assert.equal(rows.filter(r => r.customType === "knowledge_triage_injection").length, 1);
  const result = rows.find(r => r.message?.toolName === "triage_retrieve").message;
  assert.equal(result.isError, false);
  assert.equal(result.details.result.archive_available, true);
});

test("OMP compacts locally and retrieves on the next turn", { timeout: 60000 }, async t => {
  const f = await fixture(t, { compaction: { reserveTokens: undefined } });
  const compact = await f.send({ type: "compact" });
  assert.equal(compact.success, true, JSON.stringify(compact) + f.stderr());
  assert.equal(f.requests.length, 0);
  assert.ok((await f.rows()).some(r => r.type === "compaction" && r.details?.triage));
  await f.prompt("Recall OLD_FACT.");
  assert.equal(f.requests.length, 1, JSON.stringify(f.events.slice(-5)));
  assert.ok(JSON.stringify(f.requests[0].messages).includes("OLD_FACT=alpha"));
});

test("OMP native fallback records the archive coverage gap", { timeout: 60000 }, async t => {
  const f = await fixture(t, { ambiguous: true });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(f.requests.length > 0); // OMP may request a separate short summary.
  assert.ok((await f.rows()).some(r => r.customType === "knowledge_triage_fallback"));
});

test("OMP corruption aborts before a provider request", { timeout: 60000 }, async t => {
  const f = await fixture(t, { archive: true, corrupt: true });
  await f.prompt("Recall OBS_0.");
  assert.equal(f.requests.length, 0);
  assert.ok((await f.rows()).some(r => r.customType === "knowledge_triage_error"));
});

for (const options of [{ contextWindow: 34000 }, { oversized: true }]) {
  test(`OMP defers automatic retrieval without blocking explicit retrieval: ${JSON.stringify(options)}`, { timeout: 60000 }, async t => {
    const f = await fixture(t, { archive: true, ...options }); f.behavior.tool = true;
    await f.prompt("Recall OBS_0.");
    assert.equal(f.requests.length, 2, JSON.stringify(f.events.slice(-5)));
    const rows = await f.rows();
    assert.ok(rows.some(r => r.customType === "knowledge_triage_retrieval" && r.data.deferred));
    assert.ok(!rows.some(r => r.customType === "knowledge_triage_error"));
  });
}


test("OMP setup runs in the background through Node, then compacts locally", { timeout: 60000 }, async t => {
  const home = await setupFixture(t);
  await writeFile(join(home, "pause"), "");
  const f = await fixture(t, { ambiguous: true, env: {
    PI_TRIAGE_HOME: home, PI_TRIAGE_PYTHON: undefined, PI_TRIAGE_MODEL_DIR: undefined,
  } });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok((await f.rows()).some(r => r.customType === "knowledge_triage_fallback" && /background/.test(r.data.reason)));
  for (let i = 0; i < 100; i++) {
    try { await readFile(join(home, "child-pid")); break; } catch { await delay(20); }
  }
  assert.ok(await readFile(join(home, "child-pid")), "Compiled OMP launched the Node installer");
  // Stop this first paused setup through a real session transition, then explicitly retry.
  const switched = await f.send({ type: "new_session" });
  assert.equal(switched.success, true, JSON.stringify(switched));
  await rm(join(home, "pause"));
  const start = await f.send({ type: "prompt", message: "/triage setup" });
  assert.equal(start.success, true, JSON.stringify(start));
  for (let i = 0; i < 300 && !await installedRuntime(home); i++) await delay(20);
  assert.ok(await installedRuntime(home));
  const resumed = await f.send({ type: "switch_session", sessionPath: f.manager.getSessionFile() });
  assert.equal(resumed.success, true, JSON.stringify(resumed));
  await f.prompt("Keep the audit trail intact. " + "Additional ordinary facts. ".repeat(150));
  await f.prompt("Continue with the next batch. " + "More ordinary facts. ".repeat(150));
  const before = f.requests.length;
  const compact = await f.send({ type: "compact" });
  assert.equal(compact.success, true, JSON.stringify(compact));
  assert.equal(f.requests.length, before);
  assert.ok((await f.rows()).some(r => r.type === "compaction" && r.details?.triage));
});

test("OMP resume and forks preserve injections and materialize archives", { timeout: 60000 }, async t => {
  const f = await fixture(t, { archive: true });
  await f.prompt("Recall OBS_0.");
  const prefix = f.requests[0].messages;
  const switched = await f.send({ type: "new_session" });
  assert.equal(switched.success, true, JSON.stringify(switched));
  const resumed = await f.send({ type: "switch_session", sessionPath: f.manager.getSessionFile() });
  assert.equal(resumed.success, true, JSON.stringify(resumed));
  await f.prompt("Recall OBS_0.");
  assert.deepEqual(f.requests.at(-1).messages.slice(0, prefix.length), prefix);
  const fork = await f.send({ type: "fork" });
  assert.equal(fork.success, true, JSON.stringify(fork));
  const state = await f.send({ type: "get_state" });
  assert.notEqual(state.data.sessionFile, f.manager.getSessionFile());
  await f.prompt("Recall OBS_0.");
  assert.ok(JSON.stringify(f.requests.at(-1).messages).includes("exact_value=0"));
  const rows = (await readFile(state.data.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].type, "title");
  assert.ok(!rows.some(r => r.customType === "knowledge_triage_error"), JSON.stringify(rows.filter(r => r.customType === "knowledge_triage_error")));
  const ref = rows.findLast(r => r.type === "compaction").details.triage;
  assert.ok(await readFile(join(dirname(state.data.sessionFile), "triage", state.data.sessionId, ref.file)));
});

test("OMP packed package discovery works without installed Pi dependencies", { timeout: 60000 }, async t => {
  const root = await temporary(t), unpacked = join(root, "unpacked"); await mkdir(unpacked);
  const { stdout } = await promisify(execFile)("npm", ["pack", "--json", "--pack-destination", root], { cwd: packageRoot });
  const packed = JSON.parse(stdout)[0];
  await promisify(execFile)("tar", ["-xzf", join(root, packed.filename), "-C", unpacked]);
  const f = await fixture(t, { archive: true, extension: join(unpacked, "package"), install: true });
  f.behavior.tool = true;
  await f.prompt("Recall OBS_0.");
  assert.equal(f.requests.length, 2, f.stderr());
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === "triage_retrieve"));
});

test("OMP automatic compaction uses the local extension", { timeout: 60000 }, async t => {
  const f = await fixture(t, { automatic: true, historyRepeat: 800, compaction: { thresholdTokens: 24000, asyncEnabled: false } });
  await f.prompt("Continue.");
  await f.prompt("Continue again.");
  assert.ok((await f.rows()).some(r => r.type === "compaction" && r.details?.triage), JSON.stringify(f.events.slice(-5)));
});

test("OMP real installed Laya compacts without provider requests", { timeout: 180000, skip: !process.env.PI_TRIAGE_TEST_REAL_LAYA }, async t => {
  const f = await fixture(t, { ambiguous: true, env: { PI_TRIAGE_HOME: cacheHome(), PI_TRIAGE_PYTHON: undefined, PI_TRIAGE_MODEL_DIR: undefined } });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.requests.length, 0);
  const record = (await f.rows()).findLast(r => r.customType === "knowledge_triage_compaction");
  assert.ok(record.data.layaCalls > 0);
  assert.equal(record.data.layaFailures, 0);
});

test("OMP slow classification falls back before the host timeout and kills the worker", { timeout: 40000 }, async t => {
  const root = await temporary(t), python = join(root, "python"), model = join(root, "model"), pidFile = join(root, "pid");
  await mkdir(model);
  await writeFile(python, `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000);\n`, { mode: 0o755 });
  const f = await fixture(t, { ambiguous: true, env: { PI_TRIAGE_PYTHON: python, PI_TRIAGE_MODEL_DIR: model } });
  const start = Date.now(), result = await f.send({ type: "compact" }, 35000);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(Date.now() - start < 29000);
  const rows = await f.rows();
  assert.ok(rows.some(r => r.customType === "knowledge_triage_fallback" && /time budget/.test(r.data.reason)));
  assert.ok(!rows.some(r => r.customType === "knowledge_triage_compaction"));
  assert.ok(!f.events.some(e => e.type === "extension_error"));
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
