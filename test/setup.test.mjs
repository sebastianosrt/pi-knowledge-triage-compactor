import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cacheHome, ensureRuntime, installedRuntime, UV_VERSION } from "../src/laya/setup.ts";
import { run, setupEnvironment } from "../src/laya/process.ts";
import { LayaRuntime, LayaUnavailable } from "../src/laya/runtime.ts";

import { setupFixture } from "./setup-fixture.mjs";

test("cache overrides require absolute paths and setup strips provider credentials", () => {
  assert.equal(cacheHome({ PI_TRIAGE_HOME: "/tmp/example" }), "/tmp/example");
  assert.throws(() => cacheHome({ PI_TRIAGE_HOME: "relative" }), /absolute/);
  const env = setupEnvironment("/tmp/example");
  assert.equal(env.HF_HUB_DISABLE_TELEMETRY, "1");
  assert.equal(env.OPENROUTER_API_KEY, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
});

test("first-use setup publishes a ready marker; concurrent processes install once and reuse offline", async t => {
  const root = await setupFixture(t), messages = [];
  const signal = new AbortController().signal;
  const configs = await Promise.all([ensureRuntime(root, signal, text => messages.push(text)), ensureRuntime(root, signal, text => messages.push(text))]);
  assert.deepEqual(configs[0], configs[1]);
  assert.equal(await readFile(join(root, "installs"), "utf8"), "x");
  assert.ok(messages.some(text => text.includes("ready")));
  await ensureRuntime(root, signal, () => {}, true);
  assert.equal(await readFile(join(root, "installs"), "utf8"), "xx", "Explicit repair replaces the managed runtime");
  await rm(join(root, `uv-${UV_VERSION}`), { recursive: true });
  assert.deepEqual(await ensureRuntime(root, signal, () => assert.fail("Warm reuse must not set up")), configs[0]);
  await rm(join(configs[0].modelDirectory, "model.safetensors"));
  assert.equal(await installedRuntime(root), undefined);
});

test("interrupted installation kills descendants, releases the lock, and can restart", async t => {
  const root = await setupFixture(t); await writeFile(join(root, "pause"), "");
  const controller = new AbortController();
  const pending = ensureRuntime(root, controller.signal, () => {});
  const rejected = assert.rejects(pending, /abort/i);
  for (let i = 0; i < 300; i++) {
    try { await stat(join(root, "child-pid")); break; } catch { await delay(20); }
  }
  const pid = Number(await readFile(join(root, "child-pid"), "utf8"));
  controller.abort(); await rejected;
  assert.equal(await installedRuntime(root), undefined);
  // A reaped process or a short-lived zombie has stopped executing.
  try { assert.equal((await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2], "Z"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await rm(join(root, "pause"));
  assert.ok(await ensureRuntime(root, new AbortController().signal, () => {}));
  assert.equal(await readFile(join(root, "installs"), "utf8"), "xx");
});

test("process timeout terminates a worker and reports a bounded error", async () => {
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { timeout: 40 }), /timed out/);
});

test("runtime failures are remembered within a session and explicit setup retries", async t => {
  const original = { python: process.env.PI_TRIAGE_PYTHON, model: process.env.PI_TRIAGE_MODEL_DIR };
  process.env.PI_TRIAGE_PYTHON = "/missing/python"; process.env.PI_TRIAGE_MODEL_DIR = "/missing/model";
  t.after(() => {
    for (const [key, value] of [["PI_TRIAGE_PYTHON", original.python], ["PI_TRIAGE_MODEL_DIR", original.model]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const runtime = new LayaRuntime(); t.after(() => runtime.shutdown());
  await assert.rejects(runtime.classify(["Use concise bullets."], undefined, "session"), LayaUnavailable);
  assert.ok((await runtime.status()).last_error);
  await assert.rejects(runtime.classify(["Use concise bullets."], undefined, "session"), LayaUnavailable);
  runtime.reset(); assert.equal((await runtime.status()).last_error, null);
  await assert.rejects(runtime.setup(), LayaUnavailable);
  assert.equal((await runtime.status()).ready, false);
  assert.ok((await runtime.status()).last_error);
});
