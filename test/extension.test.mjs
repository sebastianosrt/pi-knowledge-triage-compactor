import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, item, snapshot, entry } from "./helpers.mjs";
import { branchState } from "../src/pi/state.ts";
import { retrievalPage } from "../src/pi/retrieval.ts";
import { readSnapshot, typeRetrieve, collectItems } from "../src/core/knowledge-triage.ts";

test("registration enables retrieval and preserves Pi tools; status exposes no extra model tool", async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.tools.keys()], ["triage_retrieve"]);
  assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "edit", "write", "triage_retrieve"]);
  assert.deepEqual([...f.commands.keys()], ["triage"]);
  f.disableTools(); await f.handlers.get("session_start")({}, f.context);
  assert.deepEqual(f.pi.getActiveTools(), []);
});

test("empty retrieval is normal; corrupt archives fail explicitly and abort context", async t => {
  const f = await fixture(t);
  const empty = await f.retrieve({ query: "needle" });
  assert.equal(empty.archive_available, false); assert.equal(empty.next_page, null);
  const ref = await f.archive(snapshot([item("one", "needle exact")]));
  assert.equal((await f.retrieve({ query: "needle" })).matches[0].text, "needle exact");
  await writeFile(join(f.root, "triage/session", ref.file), "corrupt");
  await assert.rejects(f.retrieve({ query: "needle" }), /checksum mismatch/);
  await assert.rejects(f.inject("needle"), /checksum mismatch/);
  assert.equal(f.context.aborted, true);
});

for (const total of [10, 21]) test(`clipped pagination emits all ${total} records exactly once, including a clipped final page`, () => {
  const records = Array.from({ length: total }, (_, i) => item(String(i), "needle " + "🌍".repeat(950), "belief", i));
  const archive = snapshot([item("rule", "Never delete records.", "constraint"), ...records]);
  const found = []; let args = { query: "needle", limit: 10 }, pages = 0, clipped = false;
  do {
    const page = retrievalPage(archive, "task", args);
    assert.ok(Buffer.byteLength(page.text) <= 32768);
    assert.equal(page.result.pinned.length, 1);
    found.push(...page.result.matches.map(value => value.id));
    if (page.result.matches.length < 10 && page.result.next_page) clipped = true;
    assert.ok(++pages <= total);
    if (page.result.next_page) {
      assert.equal(page.result.next_offset, found.length);
      assert.equal(page.result.next_page.offset, found.length);
      assert.equal(page.result.next_page.query, "needle");
      assert.equal(page.result.incomplete, true);
    } else assert.equal(page.result.incomplete, false);
    args = page.result.next_page;
  } while (args);
  assert.equal(found.length, total); assert.equal(new Set(found).size, total);
  assert.ok(clipped);
});

test("retained filtering and pinned overflow have explicit outcomes", () => {
  const archive = snapshot([item("kept", "needle kept"), item("new", "needle new")], ["kept"]);
  assert.deepEqual(retrievalPage(archive, "task", { query: "needle" }).result.matches.map(x => x.id), ["new"]);
  assert.equal(retrievalPage(archive, "task", { query: "needle", include_retained: true }).result.total, 2);
  assert.throws(() => retrievalPage(snapshot([item("rule", "Never " + "x".repeat(33000), "constraint")]), "task", { query: "*" }), /rules exceed/);
  assert.throws(() => retrievalPage(snapshot([item("large", "x".repeat(33000))]), "task", { query: "*" }), /matching item/);
});

test("automatic retrieval fits complete records and respects context headroom without changing model limits", async t => {
  const f = await fixture(t);
  await f.archive(snapshot([item("rule", "Never delete records.", "constraint"), item("fact", "needle exact"), item("long", "needle " + "x".repeat(9000))]));
  const result = await f.inject("needle");
  const text = result.messages.at(-1).content;
  assert.match(text, /Never delete records/); assert.match(text, /needle exact/);
  assert.ok(!text.includes("x".repeat(9000))); assert.ok(text.length <= 8000);
  f.context.model.contextWindow = 34000;
  await assert.rejects(f.inject("needle"), /COMPACTION_UNSAFE/);
  assert.equal(f.context.model.maxTokens, 32768); assert.equal(f.context.aborted, true);
});

test("rare identifier retrieval covers diverse requested records and remains task scoped", () => {
  const targets = Array.from({ length: 12 }, (_, i) => item(`t${i}`, `OBS_${i} exact=${i}`, "belief", i));
  const duplicates = Array.from({ length: 30 }, (_, i) => item(`d${i}`, "OBS_0 duplicate", "belief", 100 + i));
  const archive = snapshot([...targets, ...duplicates, item("other", "Never cross tasks", "constraint", 0, "other")]);
  const query = targets.map((_, i) => `OBS_${i}`).join(" ");
  const found = typeRetrieve(archive, "task", query, 12);
  assert.equal(new Set(found.matches.flatMap(value => value.text.match(/OBS_\d+/g))).size, 12);
  assert.equal(found.pinned.length, 0);
});

test("successful compaction persists a complete archive and a portable summary", async t => {
  const f = await fixture(t);
  f.branch.push(entry("old", "Never delete records.\n\nOBS_A value=alpha\n\nUse concise bullet points."), entry("cut", "Continue."));
  const result = await f.compact();
  assert.match(result.compaction.summary, /Never delete records/);
  const archive = await readSnapshot(f.file, "session", result.compaction.details.triage);
  assert.ok(archive.items.some(value => value.text.includes("value=alpha")));
  assert.ok(archive.items.every(value => value.taskId === "task"));
});

for (const kind of ["throw", "invalid"]) test(`Laya ${kind} uses native fallback and preserves old archive coverage on resume`, async t => {
  const f = await fixture(t, { async classify() { if (kind === "throw") throw new Error("worker unavailable"); return [undefined]; } });
  const ref = await f.archive(snapshot([item("old", "OLD_CODE=exact")], ["old"]));
  f.branch.push(entry("cut", "Keep the complete audit trail."), entry("next", "Continue."));
  const result = await f.compact(undefined, "next");
  assert.equal(result, undefined);
  const native = { type: "compaction", id: "native", firstKeptEntryId: "next", summary: "Native summary" };
  f.branch.push(native);
  f.handlers.get("session_compact")({ compactionEntry: native, fromExtension: false }, f.context);
  await f.handlers.get("session_start")({}, f.context);
  const state = branchState(f.branch, "session");
  assert.equal(state.ref.sha256, ref.sha256); assert.equal(state.nativeGap, true);
  const page = await f.retrieve({ query: "OLD_CODE" });
  assert.equal(page.archive_coverage, "before_native_fallback"); assert.equal(page.retained_excluded, false);
  assert.equal(page.matches[0].text, "OLD_CODE=exact");
});

test("native fallback history is replayed when triage resumes", async t => {
  let fails = true;
  const f = await fixture(t, { async classify(texts) { if (fails) throw new Error("temporary worker failure"); return texts.map(() => "constraint"); } });
  f.branch.push(entry("first", "BASE_CODE=first"), entry("cut", "Continue."));
  const first = await f.compact();
  f.branch.push({ type: "compaction", id: "first-compact", ...first.compaction });
  f.branch.push(entry("during", "Keep a complete audit trail.\n\nGAP_CODE=during"), entry("next", "Continue again."));
  assert.equal(await f.compact(undefined, "next"), undefined);
  const native = { type: "compaction", id: "native", firstKeptEntryId: "next", summary: "Native summary" };
  f.branch.push(native); f.handlers.get("session_compact")({ compactionEntry: native, fromExtension: false }, f.context);
  f.branch.push(entry("after", "AFTER_CODE=after"), entry("last", "Continue again.")); fails = false;
  const final = await f.compact(undefined, "last");
  const archive = await readSnapshot(f.file, "session", final.compaction.details.triage);
  for (const text of ["BASE_CODE=first", "GAP_CODE=during", "AFTER_CODE=after"])
    assert.ok(archive.items.some(value => value.text.includes(text)), text);
});

test("user cancellation and shutdown never start native fallback", async t => {
  const controller = new AbortController(); controller.abort();
  const f = await fixture(t); f.branch.push(entry("cut", "Continue."));
  assert.deepEqual(await f.compact(controller.signal), { cancel: true });
  assert.equal(f.logs.some(row => row.name === "knowledge_triage_status" && /default compactor/.test(row.data.message)), false);
  const g = await fixture(t, { async classify() { g.handlers.get("session_shutdown")({}, g.context); throw new Error("aborted"); } });
  g.branch.push(entry("old", "Keep the complete audit trail."), entry("cut", "Continue."));
  assert.deepEqual(await g.compact(), { cancel: true });
});

test("missing persistent storage uses native compaction and exposes no archive", async t => {
  const f = await fixture(t); f.context.sessionManager.getSessionFile = () => undefined;
  assert.equal(await f.compact(), undefined);
  assert.equal((await f.retrieve({ query: "*" })).archive_available, false);
});

test("ordinary tool results are archived without modifying content or structured results", async t => {
  const f = await fixture(t);
  const event = { toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "complete " + "x".repeat(16000) }],
    details: { custom: true }, structuredContent: { value: 123 }, isError: false };
  assert.equal(await f.handlers.get("tool_result")(event, f.context), undefined);
  const archived = f.logs.find(row => row.name === "knowledge_triage_artifact").data;
  const body = JSON.parse(await readFile(archived.path, "utf8"));
  assert.deepEqual(body.content, event.content); assert.deepEqual(body.structuredContent, event.structuredContent);
});

test("retrieval results are not recursively archived as new knowledge", async () => {
  const { items } = await collectItems([{ type: "message", id: "retrieved", message: { role: "toolResult", toolName: "triage_retrieve", content: [{ type: "text", text: "DUPLICATE_RECORD" }] } }, entry("cut", "Continue.")], "cut", "task");
  assert.equal(items.length, 0);
});
