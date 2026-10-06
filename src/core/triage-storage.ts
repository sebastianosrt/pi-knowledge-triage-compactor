import { open, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { KnowledgeItem, SnapshotRef, TriageSnapshot } from "./knowledge-triage.ts";
import { countTypes, typeDecompose } from "./knowledge-triage.ts";
import { archiveIdentity, cacheDrop, cacheGet, cachePut } from "./triage-cache.ts";
import { atomicContent, contentHash, importArtifact } from "./triage-artifacts.ts";

interface Segment { file: string; sha256: string; count: number }
interface Manifest {
  version: 2; extractionVersion?: 2 | 3 | 4; segments: Segment[];
  retainedIds: string[]; partitionPolicy?: { taskId: string; budget: number };
  partitions?: TriageSnapshot["partitions"];
  reconstructionIncomplete?: boolean;
}
const layouts = new WeakMap<TriageSnapshot, { root: string; segments: Segment[] }>();
const hashPattern = /^[0-9a-f]{64}$/;
function directory(file: string, id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Pi session ID");
  return join(dirname(file), "triage", id);
}
function validRef(ref: { file: string; sha256: string }) {
  return typeof ref?.sha256 === "string" && hashPattern.test(ref.sha256) && ref.file === `${ref.sha256}.json` && basename(ref.file) === ref.file;
}
async function signature(files: string[]) {
  return (await Promise.all(files.map(async (file) => {
    const info = await stat(file, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }))).join(";");
}
function validateItems(items: unknown): asserts items is KnowledgeItem[] {
  if (!Array.isArray(items)) throw new Error("Invalid triage items");
  for (const item of items) {
    if (!item || !["id", "text", "taskId", "topic", "source"].every((key) => typeof item[key] === "string") ||
        !["constraint", "procedural", "belief", "preference", "episodic"].includes(item.type) ||
        !["user", "assistant", "tool", "summary", "custom"].includes(item.origin) || !Number.isFinite(item.order) ||
        (item.sources && (!Array.isArray(item.sources) || !item.sources.every((source: unknown) => typeof source === "string"))) ||
        (item.part !== undefined && (!Number.isInteger(item.part) || item.part < 0)) ||
        (item.parts !== undefined && (!Number.isInteger(item.parts) || item.parts <= item.part)) ||
        (item.artifact && (typeof item.artifact.path !== "string" || !isAbsolute(item.artifact.path) || !hashPattern.test(item.artifact.sha256))))
      throw new Error("Invalid triage item format");
  }
}
export async function writeSnapshot(file: string, id: string, snapshot: TriageSnapshot, previous?: TriageSnapshot): Promise<SnapshotRef> {
  const root = directory(file, id);
  validateItems(snapshot.items);
  const reusable = previous && Object.isFrozen(previous) && layouts.get(previous)?.root === root &&
    Object.isFrozen(previous.items) && previous.items.every((item, index) => Object.isFrozen(item) && item === snapshot.items[index]);
  const segments = reusable ? [...layouts.get(previous!)!.segments] : [];
  const start = reusable ? previous!.items.length : 0;
  let chunk: KnowledgeItem[] = [], size = 2;
  const flush = async () => {
    if (!chunk.length) return;
    const body = JSON.stringify(chunk), sha256 = contentHash(body), name = `${sha256}.json`;
    await atomicContent(join(root, "segments"), name, body);
    segments.push({ file: name, sha256, count: chunk.length });
    chunk = []; size = 2;
  };
  for (const item of snapshot.items.slice(start)) {
    const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (cost + 1 > 1024 * 1024) throw new Error("Triage record exceeds segment limit");
    if (chunk.length >= 512 || size + cost > 1024 * 1024) await flush();
    chunk.push(item); size += cost;
  }
  await flush();
  const manifest: Manifest = { version: 2, extractionVersion: snapshot.extractionVersion, segments,
    retainedIds: snapshot.retainedIds, partitionPolicy: snapshot.partitionPolicy,
    ...(!snapshot.partitionPolicy ? { partitions: snapshot.partitions } : {}),
    reconstructionIncomplete: snapshot.reconstructionIncomplete };
  const body = JSON.stringify(manifest), sha256 = contentHash(body), name = `${sha256}.json`;
  await atomicContent(root, name, body);
  layouts.set(snapshot, { root, segments });
  return { version: 2, file: name, sha256, counts: countTypes(snapshot.items), retained: snapshot.retainedIds.length };
}

async function artifactSource(file: string, artifacts: string, artifact: { path: string; sha256: string }, name = `${artifact.sha256}.observation.json`) {
  const candidates = [join(artifacts, name), artifact.path];
  const visited = new Set<string>();
  let current = file;
  for (;;) {
    for (const path of candidates.splice(0)) {
      try { await stat(path); return { ...artifact, path }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (visited.has(current) || visited.size >= 32) throw new Error("Invalid Pi session ancestry");
    visited.add(current);
    const own = await header(current);
    if (!own.parentSession || !isAbsolute(own.parentSession)) throw new Error("Missing observation artifact");
    current = own.parentSession;
    const parent = await header(current);
    // Support the default session tree and an explicitly supplied artifact directory.
    candidates.push(join(dirname(artifacts), parent.id, name), join(dirname(current), "artifacts", parent.id, name));
  }
}

async function header(file: string): Promise<{ id: string; parentSession?: string }> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(65536), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error("Invalid Pi session header");
    const parsed = JSON.parse(buffer.subarray(0, end).toString("utf8"));
    if (parsed.type !== "session" || typeof parsed.id !== "string") throw new Error("Invalid Pi session header");
    return parsed;
  } finally { await handle.close(); }
}

async function importFiles(file: string, id: string, ref: SnapshotRef, ancestors: Set<string>): Promise<void> {
  if (ancestors.has(file) || ancestors.size >= 32) throw new Error("Invalid Pi session ancestry");
  ancestors.add(file);
  const own = await header(file);
  if (own.id !== id || !own.parentSession || !isAbsolute(own.parentSession)) throw new Error("Missing triage snapshot and parent session");
  const parent = await header(own.parentSession), parentRoot = directory(own.parentSession, parent.id);
  const parentPath = join(parentRoot, ref.file);
  try { await stat(parentPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await importFiles(own.parentSession, parent.id, ref, ancestors);
  }
  const body = await readFile(parentPath);
  if (contentHash(body) !== ref.sha256) throw new Error("Triage snapshot checksum mismatch");
  const manifest = JSON.parse(body.toString());
  if (manifest.version === 2) {
    if (!Array.isArray(manifest.segments)) throw new Error("Invalid triage manifest");
    for (const segment of manifest.segments) {
      if (!validRef(segment)) throw new Error("Invalid triage segment reference");
      const data = await readFile(join(parentRoot, "segments", segment.file));
      if (contentHash(data) !== segment.sha256) throw new Error("Triage segment checksum mismatch");
      await atomicContent(join(directory(file, id), "segments"), segment.file, data);
    }
  }
  // Copy v1 bytes unchanged: converting here would invalidate the referenced checksum.
  await atomicContent(directory(file, id), ref.file, body);
}

export async function readSnapshot(file: string, id: string, ref: SnapshotRef, artifactDirectory?: string): Promise<TriageSnapshot> {
  if (![1, 2].includes(ref.version) || !validRef(ref)) throw new Error("Invalid triage snapshot reference");
  const root = directory(file, id), path = join(root, ref.file);
  const artifacts = artifactDirectory ?? join(dirname(file), "artifacts", id);
  const owner = `${path}:${artifacts}`;
  let info: string;
  try { info = await signature([path]); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await importFiles(file, id, ref, new Set()); info = await signature([path]);
  }
  const cached = cacheGet<{ files: string[]; signature: string; snapshot: TriageSnapshot }>(owner, "snapshot");
  if (cached && `${info};${await signature(cached.files)}` === cached.signature) return cached.snapshot;
  cacheDrop(owner);
  const body = await readFile(path, "utf8");
  if (contentHash(body) !== ref.sha256) throw new Error("Triage snapshot checksum mismatch");
  const parsed = JSON.parse(body);
  if (parsed.version !== ref.version || !Array.isArray(parsed.retainedIds) || !parsed.retainedIds.every((x: unknown) => typeof x === "string"))
    throw new Error("Invalid triage snapshot format");
  if (parsed.extractionVersion !== undefined && ![2, 3, 4].includes(parsed.extractionVersion)) throw new Error("Invalid extraction version");
  const files: string[] = [], segments: Segment[] = [];
  let items: KnowledgeItem[] = [], rawBytes = Buffer.byteLength(body);
  if (parsed.version === 1) {
    validateItems(parsed.items); items = parsed.items;
    if (!Array.isArray(parsed.partitions)) throw new Error("Invalid triage snapshot format");
  } else {
    if (!Array.isArray(parsed.segments)) throw new Error("Invalid triage manifest");
    for (const segment of parsed.segments) {
      if (!validRef(segment) || !Number.isInteger(segment.count) || segment.count < 1 || segment.count > 512) throw new Error("Invalid triage segment reference");
      const source = join(root, "segments", segment.file), data = await readFile(source, "utf8");
      if (Buffer.byteLength(data) > 1024 * 1024) throw new Error("Triage segment exceeds size limit");
      if (contentHash(data) !== segment.sha256) throw new Error("Triage segment checksum mismatch");
      const chunk = JSON.parse(data); validateItems(chunk);
      if (chunk.length !== segment.count) throw new Error("Triage segment count mismatch");
      items.push(...chunk); files.push(source); segments.push(segment); rawBytes += Buffer.byteLength(data);
    }
  }
  const imported = new Map<string, Awaited<ReturnType<typeof importArtifact>>>();
  let incomplete = Boolean(parsed.reconstructionIncomplete);
  for (const item of items) {
    if (!item.artifact && isAbsolute(item.source) && item.source.endsWith(".observation.json")) {
      try {
        // V1 references contain a call-ID filename, not a content hash. Preserve
        // that alias in each fork so a cold reload can resolve unchanged v1 bytes.
        const source = await artifactSource(file, artifacts, { path: item.source, sha256: "" }, basename(item.source));
        const body = await readFile(source.path);
        const alias = await atomicContent(artifacts, basename(item.source), body);
        files.push(alias);
        item.artifact = { path: alias, sha256: contentHash(body) };
        item.sources = [...new Set([item.source, ...(item.sources ?? [])])];
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as Error).message !== "Missing observation artifact") throw error;
        incomplete = true;
      }
    }
    if (!item.artifact) continue;
    let artifact = imported.get(item.artifact.sha256);
    if (!artifact) {
      artifact = await importArtifact(await artifactSource(file, artifacts, item.artifact), artifacts);
      imported.set(artifact.sha256, artifact);
    }
    item.source = artifact.path; item.artifact = artifact;
  }
  const policy = parsed.partitionPolicy;
  if (policy && (typeof policy.taskId !== "string" || !Number.isFinite(policy.budget) || policy.budget < 0)) throw new Error("Invalid partition policy");
  const snapshot: TriageSnapshot = { version: 1, extractionVersion: parsed.extractionVersion, items,
    partitions: policy ? typeDecompose(items.filter(x => x.taskId === policy.taskId), policy.budget) : parsed.partitions ?? [],
    retainedIds: parsed.retainedIds, ...(policy ? { partitionPolicy: policy } : {}),
    ...(incomplete ? { reconstructionIncomplete: true } : {}) };
  if (!Array.isArray(snapshot.partitions) || snapshot.partitions.some(partition => !partition || !Array.isArray(partition.itemIds) ||
    !partition.itemIds.every(id => typeof id === "string") || typeof partition.taskId !== "string" || typeof partition.topic !== "string" || !Number.isFinite(partition.tokens)))
    throw new Error("Invalid triage partitions");
  for (const item of items) { if (item.sources) Object.freeze(item.sources); if (item.artifact) Object.freeze(item.artifact); Object.freeze(item); }
  for (const partition of snapshot.partitions) { Object.freeze(partition.itemIds); Object.freeze(partition); }
  Object.freeze(items); Object.freeze(snapshot.partitions); Object.freeze(snapshot.retainedIds); Object.freeze(snapshot);
  files.push(...[...imported.values()].map(x => x.path));
  const sig = `${info};${await signature(files)}`;
  archiveIdentity(snapshot, owner);
  if (parsed.version === 2) layouts.set(snapshot, { root, segments });
  cachePut(owner, "snapshot", { files, signature: sig, snapshot }, rawBytes * 3);
  return snapshot;
}
