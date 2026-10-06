import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../src/extension.ts";
import { writeSnapshot } from "../src/core/knowledge-triage.ts";

export const item = (id, text = `OBS_${id} value=${id}`, type = "belief", order = 0, taskId = "task") =>
  ({ id, text, type, order, taskId, topic: "fixture", source: `session-entry:${id}`, origin: "user", decidedBy: "rule" });
export const snapshot = (items, retainedIds = []) => ({ version: 1, extractionVersion: 4, items, retainedIds, partitions: [] });
export const entry = (id, content) => ({ type: "message", id, message: { role: "user", content, timestamp: 0 } });
export async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-triage-test-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
export async function fixture(t, classifier = { async classify(texts) { return texts.map(() => "constraint"); } }) {
  const root = await temporary(t), file = join(root, "session.jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: "session", cwd: root }) + "\n");
  const branch = [{ type: "custom", id: "state", customType: "knowledge_triage_state", data: { version: 1, task_id: "task" } }];
  const logs = [], handlers = new Map(), tools = new Map(), commands = new Map(), messages = [];
  let active = ["read", "bash", "edit", "write"], sequence = 0;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry(name, data) { logs.push({ name, data }); branch.push({ type: "custom", id: `log-${sequence++}`, customType: name, data }); },
    getActiveTools: () => [...active], getAllTools: () => [...tools.values()],
    setActiveTools() { throw new Error("Extension must not replace the tool set"); },
    sendMessage: message => messages.push(message),
  };
  const context = { hasUI: false, cwd: root, abort() { this.aborted = true; }, model: { contextWindow: 131072, maxTokens: 32768 },
    getSystemPrompt: () => "Answer accurately.",
    sessionManager: { getSessionFile: () => file, getSessionId: () => "session", getBranch: () => [...branch] } };
  createExtension(pi, classifier ? { classifier } : {});
  t.after(() => handlers.get("session_shutdown")({}, context));
  return { root, file, branch, logs, handlers, tools, commands, context, messages, pi,
    disableTools() { active = []; },
    async archive(value) {
      const ref = await writeSnapshot(file, "session", value);
      branch.push({ type: "compaction", id: `compact-${sequence++}`, firstKeptEntryId: "cut", details: { triage: ref, task_id: "task" } }); return ref;
    },
    async retrieve(args) { return (await tools.get("triage_retrieve").execute("call", args, undefined, undefined, context)).details.result; },
    async inject(text) { return handlers.get("context")({ messages: [{ role: "user", content: text, timestamp: 0 }] }, context); },
    async compact(signal = new AbortController().signal, cut = "cut") {
      return handlers.get("session_before_compact")({ branchEntries: [...branch], reason: "manual", willRetry: false, signal,
        preparation: { firstKeptEntryId: cut, previousSummary: "Previous summary", tokensBefore: 70000,
          settings: { reserveTokens: 16384, keepRecentTokens: 20000 } } }, context);
    },
  };
}
