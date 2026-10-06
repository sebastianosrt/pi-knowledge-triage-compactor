import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLayaClassifier, type LayaConfig } from "./classifier.ts";
import { run, setupEnvironment } from "./process.ts";

export const MODEL_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34";
export const UV_VERSION = "0.12.5";
const UV_SHA256 = "68a509da24b06b4223a1c0175fb5eb5bc79342b76cbeff0cfe51ac3f5b17b6b2";
const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
export const worker = join(scripts, "laya-classify.py");
const requirements = join(scripts, "laya-requirements.txt");

export function cacheHome(env = process.env): string {
  const root = env.PI_TRIAGE_HOME ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-knowledge-triage-compactor");
  if (!isAbsolute(root)) throw new Error("PI_TRIAGE_HOME and XDG_CACHE_HOME must be absolute paths");
  return root;
}

async function layout(root: string) {
  const hash = createHash("sha256").update(`setup-v1:${UV_VERSION}:python3.13:${MODEL_REVISION}`)
    .update(await readFile(requirements)).update(await readFile(worker)).update(await readFile(join(scripts, "install-laya-model.py"))).digest("hex").slice(0, 20);
  const directory = join(root, "runtimes", hash);
  return { directory, marker: join(directory, "ready.json"), hash,
    config: { python: join(directory, "venv/bin/python"), modelDirectory: join(directory, "model"), worker } };
}

export async function installedRuntime(root: string): Promise<LayaConfig | undefined> {
  const paths = await layout(root);
  try {
    const ready = JSON.parse(await readFile(paths.marker, "utf8"));
    if (ready.runtime !== paths.hash || ready.modelRevision !== MODEL_REVISION) return;
    for (const path of [paths.config.python, join(paths.config.modelDirectory, "model.safetensors"), join(paths.config.modelDirectory, "rl_agent_config.json"), join(paths.config.modelDirectory, "tokenizer/tokenizer_config.json")])
      if (!(await stat(path)).isFile()) return;
    return paths.config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}

/** Called only by the flock-protected setup subprocess. No shell scripts are downloaded. */
export async function installRuntime(root: string, signal: AbortSignal, progress: (text: string) => void, repair = false): Promise<void> {
  if (!repair && await installedRuntime(root)) { progress("Laya is already installed."); return; }
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Automatic Laya setup currently supports Linux x86_64 only");
  const paths = await layout(root), env = setupEnvironment(root);
  const staging = join(root, "uv-staging"), uv = join(root, `uv-${UV_VERSION}`, "uv");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    try { await stat(uv); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      progress(`Downloading uv ${UV_VERSION}…`);
      const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`, { signal });
      if (!response.ok || !response.body) throw new Error(`uv download failed: HTTP ${response.status}`);
      const archive = join(staging, "uv.tar.gz");
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive, { mode: 0o600 }), { signal });
      if (createHash("sha256").update(await readFile(archive)).digest("hex") !== UV_SHA256) throw new Error("uv download checksum mismatch");
      const unpacked = join(staging, "unpacked"); await mkdir(unpacked, { mode: 0o700 });
      await run("tar", ["-xzf", archive, "--strip-components=1", "-C", unpacked], { env, signal });
      await rename(unpacked, join(root, `uv-${UV_VERSION}`));
    }
    // A venv embeds its absolute location, so publish a ready marker rather than renaming it.
    await rm(paths.directory, { recursive: true, force: true });
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    progress("Preparing managed Python 3.13 and the CPU environment…");
    await run(uv, ["venv", "--python", "3.13", "--managed-python", join(paths.directory, "venv")], { env, signal });
    progress("Installing pinned Laya and CPU Torch dependencies…");
    await run(uv, ["pip", "sync", "--python", paths.config.python, "--torch-backend", "cpu", requirements], { env, signal });
    progress("Downloading the pinned Laya model (about 1.3 GB)…");
    await run(paths.config.python, ["-I", join(scripts, "install-laya-model.py"), paths.config.modelDirectory], { env, signal });
    progress("Checking local, offline inference…");
    const classifier = createLayaClassifier(paths.config);
    const result = await classifier.classify(["Use concise bullet points."], signal);
    if (!result[0]) throw new Error("Laya installation returned an invalid classification");
    signal.throwIfAborted();
    await writeFile(paths.marker + ".tmp", JSON.stringify({ runtime: paths.hash, modelRevision: MODEL_REVISION, installedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
    await rename(paths.marker + ".tmp", paths.marker);
    progress("Laya is ready; future classification runs offline.");
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function ensureRuntime(root: string, signal: AbortSignal, progress: (text: string) => void, repair = false): Promise<LayaConfig> {
  signal.throwIfAborted();
  const installed = await installedRuntime(root); if (installed && !repair) return installed;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lock = await open(join(root, "setup.lock"), "a", 0o600); await lock.close();
  progress("Preparing Laya; another Pi session may already be installing it…");
  // Kernel-owned lock: a crash or cancellation releases it, without stale PID races.
  await run("flock", ["--exclusive", "--wait", "1800", join(root, "setup.lock"), process.execPath,
    "--experimental-strip-types", join(scripts, "install-runtime.ts"), root, ...(repair ? ["--repair"] : [])], {
    env: { ...setupEnvironment(root), PI_TRIAGE_SETUP_CHILD: "1" }, signal, output: text => { for (const line of text.trim().split("\n")) if (line) progress(line); },
  });
  const ready = await installedRuntime(root);
  if (!ready) throw new Error("Laya setup finished without a valid ready marker");
  return ready;
}
