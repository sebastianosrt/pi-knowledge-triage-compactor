import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLayaClassifier } from "../src/laya/classifier.ts";
import { collectItems, readSnapshot, typeCompact, typeRetrieve, writeSnapshot } from "../src/core/knowledge-triage.ts";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "laya-compaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const input = (text) => [{ type: "message", id: "old", message: { role: "user", content: text } },
  { type: "message", id: "kept", message: { role: "user", content: "Continuing review." } }];
const result = (choice = "preference", confidence = 0.99, truncated = false) => ({
  answers: { knowledge_type: { choice, answer_confidence: confidence }, safety_critical: { noul: 0.01, answer_confidence: 0.99 } },
  usage: { truncated },
});
test("local worker has a username and UID-specific writable cache, with offline settings", async (t) => {
  const root = await temporary(t);
  const worker = join(root, "worker.py");
  await writeFile(worker, `import json, os, sys\nrequest=json.load(sys.stdin)\nassert os.environ['USER']=='laya'\nassert os.environ['HF_HUB_OFFLINE']=='1'\nassert os.environ['TRANSFORMERS_OFFLINE']=='1'\nassert str(os.getuid()) in os.environ['TORCHINDUCTOR_CACHE_DIR']\nassert 'OPENROUTER_API_KEY' not in os.environ\nprint(json.dumps({'results':[${JSON.stringify(result())}] * len(request['texts'])}))\n`.replaceAll("false", "False"));
  const classifier = createLayaClassifier({ python: "/usr/bin/python3", worker, modelDirectory: root });
  assert.deepEqual(await classifier.classify(["Use concise bullet points."]), ["preference"]);
});

test("failed or invalid classifications retain constraints and log failures", async () => {
  const text = "Keep the audit trail intact.\n\nUse concise bullet points for the final response.";
  for (const classifier of [
    { async classify() { throw new Error("Local Laya worker failed"); } },
    { async classify() { return [undefined, undefined]; } },
    createLayaClassifier({ python: "/usr/bin/python3", worker: "/missing/laya-worker.py", modelDirectory: "/missing/model" }),
  ]) {
    const { items, stats } = await collectItems(input(text), "kept", "task", undefined, undefined, classifier);
    assert.equal(stats.layaCalls, 2); assert.equal(stats.layaFailures, 2);
    assert.ok(items.every((item) => item.type === "constraint" && item.decidedBy === "conservative"));
  }
});

test("malformed, truncated and uncertain local responses cannot relax instructions", async (t) => {
  const root = await temporary(t); const worker = join(root, "worker.py");
  const results = [result("preference", 0.4), result("preference", 0.99, true), { answers: {} }];
  await writeFile(worker, `import json, sys\njson.load(sys.stdin)\nprint(${JSON.stringify(JSON.stringify({ results }))})\n`);
  const classifier = createLayaClassifier({ python: "/usr/bin/python3", worker, modelDirectory: root });
  assert.deepEqual(await classifier.classify(["Use concise bullets.", "Use concise bullets.", "Use concise bullets."]), ["constraint", undefined, undefined]);
});

test("cancellation terminates a local worker", async (t) => {
  const root = await temporary(t); const worker = join(root, "worker.py");
  await writeFile(worker, "import time\ntime.sleep(60)\n");
  const classifier = createLayaClassifier({ python: "/usr/bin/python3", worker, modelDirectory: root });
  const controller = new AbortController();
  const pending = classifier.classify(["Use concise bullets."], controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test("archive retrieval and mandatory overflow remain conservative", async (t) => {
  const root = await temporary(t); const file = join(root, "session.jsonl");
  const { items } = await collectItems(input("Never delete records.\n\nObservation OBS_X has trace_code=fixture-value."), "kept", "task", undefined, undefined, undefined);
  assert.equal(typeCompact(items, 1).status, "COMPACTION_UNSAFE");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "session", cwd: root }) + "\n");
  const ref = await writeSnapshot(file, "session", { version: 1, extractionVersion: 3, items, partitions: [], retainedIds: [] });
  const snapshot = await readSnapshot(file, "session", ref);
  const found = typeRetrieve(snapshot, "task", "OBS_X", 10, 0, new Set());
  assert.ok(found.pinned.some((item) => item.text.includes("Never delete")));
  assert.ok(found.matches.some((item) => item.text.includes("fixture-value")));
  assert.equal(typeRetrieve(snapshot, "different-task", "OBS_X", 10).matches.length, 0);
});
