import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { KnowledgeClassifier, KnowledgeType } from "../core/knowledge-triage.ts";

export interface LayaConfig {
  python: string;
  worker: string;
  modelDirectory: string;
}

const types: KnowledgeType[] = ["constraint", "procedural", "belief", "preference", "episodic"];
const probability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function classification(result: any): KnowledgeType | undefined {
  const choice = result?.answers?.knowledge_type;
  const safety = result?.answers?.safety_critical;
  // Never relax an instruction if the model missed text or could not distinguish options.
  if (result?.usage?.truncated !== false || result?.usage?.options ||
      !types.includes(choice?.choice) || !probability(choice?.answer_confidence) ||
      !probability(safety?.noul) || !probability(safety?.answer_confidence)) return undefined;
  if (safety.noul >= 0.5 || safety.answer_confidence < 0.7 || choice.answer_confidence < 0.7)
    return "constraint";
  return choice.choice;
}

/** Load once per compaction batch, then release the model and its CPU memory. */
export function createLayaClassifier(config: LayaConfig): KnowledgeClassifier {
  if (![config.python, config.worker, config.modelDirectory].every(isAbsolute))
    throw new Error("Local Laya interpreter, worker and model paths must be absolute");
  const sessions = new Map<string, Map<string, KnowledgeType>>();
  let previousSignature = "", fingerprint = "";
  async function identity(): Promise<string> {
    // Weight files are immutable in normal use. Their inode/size/timestamps identify
    // local replacements without hashing hundreds of megabytes on each batch.
    const files = [config.python, config.worker, ...await readdir(config.modelDirectory).then(names => names.sort().map(name => join(config.modelDirectory, name)))];
    const signature = JSON.stringify(await Promise.all(files.map(async file => {
      const info = await stat(file, { bigint: true });
      return [file, String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
    })));
    if (signature !== previousSignature) {
      fingerprint = createHash("sha256").update("laya-classification-policy-v2").update(signature).update(await readFile(config.worker)).digest("hex");
      previousSignature = signature;
    }
    return fingerprint;
  }
  async function runBatch(texts: string[], signal?: AbortSignal): Promise<(KnowledgeType | undefined)[]> {
      signal?.throwIfAborted();
      if (!texts.length) return Promise.resolve([]);
      if (texts.length > 16 || texts.some((text) => text.length > 500))
        throw new Error("Local Laya classification batch exceeds its input limit");
      return new Promise((resolve, reject) => {
        const child = spawn(config.python, ["-I", config.worker, config.modelDirectory], {
          // No inherited provider credentials or network configuration reach the classifier.
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: "/tmp",
            USER: "laya",
            LOGNAME: "laya",
            HF_HOME: `/tmp/pi-triage-laya-${process.getuid?.() ?? "user"}/huggingface`,
            TORCHINDUCTOR_CACHE_DIR: `/tmp/pi-triage-laya-${process.getuid?.() ?? "user"}/torch`,
            LANG: "C.UTF-8",
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            HF_HUB_DISABLE_TELEMETRY: "1",
            USE_TF: "0",
            TOKENIZERS_PARALLELISM: "false",
            OMP_NUM_THREADS: "4",
            MKL_NUM_THREADS: "4",
          },
          stdio: ["pipe", "pipe", "ignore"],
        });
        let settled = false;
        let stdout = "";
        let bytes = 0;
        const finish = (error?: Error, results?: (KnowledgeType | undefined)[]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          if (error) { child.kill("SIGKILL"); reject(error); }
          else resolve(results!);
        };
        const abort = () => finish(new Error("Local Laya classification aborted"));
        const timeout = setTimeout(() => finish(new Error("Local Laya classification timed out")), 120_000);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 1024 * 1024) finish(new Error("Local Laya output exceeded 1 MiB"));
          else stdout += chunk;
        });
        child.stdin.on("error", () => finish(new Error("Local Laya input failed")));
        child.on("error", () => finish(new Error("Local Laya worker failed to start")));
        child.on("close", (code) => {
          if (settled) return;
          if (code !== 0) { finish(new Error("Local Laya worker failed; check its installation and model directory")); return; }
          try {
            const payload = JSON.parse(stdout);
            if (!Array.isArray(payload?.results) || payload.results.length !== texts.length)
              throw new Error("Malformed Local Laya response");
            finish(undefined, payload.results.map(classification));
          } catch {
            finish(new Error("Malformed local Laya classification response"));
          }
        });
        child.stdin.end(JSON.stringify({ texts }));
      });
  }
  return {
    async classify(texts, signal, session) {
      signal?.throwIfAborted();
      if (texts.length > 16 || texts.some(text => typeof text !== "string" || text.length > 500))
        throw new Error("Local Laya classification batch exceeds its input limit");
      if (!texts.length) return [];
      // Callers without a session cannot share decisions across unrelated contexts.
      if (!session) return runBatch(texts, signal);
      const version = await identity(); signal?.throwIfAborted();
      const memo = sessions.get(session) ?? new Map<string, KnowledgeType>();
      sessions.delete(session); sessions.set(session, memo);
      while (sessions.size > 4) sessions.delete(sessions.keys().next().value!);
      const key = (text: string) => version + "\0" + text;
      const missing = [...new Set(texts.filter(text => !memo.has(key(text))))];
      const decisions = new Map<string, KnowledgeType | undefined>();
      if (missing.length) {
        const values = await runBatch(missing, signal); signal?.throwIfAborted();
        missing.forEach((text, i) => {
          decisions.set(text, values[i]);
          if (values[i] && types.includes(values[i]!)) memo.set(key(text), values[i]!);
        });
      }
      const result = texts.map(text => {
        const value = memo.get(key(text)) ?? decisions.get(text);
        if (value) { memo.delete(key(text)); memo.set(key(text), value); }
        return value;
      });
      while (memo.size > 256) memo.delete(memo.keys().next().value!);
      return result;
    },
  };
}
