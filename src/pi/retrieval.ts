import { typeRetrieve, type KnowledgeItem, type TriageSnapshot } from "../core/knowledge-triage.ts";

export interface RetrievalArgs { query: string; limit?: number; offset?: number; include_retained?: boolean }
const present = ({ id, type, origin, topic, source, text, sources, source_entry_id, source_kind, part, parts }: KnowledgeItem) =>
  ({ id, type, origin, topic, source, text, sources, source_entry_id, source_kind, part, parts });

/** Compute pagination after fitting the entire serialized envelope, including its cursor. */
export function retrievalPage(snapshot: TriageSnapshot | undefined, taskId: string, args: RetrievalArgs,
  archiveSha: string | null = null, nativeGap = false) {
  const limit = args.limit ?? 10, offset = args.offset ?? 0;
  const exclude = args.include_retained || nativeGap ? new Set<string>() : new Set(snapshot?.retainedIds);
  const found = snapshot ? typeRetrieve(snapshot, taskId, args.query, limit, offset, exclude)
    : { pinned: [], matches: [], total: 0, incomplete: false };
  const result = {
    kind: "triage_retrieval", task_id: taskId, archive_available: Boolean(snapshot),
    archive_coverage: !snapshot ? "none" : nativeGap ? "before_native_fallback" : snapshot.reconstructionIncomplete ? "incomplete_reconstruction" : "compacted_history",
    pinned: found.pinned.map(present), matches: found.matches.map(present), total: found.total, offset,
    next_offset: null as number | null, next_page: null as RetrievalArgs | null,
    retained_excluded: !args.include_retained && !nativeGap,
    incomplete: found.incomplete, archive_sha256: archiveSha, evidence_status: "context_hint_verify_source",
    hint: !snapshot ? "No compaction archive exists yet. Use supplied context and mark missing facts unknown; do not repeat until an archive is created."
      : nativeGap ? "This archive predates native fallback. Newer summarized records are not guaranteed archived; retained records are included."
      : args.include_retained ? undefined : "Already retained records are excluded. Set include_retained=true and offset=0 to retrieve them.",
  };
  const serialize = () => {
    result.incomplete = offset + result.matches.length < found.total;
    result.next_offset = result.incomplete ? offset + result.matches.length : null;
    result.next_page = result.next_offset === null ? null : { query: args.query, limit, offset: result.next_offset, include_retained: Boolean(args.include_retained) };
    return JSON.stringify(result);
  };
  let text = serialize();
  while (Buffer.byteLength(text) > 32768 && result.matches.length) { result.matches.pop(); text = serialize(); }
  if (Buffer.byteLength(text) > 32768) throw new Error("COMPACTION_UNSAFE: in-scope rules exceed the retrieval output limit");
  if (!result.matches.length && found.matches.length) throw new Error("COMPACTION_UNSAFE: matching item and rules exceed retrieval output limit");
  return { result, text };
}
