import assert from "node:assert/strict";
import test from "node:test";
import { rpcFixture } from "../rpc.mjs";
import { cacheHome, installedRuntime } from "../../src/laya/setup.ts";
import { createLayaClassifier } from "../../src/laya/classifier.ts";

test("real installed Laya classifies locally and compacts through the actual Pi CLI", { timeout: 180000 }, async t => {
  const config = await installedRuntime(cacheHome());
  assert.ok(config, "Run npm run triage:setup before the real-Laya suite");
  const classifier = createLayaClassifier(config);
  const results = await classifier.classify(["Use concise bullet points.", "Keep the audit trail intact."], undefined, "real-test");
  assert.equal(results.length, 2); assert.ok(results.every(Boolean));
  const f = await rpcFixture(t, { ambiguous: true, env: { PI_TRIAGE_HOME: cacheHome(), PI_TRIAGE_PYTHON: undefined, PI_TRIAGE_MODEL_DIR: undefined } });
  const result = await f.send({ type: "compact" }, 150000);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.requests.length, 0, "Local compaction must not contact the model provider");
  const rows = await f.rows(), record = rows.findLast(row => row.customType === "knowledge_triage_compaction");
  assert.equal(record.data.status, "ok"); assert.ok(record.data.layaCalls > 0); assert.equal(record.data.layaFailures, 0);
  assert.ok(rows.some(row => row.type === "compaction" && row.details?.triage));
});
