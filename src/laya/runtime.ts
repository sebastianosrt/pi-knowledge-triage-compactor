import { isAbsolute } from "node:path";
import type { KnowledgeClassifier } from "../core/knowledge-triage.ts";
import { createLayaClassifier } from "./classifier.ts";
import { cacheHome, ensureRuntime, installedRuntime, worker } from "./setup.ts";

export class LayaUnavailable extends Error {}

/** One instance per extension registration. Failed setup is retried only explicitly or in a new session. */
export class LayaRuntime implements KnowledgeClassifier {
  private lifetime = new AbortController();
  private pending?: Promise<KnowledgeClassifier>;
  private classifier?: KnowledgeClassifier;
  private failure?: string;
  private progress: (text: string) => void = () => {};
  private generation = 0;

  setProgress(progress: (text: string) => void) { this.progress = progress; }
  reset() {
    this.lifetime.abort(); this.lifetime = new AbortController();
    this.pending = undefined; this.classifier = undefined; this.failure = undefined; this.generation++;
  }
  shutdown() { this.lifetime.abort(); }
  async status() {
    const custom = Boolean(process.env.PI_TRIAGE_PYTHON || process.env.PI_TRIAGE_MODEL_DIR);
    return { home: cacheHome(), ready: !this.failure && Boolean(this.classifier || (!custom && await installedRuntime(cacheHome()))),
      setup_running: Boolean(this.pending), last_error: this.failure ?? null,
      custom_runtime: custom,
      fallback: "pi", model_revision: "1720e3e3357cfe1e281542e223f8273b0890ca34" };
  }
  private async get(signal?: AbortSignal): Promise<KnowledgeClassifier> {
    signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    if (this.classifier) return this.classifier;
    if (this.failure) throw new LayaUnavailable(this.failure);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    this.pending = (async () => {
      await Promise.resolve(); // Assign pending before even a custom runtime can finish.
      try {
        let python = process.env.PI_TRIAGE_PYTHON, modelDirectory = process.env.PI_TRIAGE_MODEL_DIR;
        if (python || modelDirectory) {
          if (!python || !modelDirectory || !isAbsolute(python) || !isAbsolute(modelDirectory))
            throw new Error("Set both PI_TRIAGE_PYTHON and PI_TRIAGE_MODEL_DIR to absolute paths");
          combined.throwIfAborted();
          this.classifier = createLayaClassifier({ python, modelDirectory, worker });
        } else {
          const config = await ensureRuntime(cacheHome(), combined, text => this.progress(text));
          combined.throwIfAborted();
          this.classifier = createLayaClassifier(config);
        }
        combined.throwIfAborted();
        return this.classifier;
      } catch (error) {
        combined.throwIfAborted();
        this.failure = String(error).slice(0, 1800);
        throw new LayaUnavailable(this.failure);
      } finally { if (generation === this.generation) this.pending = undefined; }
    })();
    return this.pending;
  }
  async setup(signal?: AbortSignal) {
    const repair = Boolean(this.failure) && !process.env.PI_TRIAGE_PYTHON && !process.env.PI_TRIAGE_MODEL_DIR;
    this.failure = undefined;
    if (repair) {
      this.classifier = undefined;
      const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
      try { await ensureRuntime(cacheHome(), combined, text => this.progress(text), true); }
      catch (error) { combined.throwIfAborted(); this.failure = String(error); throw new LayaUnavailable(this.failure); }
    }
    await this.classify(["Use concise bullet points."], signal, "setup");
  }
  async classify(texts: string[], signal?: AbortSignal, session?: string) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    try {
      const classifier = await this.get(combined);
      const result = await classifier.classify(texts, combined, session);
      if (result.length !== texts.length || result.some(value => value === undefined)) throw new Error("Laya returned an invalid or truncated classification");
      return result;
    } catch (error) {
      combined.throwIfAborted();
      this.failure = String(error).slice(0, 1800);
      this.classifier = undefined;
      throw new LayaUnavailable(this.failure);
    }
  }
}
