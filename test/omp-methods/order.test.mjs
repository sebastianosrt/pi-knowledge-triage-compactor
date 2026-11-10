import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporary } from "../helpers.mjs";
import { rpcFixture } from "../rpc.mjs";

const fixture = (t, options = {}) => rpcFixture(t, { host: "omp", ...options });

test("OMP method order runs triage first without provider inference", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.requests.length, 0);
  const compact = (await f.rows()).findLast(r => r.type === "compaction");
  assert.equal(compact.method, "knowledge-triage");
  assert.ok(compact.details?.triage);
});

for (const methodOrder of [["soft", "knowledge-triage"], ["soft"]]) {
  test(`OMP respects earlier native methods and disabled triage: ${methodOrder}`, { timeout: 60000 }, async t => {
    const f = await fixture(t, { compaction: { methodOrder } });
    const result = await f.send({ type: "compact" });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(f.requests.length > 0);
    const rows = await f.rows(), compact = rows.findLast(r => r.type === "compaction");
    assert.equal(compact.method, "soft");
    assert.equal(compact.details?.triage, undefined);
    assert.equal(rows.some(r => r.customType === "knowledge_triage_compaction"), false);
  });
}

test("OMP unavailable triage advances to soft compaction with the coverage gap recorded", { timeout: 60000 }, async t => {
  const f = await fixture(t, { ambiguous: true });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(f.requests.length > 0);
  const rows = await f.rows();
  assert.equal(rows.findLast(r => r.type === "compaction").method, "soft");
  assert.ok(rows.some(r => r.customType === "knowledge_triage_fallback"));
});

test("OMP triage-only failure does not call an unselected provider method", { timeout: 60000 }, async t => {
  const f = await fixture(t, { ambiguous: true, compaction: { methodOrder: ["knowledge-triage"] } });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, false);
  assert.match(result.error, /Knowledge triage is unavailable/);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.rows()).some(r => r.type === "compaction"), false);
});

test("OMP skips the triage method when its extension is absent", { timeout: 60000 }, async t => {
  const root = await temporary(t), extension = join(root, "empty.ts");
  await writeFile(extension, "export default function () {}\n");
  const f = await fixture(t, { extension });
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(f.requests.length > 0);
  assert.equal((await f.rows()).findLast(r => r.type === "compaction").method, "soft");
});

test("OMP choosing a native method preserves access to an earlier archive", { timeout: 60000 }, async t => {
  const f = await fixture(t, { archive: true, compaction: { methodOrder: ["soft"] } });
  await f.prompt("Continue with the next inventory. " + "New observation. ".repeat(800));
  const result = await f.send({ type: "compact" });
  assert.equal(result.success, true, JSON.stringify(result));
  const rows = await f.rows();
  assert.ok(rows.findLast(r => r.customType === "knowledge_triage_fallback")?.data.triage);
  f.behavior.tool = true;
  await f.prompt("Recall OBS_0.");
  const retrieval = (await f.rows()).findLast(r => r.message?.toolName === "triage_retrieve");
  assert.equal(retrieval.message.details.result.archive_available, true);
  assert.equal(retrieval.message.details.result.archive_coverage, "before_native_fallback");
});

for (const methodOrder of [["knowledge-triage", "soft"], ["soft", "knowledge-triage"]]) {
  test(`OMP automatic compaction honors method priority: ${methodOrder}`, { timeout: 60000 }, async t => {
    const f = await fixture(t, { automatic: true, historyRepeat: 800,
      compaction: { thresholdTokens: 24000, methodOrder, asyncEnabled: false } });
    await f.prompt("Continue.");
    await f.prompt("Continue again.");
    const compact = (await f.rows()).find(r => r.type === "compaction");
    assert.equal(compact?.method, methodOrder[0], JSON.stringify(f.events.slice(-5)));
    assert.equal(Boolean(compact.details?.triage), methodOrder[0] === "knowledge-triage");
  });
}

test("OMP automatic compaction falls through when the classifier is unavailable", { timeout: 60000 }, async t => {
  const f = await fixture(t, { automatic: true, ambiguous: true, historyRepeat: 800,
    compaction: { thresholdTokens: 24000, asyncEnabled: false } });
  await f.prompt("Continue.");
  await f.prompt("Continue again.");
  const rows = await f.rows();
  assert.equal(rows.find(r => r.type === "compaction")?.method, "soft", JSON.stringify(f.events.slice(-5)));
  assert.ok(rows.some(r => r.customType === "knowledge_triage_fallback"));
});
