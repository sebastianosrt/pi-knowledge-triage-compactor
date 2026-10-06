import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ArchivedArtifact { path: string; sha256: string }
export const contentHash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");

export async function atomicContent(directory: string, file: string, body: string | Buffer): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, file);
  try {
    const existing = await readFile(target);
    if (contentHash(existing) !== contentHash(body)) throw new Error("Content-addressed file checksum mismatch");
    return target;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return target;
}

export async function archiveObservation(directory: string, payload: unknown): Promise<ArchivedArtifact> {
  const body = JSON.stringify(payload), sha256 = contentHash(body);
  return { path: await atomicContent(directory, `${sha256}.observation.json`, body), sha256 };
}

export async function importArtifact(artifact: ArchivedArtifact, directory: string): Promise<ArchivedArtifact> {
  const body = await readFile(artifact.path);
  if (contentHash(body) !== artifact.sha256) throw new Error("Observation artifact checksum mismatch");
  return { path: await atomicContent(directory, `${artifact.sha256}.observation.json`, body), sha256: artifact.sha256 };
}
