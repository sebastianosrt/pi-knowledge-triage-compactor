import { createHash } from "node:crypto";
import type { ContextEvent, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { sessionProjection, messageIdentity } from "./host.ts";

type Message = ContextEvent["messages"][number];
export const INJECTION = "knowledge_triage_injection";
export const BINDING = "knowledge_triage_injection_use";
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export interface Anchor { entry_id: string; message_index: number }
export interface Injection {
  version: 1; id: string; task_id: string; key: string; archive_sha256: string;
  query_sha256: string; anchor: Anchor; content: string; content_sha256: string; timestamp: number;
}
const anchorKey = (a: Anchor) => `${a.entry_id}:${a.message_index}`;
const identity = messageIdentity;
const fingerprint = (message: Message) => sha256(JSON.stringify(message));

/** Resolve source-entry anchors against Pi's request projection, including preceding extension edits.
 * Full equality is preferred; a unique role/timestamp identity also survives a context-only rewrite.
 * Never guess an insertion point when another extension made an anchor ambiguous.
 */
export function injectionContext(ctx: ExtensionContext, input: Message[], branch: SessionEntry[], taskId: string) {
  const messages = input.filter(message => !(message.role === "custom" &&
    message.customType === "knowledge_triage_context" && (message.details as any)?.triage_injection_id));
  const projection = sessionProjection(ctx, branch);
  const positions = new Map<string, number>();
  const visible = new Set<string>();
  const full = messages.map(fingerprint), identities = messages.map(identity);
  let cursor = -1;
  for (const entry of projection.entries) {
    entry.messages.forEach((message, ordinal) => {
      if (message.role === "system") return;
      const key = anchorKey({ entry_id: entry.sourceEntry.id, message_index: ordinal });
      visible.add(key);
      const hash = fingerprint(message);
      let index = full.findIndex((value, i) => i > cursor && value === hash);
      if (index < 0) {
        const candidates = identities.flatMap((value, i) => i > cursor && value === identity(message) ? [i] : []);
        if (candidates.length === 1) index = candidates[0];
      }
      if (index >= 0) { positions.set(key, index); cursor = index; }
    });
  }
  const records: Injection[] = [], uses = new Map<string, string | null>();
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === INJECTION) {
      const r = entry.data as Injection;
      if (r?.task_id !== taskId) continue;
      if (r.version !== 1 || typeof r.id !== "string" || typeof r.key !== "string" ||
          typeof r.content !== "string" || r.content.length > 8000 ||
          r.content_sha256 !== sha256(r.content) || !r.anchor ||
          typeof r.anchor.entry_id !== "string" || !Number.isInteger(r.anchor.message_index) || r.anchor.message_index < 0 ||
          !Number.isFinite(r.timestamp)) throw new Error("COMPACTION_UNSAFE: corrupt archived-context injection");
      const key = anchorKey(r.anchor);
      if (!visible.has(key)) continue; // Compacted or explicitly omitted anchors retire their derived context.
      if (!positions.has(key)) throw new Error("COMPACTION_UNSAFE: archived-context anchor is ambiguous");
      records.push(r); uses.set(r.key, r.id);
    } else if (entry.customType === BINDING) {
      const r = entry.data as { version: number; task_id: string; key: string; injection_id: string | null };
      if (r?.task_id === taskId && r.version === 1 && typeof r.key === "string") uses.set(r.key, r.injection_id);
    }
  }
  const byId = new Map(records.map(r => [r.id, r]));
  const known = (key: string) => uses.has(key) && (uses.get(key) === null || byId.has(uses.get(key)!));
  function render(extra?: Injection): Message[] {
    const after = new Map<number, Injection[]>();
    for (const record of extra ? [...records, extra] : records) {
      const index = positions.get(anchorKey(record.anchor));
      if (index === undefined) throw new Error("COMPACTION_UNSAFE: archived-context anchor disappeared");
      const bucket = after.get(index) ?? [];
      bucket.push(record); after.set(index, bucket);
    }
    return messages.flatMap((message, index) => [message, ...(after.get(index) ?? []).map(record => ({
      role: "custom" as const, customType: "knowledge_triage_context", content: record.content,
      display: false, timestamp: record.timestamp, details: { triage_injection_id: record.id },
    }))]);
  }
  function lastAnchor(): Anchor | undefined {
    let best: { anchor: Anchor; index: number } | undefined;
    for (const entry of projection.entries) entry.messages.forEach((_message, ordinal) => {
      const anchor = { entry_id: entry.sourceEntry.id, message_index: ordinal }, index = positions.get(anchorKey(anchor));
      if (index !== undefined && (!best || index > best.index)) best = { anchor, index };
    });
    return best?.anchor;
  }
  return { messages, records, known, render, lastAnchor };
}
