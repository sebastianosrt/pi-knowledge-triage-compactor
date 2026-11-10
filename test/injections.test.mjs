import assert from "node:assert/strict";
import test from "node:test";
import { fixture, item, snapshot } from "./helpers.mjs";
import { collectItems } from "../src/core/knowledge-triage.ts";
import { INJECTION } from "../src/pi/injections.ts";

const blocks = result => result.messages.filter(m => m.customType === "knowledge_triage_context");
const append = (f, id, message) => f.branch.push({ type: "message", id, message: { timestamp: f.branch.length, ...message } });

test("tool continuations and retries preserve the exact injected prefix without new records", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("one", "needle alpha")]));
  const first = await f.inject("needle");
  append(f, "assistant", { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] });
  append(f, "result", { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }] });
  const second = await f.project(), retried = await f.project();
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(retried, second);
  assert.equal(blocks(second).length, 1);
  assert.equal(f.branch.filter(e => e.customType === INJECTION).length, 1);
  // Reloaded handlers recover the record from the active branch, without rewriting its timestamp/content.
  await f.handlers.get("session_start")({}, f.context);
  assert.deepEqual(await f.project(), second);
});

test("changed retrieval appends once; an identical result for a different query reuses its block", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("a", "alpha needle"), item("b", "beta other")]));
  const first = await f.inject("alpha");
  const same = await f.inject("needle");
  assert.deepEqual(same.messages.slice(0, first.messages.length), first.messages);
  assert.equal(blocks(same).length, 1);
  const changed = await f.inject("beta");
  assert.deepEqual(changed.messages.slice(0, same.messages.length), same.messages);
  assert.equal(blocks(changed).length, 2);
  assert.match(blocks(changed)[1].content, /beta other/);
  assert.deepEqual(await f.project(), changed);
});

test("headroom pressure preserves older blocks on continuations and changed queries", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("a", "alpha"), item("b", "beta")]));
  const first = await f.inject("alpha"), logs = f.logs.length;
  f.context.model.contextWindow = 34000;
  append(f, "large-result", { role: "toolResult", toolCallId: "call", toolName: "read",
    content: [{ type: "text", text: "x".repeat(16000) }] });
  const continued = await f.project();
  assert.deepEqual(continued.messages.slice(0, first.messages.length), first.messages);
  assert.equal(f.logs.length, logs); // A known query does not need another budget decision.
  const changed = await f.inject("beta");
  assert.deepEqual(changed.messages.slice(0, continued.messages.length), continued.messages);
  assert.deepEqual(blocks(changed), blocks(first));
  assert.equal(f.context.aborted, undefined);
  assert.equal(f.logs.at(-1).data.deferred, true);
  await f.handlers.get("session_start")({}, f.context);
  assert.deepEqual(await f.project(), changed);
  f.context.model.contextWindow = 131072;
  const recovered = await f.project();
  assert.deepEqual(recovered.messages.slice(0, changed.messages.length), changed.messages);
  assert.equal(blocks(recovered).length, 2);
  assert.match(blocks(recovered)[1].content, /beta/);
});

test("forks cannot inherit injections from a sibling branch", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("a", "alpha"), item("b", "beta")]));
  const first = await f.inject("alpha"), cut = f.branch.length;
  await f.inject("beta");
  f.branch.splice(cut);
  const fork = await f.inject("alpha");
  assert.equal(blocks(fork).length, 1);
  assert.deepEqual(blocks(fork), blocks(first));
});

test("compaction retires omitted anchors and injects again without a new agent-start event", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("a", "alpha")]));
  const first = await f.inject("alpha");
  // The newer compaction keeps only a later message, dropping the first injection's anchor.
  append(f, "cut", { role: "user", content: "alpha" });
  await f.archive(snapshot([item("a", "alpha")]));
  const second = await f.project();
  assert.equal(blocks(second).length, 1);
  assert.notEqual(blocks(second)[0].details.triage_injection_id, blocks(first)[0].details.triage_injection_id);
  assert.deepEqual(await f.project(), second);
});

test("journal corruption aborts instead of silently moving or dropping archived knowledge", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("a", "alpha")]));
  await f.inject("alpha");
  f.branch.find(e => e.customType === INJECTION).data.content += "tampered";
  await assert.rejects(f.project(), /corrupt archived-context injection/);
  assert.equal(f.context.aborted, true);
});

test("derived injection records are not extracted into the next archive", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("a", "alpha")]));
  await f.inject("alpha");
  const record = f.branch.find(e => e.customType === INJECTION);
  const result = await collectItems([record, { type: "message", id: "cut", message: { role: "user", content: "Continue." } }], "cut", "task");
  assert.equal(result.items.length, 0);
});
