/** One bounded cache for materialized archives and their search indexes. */
const limit = 64 * 1024 * 1024;
const owners = new Map<string, Map<string, { value: unknown; bytes: number }>>();
const identities = new WeakMap<object, string>();
let bytes = 0, sequence = 0;

export function archiveIdentity(snapshot: object, owner?: string): string {
  if (owner) identities.set(snapshot, owner);
  let value = identities.get(snapshot);
  if (!value) { value = `memory:${++sequence}`; identities.set(snapshot, value); }
  return value;
}
export function cacheDrop(owner: string): void {
  for (const entry of owners.get(owner)?.values() ?? []) bytes -= entry.bytes;
  owners.delete(owner);
}
export function cacheGet<T>(owner: string, key: string): T | undefined {
  const entries = owners.get(owner);
  if (!entries) return;
  owners.delete(owner); owners.set(owner, entries);
  return entries.get(key)?.value as T | undefined;
}
export function cachePut(owner: string, key: string, value: unknown, cost: number): void {
  if (cost > limit) { cacheDrop(owner); return; }
  const entries = owners.get(owner) ?? new Map();
  bytes -= entries.get(key)?.bytes ?? 0;
  entries.set(key, { value, bytes: cost }); bytes += cost;
  owners.delete(owner); owners.set(owner, entries);
  while (owners.size > 4 || bytes > limit) cacheDrop(owners.keys().next().value!);
}
export function triageCacheStats() { return { archives: owners.size, estimatedBytes: bytes, limitBytes: limit }; }
