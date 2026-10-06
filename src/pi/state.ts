import { dirname, join } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SnapshotRef } from "../core/knowledge-triage.ts";

export interface ArchiveState {
  taskId: string;
  ref?: SnapshotRef;
  nativeGap: boolean;
}

/** Only the active branch can supply state or an archive reference. */
export function branchState(entries: SessionEntry[], sessionId: string): ArchiveState {
  let taskId = sessionId;
  for (const entry of [...entries].reverse()) {
    if (entry.type === "custom" && entry.customType === "knowledge_triage_state" && typeof (entry.data as any)?.task_id === "string") {
      taskId = (entry.data as any).task_id; break;
    }
    if (entry.type === "compaction" && typeof (entry.details as any)?.task_id === "string") {
      taskId = (entry.details as any).task_id; break;
    }
  }
  const latest = [...entries].reverse().find(entry => entry.type === "compaction");
  if (!latest || latest.type !== "compaction") return { taskId, nativeGap: false };
  const ref = (latest.details as any)?.triage as SnapshotRef | undefined;
  if (ref) return { taskId, ref, nativeGap: false };
  const bridge = [...entries].reverse().find(entry => entry.type === "custom" &&
    entry.customType === "knowledge_triage_fallback" && (entry.data as any)?.compaction_id === latest.id);
  return { taskId, nativeGap: true, ref: bridge ? (bridge as any).data.triage ?? undefined : undefined };
}

export function sessionPaths(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile(), id = ctx.sessionManager.getSessionId();
  return { file, id, artifacts: file ? join(dirname(file), "artifacts", id) : undefined };
}

export function messageText(message: object): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(part => part?.type === "text").map(part => part.text).join("\n") : "";
}
