import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { temporary, item, snapshot } from "./helpers.mjs";
import { writeSnapshot } from "../src/core/knowledge-triage.ts";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const piDirectory = process.env.PI_TRIAGE_TEST_PI_DIR ?? join(packageRoot, "node_modules/@earendil-works/pi-coding-agent");
export const piCli = join(piDirectory, "dist/cli.js");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "fixture",
  model: "fixture", stopReason: "stop", timestamp: Date.now(), usage });

export async function rpcFixture(t, options = {}) {
  const root = await temporary(t), agent = join(root, "agent"); await mkdir(agent);
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendCustomEntry("knowledge_triage_state", { version: 1, task_id: "task" });
  let kept;
  for (let i = 0; i < 12; i++) {
    kept = manager.appendMessage({ role: "user", content: (i === 0 ? (options.ambiguous ? "Keep the complete audit trail.\n\n" : "Never delete records.\n\n") + "OLD_FACT=alpha\n\n" : "") +
      `Block ${i}: ` + "Synthetic inventory record with ordinary facts. ".repeat(50), timestamp: Date.now() });
    manager.appendMessage(assistant("Acknowledged."));
  }
  if (options.archive) {
    const value = options.oversized ? snapshot([item("rule", "Never " + "x".repeat(9000), "constraint")])
      : snapshot(Array.from({ length: 12 }, (_, i) => item(`fact-${i}`, `OBS_${i} exact_value=${i}`, "belief", i)));
    const ref = await writeSnapshot(manager.getSessionFile(), manager.getSessionId(), value);
    manager.appendCompaction("Prior inventory records are archived.", kept, 80000, { task_id: "task", triage: ref });
    if (options.corrupt) await writeFile(join(dirname(manager.getSessionFile()), "triage", manager.getSessionId(), ref.file), "corrupt");
  }
  const requests = [], behavior = { tool: false, called: false, text: "Local fixture response." };
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw); requests.push(payload);
      const tool = behavior.tool && !behavior.called;
      const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "retrieve-fixture", type: "function",
        function: { name: "triage_retrieve", arguments: JSON.stringify({ query: "OBS_0", include_retained: true }) } }] }
        : { role: "assistant", content: behavior.text };
      if (tool) behavior.called = true;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = { id: `fixture-${requests.length}`, object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "fixture-only",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
      contextWindow: 131072, maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 512, reserveTokens: 1024 } }));
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", PI_CODING_AGENT_DIR: agent,
    PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0",
    PI_TRIAGE_PYTHON: "/missing/python", PI_TRIAGE_MODEL_DIR: "/missing/model", ...options.env };
  let extension = options.extension ?? join(packageRoot, "src/extension.ts");
  let installed = false;
  if (options.install) {
    await promisify(execFile)(process.execPath, [piCli, "install", resolve(extension)], { cwd: root, env });
    const settings = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
    assert.ok(settings.packages.some(value => {
      const source = typeof value === "string" ? value : value.source;
      return typeof source === "string" && resolve(agent, source) === resolve(extension);
    }), JSON.stringify(settings.packages));
    installed = true;
  }
  const args = [piCli, "--provider", "fixture", "--model", "fixture", "--mode", "rpc",
    "--session", manager.getSessionFile(), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--no-approve", "--system-prompt", "Answer inventory questions accurately."];
  if (!installed) args.push("--no-extensions", "--extension", extension);
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [], waiters = new Set(); let buffer = "", stderr = "", exited = false, sequence = 0;
  child.stderr.on("data", text => { stderr = (stderr + text).slice(-20000); });
  child.stdout.on("data", text => {
    buffer += text; const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      events.push(event);
      for (const notify of [...waiters]) notify();
    }
  });
  child.on("exit", () => { exited = true; for (const notify of [...waiters]) notify(); });
  const closed = once(child, "close");
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await closed; clearTimeout(timer); });
  function wait(predicate, start = 0, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Pi RPC timed out: ${stderr}\n${JSON.stringify(events.slice(-5))}`)); }, timeout);
      function check() {
        const found = events.slice(start).find(predicate);
        if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); }
        else if (exited) { clearTimeout(timer); waiters.delete(check); reject(new Error(`Pi exited early: ${stderr}`)); }
      }
      waiters.add(check); check();
    });
  }
  async function send(command, timeout = 30000) {
    const id = `command-${++sequence}`, pending = wait(event => event.type === "response" && event.id === id, 0, timeout);
    child.stdin.write(JSON.stringify({ ...command, id }) + "\n"); return pending;
  }
  await send({ type: "get_state" });
  return { root, agent, manager, requests, behavior, events, child, send, wait,
    async prompt(message) {
      const start = events.length;
      const response = await send({ type: "prompt", message }); assert.equal(response.success, true, JSON.stringify(response));
      await wait(event => event.type === "agent_settled", start);
    },
    async rows() { return (await readFile(manager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse); },
    stderr: () => stderr,
  };
}
