import { estimateTokens, sessionEntryToContextMessages, type ContextEvent, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];
type Manager = ExtensionContext["sessionManager"] & {
  buildSessionContext?: (options?: { model?: ExtensionContext["model"] }) => { messages: Message[] };
};
export const hostName = (ctx: ExtensionContext): "pi" | "omp" =>
  typeof ctx.sessionManager.buildSessionProjection === "function" ? "pi" : "omp";
export function systemPrompt(ctx: ExtensionContext): string {
  const value: unknown = ctx.getSystemPrompt?.() ?? "";
  return Array.isArray(value) ? value.join("\n") : String(value);
}
export const messageIdentity = (message: Message) => JSON.stringify([message.role, message.timestamp,
  "customType" in message ? message.customType : null, "toolCallId" in message ? message.toolCallId : null]);

/** OMP owns filtering/reordering. Recover provenance without reimplementing its context builder. */
export function sessionProjection(ctx: ExtensionContext, branch: SessionEntry[]) {
  const manager = ctx.sessionManager as Manager;
  if (typeof manager.buildSessionProjection === "function") return manager.buildSessionProjection();
  if (!manager.buildSessionContext) throw new Error("Unsupported session context API");
  const messages = manager.buildSessionContext({ model: ctx.model }).messages;
  // Exclude summarized ancestors before matching: identical messages can occur
  // in old and retained turns. OMP's canonical output still decides visibility.
  const compactIndex = branch.findLastIndex(entry => entry.type === "compaction");
  const resetIndex = branch.findLastIndex(entry => (entry as { type: string }).type === "reset_boundary");
  const compact = branch[compactIndex];
  let eligible = branch;
  if (resetIndex > compactIndex) eligible = branch.slice(resetIndex + 1);
  else if (compact?.type === "compaction") {
    const cut = branch.findIndex(entry => entry.id === compact.firstKeptEntryId);
    eligible = [compact, ...(cut >= 0 ? branch.slice(cut, compactIndex).filter(entry => entry.type !== "compaction") : []),
      ...branch.slice(compactIndex + 1)];
  }
  const candidates = eligible.flatMap(sourceEntry => sessionEntryToContextMessages(sourceEntry)
    .map((message, ordinal) => ({ sourceEntry, message, ordinal, identity: messageIdentity(message), full: JSON.stringify(message) })));
  const entries: { sourceEntry: SessionEntry; messages: Message[] }[] = [];
  const used = new Set<typeof candidates[number]>();
  for (const message of messages) {
    const full = JSON.stringify(message), identity = messageIdentity(message);
    const exact = candidates.filter(candidate => candidate.full === full);
    const matches = exact.length ? exact : candidates.filter(candidate => candidate.identity === identity);
    if (matches.length > 1) {
      const occurrences = messages.filter(value => exact.length ? JSON.stringify(value) === full : messageIdentity(value) === identity);
      if (occurrences.length !== matches.length) throw new Error("COMPACTION_UNSAFE: ambiguous OMP source anchor");
    }
    if (!matches.length) continue; // Host-generated context remains in the request, but is not an anchor.
    const match = matches.find(candidate => !used.has(candidate));
    if (!match) throw new Error("COMPACTION_UNSAFE: repeated OMP source anchor");
    used.add(match);
    // OMP's per-entry mapper currently emits one message. Never invent ordinals for a new shape.
    if (match.ordinal !== 0) throw new Error("COMPACTION_UNSAFE: unsupported OMP source projection");
    entries.push({ sourceEntry: match.sourceEntry, messages: [message] });
  }
  return { messages, entries };
}

export function compactionAllowance(ctx: ExtensionContext, preparation: {
  settings: { reserveTokens?: number; keepRecentTokens: number }; recentMessages?: Message[];
}): number {
  const finite = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
  const recent = hostName(ctx) === "omp" && preparation.recentMessages
    ? preparation.recentMessages.reduce((sum, message) => sum + estimateTokens(message), 0)
    : finite(preparation.settings.keepRecentTokens, 20000);
  return Math.min(12000, (ctx.model?.contextWindow ?? 131072) -
    finite(preparation.settings.reserveTokens, 16384) - recent - 4096 -
    (hostName(ctx) === "omp" ? Math.ceil(systemPrompt(ctx).length / 4) : 0));
}

export class CompactionDeadline extends Error {}
/** Race as well as abort: an uncooperative worker cannot hold the hook past the host's budget. */
export async function withinDeadline<T>(work: (signal: AbortSignal) => Promise<T>, signals: AbortSignal[], ms = 25000): Promise<T> {
  const controller = new AbortController(), signal = AbortSignal.any([...signals, controller.signal]);
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([work(signal), new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        const error = new CompactionDeadline("Local compaction exceeded the OMP time budget");
        controller.abort(error); reject(error);
      }, ms);
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
