import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { compactionAllowance, sessionProjection, systemPrompt, withinDeadline, CompactionDeadline } from "../src/pi/host.ts";
import { fixture, item, snapshot } from "./helpers.mjs";

const context = messages => ({ model: { contextWindow: 131072 }, getSystemPrompt: () => ["a".repeat(5000), "b".repeat(5000)],
  sessionManager: { buildSessionContext: () => ({ messages }) } });
const entry = (id, text, timestamp = 1) => ({ id, type: "message", message: { role: "user", content: text, timestamp } });

test("OMP uses canonical filtering and handles rewritten messages and duplicate ancestors", () => {
  const old = entry("old", "same"), kept = entry("kept", "same");
  const compact = { id: "compact", type: "compaction", firstKeptEntryId: "kept", summary: "summary", tokensBefore: 100, timestamp: new Date(100).toISOString() };
  const rewritten = { ...kept.message, content: "rewritten" };
  const projection = sessionProjection(context([rewritten]), [old, kept, compact]);
  assert.deepEqual(projection.entries, [{ sourceEntry: kept, messages: [rewritten] }]);
  assert.throws(() => sessionProjection(context([kept.message]), [old, kept]), /ambiguous/);
  assert.equal(sessionProjection(context([kept.message, kept.message]), [old, kept]).entries.length, 2);
});

test("OMP arrays and omitted reserves produce a finite bounded allowance", () => {
  const ctx = context([]);
  assert.equal(systemPrompt(ctx).length, 10001);
  assert.equal(compactionAllowance(ctx, { settings: { keepRecentTokens: 20000 }, recentMessages: [] }), 12000);
  ctx.model.contextWindow = 24000;
  assert.ok(compactionAllowance(ctx, { settings: { keepRecentTokens: 20000 }, recentMessages: [] }) < 1200);
});

test("OMP deadlines abort late work and return without waiting for it", async () => {
  let committed = false;
  await assert.rejects(withinDeadline(async signal => {
    await delay(50); signal.throwIfAborted(); committed = true;
  }, [], 10), CompactionDeadline);
  await delay(60);
  assert.equal(committed, false);
});

test("context without a durable anchor defers rather than fabricating provenance", async t => {
  const f = await fixture(t); await f.archive(snapshot([item("one", "needle")]));
  delete f.context.sessionManager.buildSessionProjection;
  f.context.sessionManager.buildSessionContext = () => ({ messages: [{ role: "user", content: "needle", timestamp: 123 }] });
  const result = await f.handlers.get("context")({ messages: f.context.sessionManager.buildSessionContext().messages }, f.context);
  assert.equal(result.messages.length, 1);
  assert.equal(f.logs.at(-1).data.truncation_reason, "source_anchor");
  assert.equal(f.context.aborted, undefined);
});

test("caller cancellation wins over the OMP deadline", async () => {
  const controller = new AbortController(), error = new Error("user cancelled");
  const pending = withinDeadline(async signal => {
    await delay(50); signal.throwIfAborted();
  }, [controller.signal], 1000);
  controller.abort(error);
  await assert.rejects(pending, e => e === error);
});
