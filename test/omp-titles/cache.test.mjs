import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeSnapshot } from "../../src/core/knowledge-triage.ts";

// Run with Bun from a patched OMP source checkout (see docs/omp-method-order.md).
const ompSource = process.env.PI_TRIAGE_TEST_OMP_SOURCE;
if (!ompSource) throw new Error("Set PI_TRIAGE_TEST_OMP_SOURCE to the patched OMP source checkout");
const host = path => import(pathToFileURL(join(ompSource, "packages/coding-agent/src", path)).href);
const { createAgentSession } = await host("sdk.ts");
const { initializeExtensions } = await host("modes/runtime-init.ts");
const { Settings } = await host("config/settings.ts");
const { ModelRegistry } = await host("config/model-registry.ts");
const { AuthStorage } = await host("session/auth-storage.ts");
const { SessionManager } = await host("session/session-manager.ts");
const packageRoot = resolve(import.meta.dir, "../..");
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const [archive, titleFailure] of [[false, false], [true, false], [false, true]]) {
  test(`automatic titles leave three read continuations append-only, archive=${archive}, titleFailure=${titleFailure}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-title-cache-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent"); await mkdir(agentDir);
    for (let i = 0; i < 3; i++) await writeFile(join(root, `record-${i}.txt`), `CACHE_FACT_${i}=value-${i}\n`);
    const mainRequests = [], titleRequests = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.json();
      const title = body.model === "title:1b";
      const requests = title ? titleRequests : mainRequests;
      const index = requests.length; requests.push(body);
      if (title && titleFailure) return Response.json({ error: { message: "Title model unavailable" } }, { status: 400 });
      const tool = !title && index < 3;
      if (!title && index > 0) await Bun.sleep(30);
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${index}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: join(root, `record-${index}.txt`) }) } }] }
        : { role: "assistant", content: title ? "<title>Inspect cached inventory</title>" : "Read all three records." };
      const chunk = { id: `${title ? "title" : "main"}-${index}`, object: "chat.completion.chunk", created: 1, model: body.model };
      return new Response(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } });
    } });
    cleanups.push(() => server.stop(true));
    const modelsPath = join(agentDir, "models.yml");
    const modelSpec = id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false,
        supportsStore: false, maxTokensField: "max_tokens", extraBody: id === "title:1b" ? { reasoning_effort: "none" } : {} } });
    await writeFile(modelsPath, JSON.stringify({ providers: {
      "main-fixture": { baseUrl: `${server.url}v1`, api: "openai-completions", auth: "none", models: [modelSpec("main")] },
      "title-fixture": { baseUrl: `${server.url}v1`, api: "openai-completions", auth: "none", models: [{ ...modelSpec("title:1b"), contextWindow: 8192 }] },
    } }));
    const settings = Settings.isolated({ modelRoles: { default: "main-fixture/main", tiny: "title-fixture/title:1b" },
      "title.generator": "tiny", "title.modelFallback": false, "compaction.enabled": false, "retry.enabled": false,
      "autolearn.enabled": false, "mnemopi.llmMode": "none", "lsp.enabled": false,
      "plan.defaultOnStartup": false, "title.refreshAfterPrompts": 0 });
    const auth = await AuthStorage.create(":memory:"); cleanups.push(() => auth.close());
    const registry = new ModelRegistry(auth, modelsPath, { settings, cacheDbPath: join(root, "models.db") });
    const model = registry.getAvailable().find(model => model.provider === "main-fixture");
    expect(model).toBeDefined();
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendCustomEntry("knowledge_triage_state", { version: 1, task_id: "task" });
    if (archive) {
      const kept = manager.appendMessage({ role: "user", content: "Remember the inventory records.", timestamp: Date.now() });
      const snapshot = { version: 1, extractionVersion: 4, retainedIds: [], partitions: [], items: [
        { id: "fact", text: "OBS_0 exact_value=0", type: "belief", order: 0, taskId: "task", topic: "fixture",
          source: "session-entry:fact", origin: "user", decidedBy: "rule" },
      ] };
      const ref = await writeSnapshot(manager.getSessionFile(), manager.getSessionId(), snapshot);
      manager.appendCompaction("Inventory records are archived.", undefined, kept, 80000, { details: { task_id: "task", triage: ref } });
    }
    const { session, extensionsResult } = await createAgentSession({ cwd: root, agentDir, model, authStorage: auth, modelRegistry: registry,
      sessionManager: manager, settings, autoTitle: true, hasUI: false, cacheWarming: false,
      additionalExtensionPaths: [join(packageRoot, "src/extension.ts")], disableExtensionDiscovery: true,
      enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true, noContextFiles: true,
      skills: [], rules: [], promptTemplates: [], slashCommands: [], toolNames: ["read"],
      systemPrompt: "Read the requested inventory records accurately." });
    cleanups.push(() => session.dispose());
    expect(extensionsResult.errors).toEqual([]);
    const extensionErrors = [];
    await initializeExtensions(session, {
      reportSendError: (action, error) => extensionErrors.push({ action, error: String(error) }),
      reportRuntimeError: error => extensionErrors.push(error),
    });
    await session.prompt("Recall OBS_0 from archived records.");
    await session.waitForIdle();
    for (let i = 0; i < 200 && (titleFailure ? !titleRequests.length : !session.sessionName); i++) await Bun.sleep(10);
    if (titleFailure) expect(session.sessionName).toBeUndefined();
    else expect(session.sessionName).toBe("Inspect cached inventory");
    expect(extensionErrors).toEqual([]);
    expect(titleRequests.length).toBeGreaterThan(0);
    if (!titleFailure) expect(titleRequests).toHaveLength(1);
    expect(titleRequests[0].reasoning_effort).toBe("none");
    expect(mainRequests).toHaveLength(4);
    for (let i = 1; i < mainRequests.length; i++) {
      const previous = mainRequests[i - 1], current = mainRequests[i];
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
      expect(current.tools).toEqual(previous.tools);
      expect(current.messages.some(m => m.role === "tool" && JSON.stringify(m).includes(`CACHE_FACT_${i - 1}`))).toBe(true);
    }
    expect(JSON.stringify(mainRequests[0].messages).includes("exact_value=0"), JSON.stringify(manager.getBranch().filter(e => e.type !== "message"))).toBe(archive);
    expect(manager.getBranch().filter(e => e.customType === "knowledge_triage_injection")).toHaveLength(archive ? 1 : 0);
    expect(manager.getBranch().filter(e => e.customType === "knowledge_triage_artifact")).toHaveLength(3);
    expect(mainRequests.every(request => request.model === "main")).toBe(true);
  }, 30_000);
}
