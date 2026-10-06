import { spawn } from "node:child_process";

/** A cancellable process group; setup tools must not survive a Pi reload. */
export async function run(command: string, args: string[], options: {
  env?: NodeJS.ProcessEnv; signal?: AbortSignal; input?: string;
  output?: (text: string) => void; timeout?: number;
} = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ownGroup = process.env.PI_TRIAGE_SETUP_CHILD !== "1";
    const child = spawn(command, args, { env: options.env, detached: ownGroup, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      try { if (ownGroup && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const abort = () => stop(new Error("Local setup aborted", { cause: options.signal?.reason }));
    const timer = setTimeout(() => stop(new Error("Local setup timed out")), options.timeout ?? 30 * 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.on("error", error => { cleanup(); reject(error); });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => {
      stdout = (stdout + text).slice(-65536);
      try { options.output?.(text); } catch (error) { stop(new Error("Setup progress handler failed", { cause: error })); }
    });
    child.stderr.on("data", text => { stderr = (stderr + text).slice(-8192); });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr.slice(-1500)}`));
      else resolve(stdout);
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });
}

/** Setup can download public packages, but does not receive model provider secrets. */
export function setupEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: root,
    LANG: "C.UTF-8", UV_NO_CONFIG: "1", UV_CACHE_DIR: `${root}/downloads`,
    UV_PYTHON_INSTALL_DIR: `${root}/python`, HF_HOME: `${root}/huggingface`,
    HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
