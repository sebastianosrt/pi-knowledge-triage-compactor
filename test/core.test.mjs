import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalMandatory, collectItems, countTypes, readSnapshot, renderItems, typeCompact, typeRetrieve, writeSnapshot } from "../src/core/knowledge-triage.ts";
import { archiveObservation, contentHash } from "../src/core/triage-artifacts.ts";
import { cachePut, triageCacheStats } from "../src/core/triage-cache.ts";
import { withoutInlineCode } from "../src/core/markdown-context.ts";
import { createLayaClassifier } from "../src/laya/classifier.ts";

const item = (id, text = `OBS_${id} trace_code=value-${id}`, type = "belief") => ({ id: String(id), text, type,
  taskId: "task", topic: "inventory", source: `session-entry:${id}`, origin: "user", order: Number(id) || 0, decidedBy: "rule" });
const snapshot = items => ({ version: 1, extractionVersion: 4, items, partitions: [], retainedIds: [] });
const entry = (id, message) => ({ type: "message", id, message });
const cut = entry("cut", { role: "user", content: "Continue." });
async function temporary(t) { const root = await mkdtemp(join(tmpdir(), "triage-storage-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function session(root, id, parentSession) {
  const file = join(root, `${id}.jsonl`);
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id, parentSession, cwd: root }) + "\n"); return file;
}

test("all context entry types, full tool results and attachment references survive extraction", async t => {
  const root = await temporary(t), body = "x".repeat(16000) + " TRAILING_FACT=exact-long-result";
  const entries = [entry("tool", { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: body }] }),
    entry("custom-role", { role: "custom", customType: "fixture", content: "CUSTOM_ROLE_FACT=exact" }),
    entry("hidden", { role: "bashExecution", command: "hidden", output: "HIDDEN_FACT=private", excludeFromContext: true }),
    entry("bash", { role: "bashExecution", command: "fixture command", output: "BASH_FACT=exact", exitCode: 0 }),
    entry("assistant", { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { key: "ARGUMENT_FACT=exact" } }] }),
    { type: "custom_message", id: "custom", customType: "fixture", content: [{ type: "text", text: "CUSTOM_FACT=exact" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] },
    { type: "branch_summary", id: "branch", summary: "BRANCH_FACT=exact" }, cut];
  const { items } = await collectItems(entries, "cut", "task", undefined, undefined, undefined, undefined, root);
  const text = items.map(item => item.text).join("\n");
  for (const key of ["TRAILING_FACT", "BASH_FACT", "ARGUMENT_FACT", "CUSTOM_FACT", "CUSTOM_ROLE_FACT", "BRANCH_FACT"]) assert.match(text, new RegExp(key));
  assert.doesNotMatch(text, /HIDDEN_FACT/);
  const parts = items.filter(item => item.source_entry_id === "tool");
  assert.equal(parts.map(item => item.text).join(""), body);
  assert.deepEqual(parts.map(item => item.part), [0, 1, 2, 3, 4]);
  assert.ok(parts.every(item => item.parts === 5));
  assert.equal(JSON.parse(await readFile(parts[0].artifact.path, "utf8")).message.content[0].text, body);
  const attachment = items.find(item => item.topic === "attachment");
  assert.ok(attachment.artifact && attachment.source_entry_id === "custom");
  assert.equal(JSON.parse(await readFile(attachment.artifact.path, "utf8")).attachment.data, "aW1hZ2U=");
  assert.ok(items.every(item => !["constraint", "procedural"].includes(item.type)));
});

test("Markdown extraction respects longer, nested and tilde fence rules", async () => {
  const input = "~~~example\nNever pin this tilde example.\n```\n~~~\n\n````xml\nNever pin the nested example.\n```\n`````\n\n> Never pin quoted text.\nlazy continuation\n\nExample ``Never pin ` inline code``.\n\nNever remove the real constraint.";
  const { items } = await collectItems([entry("old", { role: "user", content: input }), cut], "cut", "task");
  assert.deepEqual(items.filter(item => item.type === "constraint").map(item => item.text), ["Never remove the real constraint."]);
});

test("mandatory equivalence is shared, preserves every source, and honors legacy retained IDs", () => {
  const items = Array.from({ length: 23 }, (_, i) => item(i, "Run " + "the repeated instruction ".repeat(20), "procedural"));
  const archive = snapshot(items), compacted = typeCompact(items, 4000);
  assert.equal(compacted.status, "ok"); assert.equal(compacted.kept.length, 1);
  assert.equal(compacted.kept[0].sources.length, 23);
  const found = typeRetrieve(archive, "task", "*");
  assert.equal(found.pinned.length, 1); assert.equal(found.pinned[0].sources.length, 23);
  assert.equal(renderItems(found.pinned), renderItems(compacted.kept));
  assert.equal(typeRetrieve(archive, "task", "*", 10, 0, new Set([items[17].id])).pinned.length, 0);
});

test("segmented archives append without rewriting prior segments and detect warm-cache corruption", async t => {
  const root = await temporary(t), file = await session(root, "session");
  const first = await writeSnapshot(file, "session", snapshot(Array.from({ length: 1200 }, (_, i) => item(i))));
  const directory = join(root, "triage", "session"), manifest = JSON.parse(await readFile(join(directory, first.file), "utf8"));
  assert.equal(first.version, 2); assert.deepEqual(manifest.segments.map(x => x.count), [512, 512, 176]);
  const before = await Promise.all(manifest.segments.map(x => stat(join(directory, "segments", x.file), { bigint: true })));
  const previous = await readSnapshot(file, "session", first);
  const second = await writeSnapshot(file, "session", snapshot([...previous.items, item(1200)]), previous);
  const next = JSON.parse(await readFile(join(directory, second.file), "utf8"));
  assert.deepEqual(next.segments.slice(0, 3), manifest.segments); assert.equal(next.segments[3].count, 1);
  const after = await Promise.all(manifest.segments.map(x => stat(join(directory, "segments", x.file), { bigint: true })));
  assert.deepEqual(after.map(x => x.mtimeNs), before.map(x => x.mtimeNs));
  const loaded = await readSnapshot(file, "session", second);
  assert.equal(loaded.items.length, 1201); assert.ok(Object.isFrozen(loaded.items));
  assert.equal(await readSnapshot(file, "session", second), loaded);
  typeRetrieve(loaded, "task", "OBS_1200");
  await writeFile(join(directory, "segments", next.segments[0].file), "[]");
  await assert.rejects(readSnapshot(file, "session", second), /checksum mismatch/);
});

test("forked artifacts are copied locally and survive original parent deletion and another fork", async t => {
  const root = await temporary(t), parent = await session(root, "parent"), child = await session(root, "child", parent);
  const artifact = await archiveObservation(join(root, "artifacts", "parent"), { text: "durable evidence" });
  const ref = await writeSnapshot(parent, "parent", snapshot([{ ...item("fact"), source: artifact.path, artifact }]));
  const imported = await readSnapshot(child, "child", ref);
  assert.equal(imported.items[0].artifact.path, join(root, "artifacts", "child", `${artifact.sha256}.observation.json`));
  await rm(join(root, "artifacts", "parent"), { recursive: true }); await rm(parent);
  assert.match(await readFile(imported.items[0].source, "utf8"), /durable evidence/);
  const grandchild = await session(root, "grandchild", child);
  const inherited = await readSnapshot(grandchild, "grandchild", ref);
  assert.ok(inherited.items[0].source.includes("/grandchild/"));
  await rm(join(root, "artifacts", "child"), { recursive: true });
  assert.match(await readFile(inherited.items[0].source, "utf8"), /durable evidence/);
});

test("v1 imports preserve exact bytes, extraction migration replays once, missing history is reported", async t => {
  const root = await temporary(t), parent = await session(root, "parent"), child = await session(root, "child", parent);
  const old = { ...snapshot([item("old", "Never delete records.", "constraint")]), extractionVersion: 3 };
  const body = JSON.stringify(old, null, 2), sha256 = contentHash(body), ref = { version: 1, file: `${sha256}.json`, sha256, counts: countTypes(old.items), retained: 0 };
  await mkdir(join(root, "triage", "parent"), { recursive: true }); await writeFile(join(root, "triage", "parent", ref.file), body);
  const imported = await readSnapshot(child, "child", ref);
  assert.equal(await readFile(join(root, "triage", "child", ref.file), "utf8"), body);
  const entries = [entry("old", { role: "user", content: "Never delete records." }), cut, { type: "compaction", id: "c", firstKeptEntryId: "cut" }, entry("next", { role: "user", content: "Continue again." })];
  const replay = await collectItems(entries, "next", "task", imported);
  assert.equal(replay.items.filter(x => x.text === "Never delete records.").length, 1);
  assert.equal(replay.stats.reconstructionIncomplete, undefined);
  const missing = await collectItems(entries.slice(1), "next", "task", imported);
  assert.equal(missing.stats.reconstructionIncomplete, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectItems(entries, "next", "task", imported, undefined, undefined, controller.signal), /abort/i);
});

test("archive and index cache obey the shared count and memory bounds", () => {
  for (let i = 0; i < 8; i++) cachePut(`fixture:${i}`, "snapshot", {}, 20 * 1024 * 1024);
  assert.ok(triageCacheStats().archives <= 4);
  assert.ok(triageCacheStats().estimatedBytes <= 64 * 1024 * 1024);
  cachePut("oversized", "index", {}, 65 * 1024 * 1024);
  assert.ok(triageCacheStats().estimatedBytes <= 64 * 1024 * 1024);
});

test("classification memo caches only valid results within a session and invalidates changed worker/model", async t => {
  const root = await temporary(t), model = join(root, "model"), worker = join(root, "worker.py"), counter = join(root, "counter");
  await mkdir(model); await writeFile(join(model, "provenance.json"), "one");
  const script = `import json, sys\nfrom pathlib import Path\np=Path(${JSON.stringify(counter)})\np.write_text(p.read_text()+'x' if p.exists() else 'x')\ntexts=json.load(sys.stdin)['texts']\nprint(json.dumps({'results':[{'answers':{'knowledge_type':{'choice':'preference','answer_confidence':0.99},'safety_critical':{'noul':0.01,'answer_confidence':0.99}},'usage':{'truncated':False}} for x in texts]}))\n`;
  await writeFile(worker, script);
  const classifier = createLayaClassifier({ python: "/usr/bin/python3", worker, modelDirectory: model });
  assert.deepEqual(await classifier.classify(["Use concise bullets.", "Use concise bullets."], undefined, "one"), ["preference", "preference"]);
  await classifier.classify(["Use concise bullets."], undefined, "one"); assert.equal(await readFile(counter, "utf8"), "x");
  await classifier.classify(["Use concise bullets."], undefined, "two"); assert.equal(await readFile(counter, "utf8"), "xx");
  await writeFile(join(model, "provenance.json"), "two"); await classifier.classify(["Use concise bullets."], undefined, "one");
  await writeFile(worker, script + "# changed\n"); await classifier.classify(["Use concise bullets."], undefined, "one");
  assert.equal(await readFile(counter, "utf8"), "xxxx");
  await writeFile(worker, script.replace("'truncated':False", "'truncated':True"));
  assert.deepEqual(await classifier.classify(["Use concise bullets."], undefined, "one"), [undefined]);
  await classifier.classify(["Use concise bullets."], undefined, "one"); assert.equal(await readFile(counter, "utf8"), "xxxxxx");
});


test("legacy artifact aliases survive cold reload and a second fork after the original is removed", async t => {
  const root = await temporary(t), parent = await session(root, "parent"), child = await session(root, "child", parent);
  const source = join(root, "artifacts", "parent", contentHash("tool-call") + ".observation.json");
  await mkdir(join(root, "artifacts", "parent"), { recursive: true }); await writeFile(source, '{"text":"legacy evidence"}');
  const value = { ...snapshot([{ ...item("legacy"), origin: "tool", source }]), extractionVersion: 3 };
  const body = JSON.stringify(value), sha256 = contentHash(body), ref = { version: 1, sha256, file: `${sha256}.json`, counts: countTypes(value.items), retained: 0 };
  await mkdir(join(root, "triage", "parent"), { recursive: true }); await writeFile(join(root, "triage", "parent", ref.file), body);
  const first = await readSnapshot(child, "child", ref);
  await rm(source);
  for (let i = 0; i < 5; i++) cachePut(`evict-legacy-${i}`, "test", {}, 1);
  const resumed = await readSnapshot(child, "child", ref);
  assert.equal(resumed.items[0].source, first.items[0].source);
  assert.equal(resumed.reconstructionIncomplete, undefined);
  const grandchild = await session(root, "grandchild", child);
  assert.match(await readFile((await readSnapshot(grandchild, "grandchild", ref)).items[0].source, "utf8"), /legacy evidence/);
});


test("inline-code stripping keeps exact behavior with linear work on many spans", () => {
  function previous(text) {
    const runs = [...text.matchAll(/`+/g)]; let start = 0, result = "";
    for (let i = 0; i < runs.length; i++) {
      const closing = runs.findIndex((run, j) => j > i && run[0].length === runs[i][0].length);
      if (closing < 0) continue;
      result += text.slice(start, runs[i].index) + " "; start = runs[closing].index + runs[closing][0].length; i = closing;
    }
    return result + text.slice(start);
  }
  let seed = 19;
  for (let sample = 0; sample < 1000; sample++) {
    let text = "";
    for (let i = 0; i < 25; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += "text " + "`".repeat(seed % 5) + " literal "; }
    assert.equal(withoutInlineCode(text), previous(text));
  }
  assert.equal(withoutInlineCode("word `literal` ".repeat(20000)), "word   ".repeat(20000));
});

test("mandatory source merging stays exact across many duplicate instructions", () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({ ...item(i, "Never delete records.", "constraint"), sources: ["shared", `source-${i % 9}`] }));
  const result = canonicalMandatory(items);
  assert.equal(result.length, 1); assert.equal(result[0].sources.length, 10010);
  assert.deepEqual(result[0].sources, [...new Set(items.flatMap(item => [item.source, ...item.sources]))]);
  assert.equal(result[0].id, items[0].id);
});
