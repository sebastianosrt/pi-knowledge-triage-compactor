/**
 * Knowledge Triage for Pi sessions. Adapted from the Apache-2.0 reference at
 * https://github.com/searchsim-org/cikm26-knowledge-triage (a6ceb01a).
 * Standalone adaptation: generic session state and explicit native fallback (2026).
 * Classification uses local Laya; retention, partitioning and retrieval are local.
 */
import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { markdownLines, withoutInlineCode } from "./markdown-context.ts";
import { archiveObservation, type ArchivedArtifact } from "./triage-artifacts.ts";
export { readSnapshot, writeSnapshot } from "./triage-storage.ts";
export { typeRetrieve } from "./triage-retrieval.ts";

export type KnowledgeType = "constraint" | "procedural" | "belief" | "preference" | "episodic";
export type Origin = "user" | "assistant" | "tool" | "summary" | "custom";
export interface KnowledgeItem {
  id: string;
  text: string;
  type: KnowledgeType;
  taskId: string;
  topic: string;
  source: string;
  origin: Origin;
  order: number;
  decidedBy: "rule" | "laya" | "jev" | "conservative" | "source";
  part?: number;
  parts?: number;
  source_entry_id?: string;
  source_kind?: string;
  sources?: string[];
  artifact?: ArchivedArtifact;
}
export interface Partition {
  taskId: string;
  topic: string;
  itemIds: string[];
  tokens: number;
}
export interface TriageSnapshot {
  version: 1;
  extractionVersion?: 2 | 3 | 4;
  items: KnowledgeItem[];
  partitions: Partition[];
  retainedIds: string[];
  partitionPolicy?: { taskId: string; budget: number };
  reconstructionIncomplete?: boolean;
}
export interface SnapshotRef {
  version: 1 | 2;
  file: string;
  sha256: string;
  counts: Record<KnowledgeType, number>;
  retained: number;
}
export interface TriageStats {
  layaCalls: number;
  layaFailures: number;
  layaFailureReason?: string;
  conservative: number;
  reconstructionIncomplete?: boolean;
}

export interface KnowledgeClassifier {
  classify(texts: string[], signal?: AbortSignal, session?: string): Promise<(KnowledgeType | undefined)[]>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const tokenEstimate = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const itemTokens = (item: KnowledgeItem) => tokenEstimate(renderItems([item])) + 1;
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const itemKey = (item: Pick<KnowledgeItem, "taskId" | "origin" | "topic" | "text" | "source" | "part">) =>
  JSON.stringify([item.taskId, item.origin, item.topic, item.text, item.part, item.source]);
const types: KnowledgeType[] = ["constraint", "procedural", "belief", "preference", "episodic"];

function textOf(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    : "";
}

function splitLines(text: string): { text: string; topic: string; code: boolean }[] {
  const result: { text: string; topic: string; code: boolean }[] = [];
  let topic = "root";
  let fenced: string[] = [];
  let literalIndent: number | undefined;
  let paragraph: string[] = [];
  let paragraphCode = false;
  const flush = () => {
    if (paragraph.length) result.push({ text: paragraph.join("\n"), topic, code: paragraphCode });
    paragraph = [];
  };
  for (const annotated of markdownLines(text)) {
    const raw = annotated.text;
    const line = raw.trim();
    if (annotated.fence) {
      flush();
      fenced.push(raw);
      continue;
    }
    if (fenced.length) { result.push({ text: fenced.join("\n"), topic, code: true }); fenced = []; }
    if (!line) { flush(); continue; }
    const indent = raw.length - raw.trimStart().length;
    if (literalIndent !== undefined) {
      if (indent > literalIndent) {
        paragraph.push(raw);
        continue;
      }
      flush();
      literalIndent = undefined;
    }
    if (/^\s*[\w-]+\s*:\s*[|>][-+]?\s*$/.test(raw)) {
      literalIndent = indent;
      flush();
      paragraphCode = true;
      paragraph.push(raw);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading && !annotated.literal) {
      flush();
      topic = norm(heading[1]).slice(0, 80) || "root";
      result.push({ text: raw, topic, code: false });
      continue;
    }
    const dataTopic = /^(?:source(?: code| context| snippet)?|supplied source|input data|example|fixture)$|untrusted data/i.test(topic);
    const listItem = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(raw);
    const continuation = paragraph.length && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(paragraph[0]) && indent >= 2;
    const code = annotated.literal || dataTopic || (indent >= 4 && !continuation) ||
      /^\s*(?:def|class|function|const|let|var|import|require|SELECT|INSERT)\b/.test(raw) ||
      /^\s*[\[{}]|^\s*\/\//.test(raw);
    if (listItem || (paragraph.length && code !== paragraphCode)) flush();
    paragraphCode = code;
    paragraph.push(raw);
  }
  flush();
  if (fenced.length) result.push({ text: fenced.join("\n"), topic, code: true });
  return result;
}

function classifyRule(text: string, origin: Origin, code: boolean): {
  type: KnowledgeType;
  ambiguous: boolean;
} {
  if (origin === "tool" || origin === "assistant" || origin === "custom" || code)
    return { type: origin === "tool" ? "episodic" : "belief", ambiguous: false };
  text = text.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "");
  const command = /^\s*(?:run|execute|install|build|test|deploy)\s+[`\w]/i.test(text);
  text = withoutInlineCode(text);
  if (origin === "summary") {
    if (/\b(?:never|must not|do not|shall not|forbidden|mandatory|required)\b/i.test(text))
      return { type: "constraint", ambiguous: false };
    return { type: "belief", ambiguous: false };
  }
  if (/\b(?:never|must not|do not|shall not|cannot|forbidden|mandatory|required)\b/i.test(text))
    return { type: "constraint", ambiguous: false };
  if (/\b(?:always|ensure|guarantee|require)\b.*\b(?:must|shall)\b/i.test(text))
    return { type: "constraint", ambiguous: false };
  if (command ||
      /\b(?:npm|yarn|pip|cargo|go)\s+\w+/i.test(text))
    return { type: "procedural", ambiguous: false };
  if (/\b(?:yesterday|today|last\s+(?:week|session|time)|recently)\b/i.test(text))
    return { type: "episodic", ambiguous: false };
  if (/\b(?:prefer|recommend|suggest|ideally|typically|usually)\b/i.test(text))
    return { type: "preference", ambiguous: false };
  // Imperatives, output contracts and declarative safety facts are hard until adjudicated.
  const ambiguous = /^(?:\s*[-*+]\s*)?(?:return|include|preserve|keep|avoid|use|follow|check|verify|show|provide|output|maintain|record|recover|classify|treat|consider|allow|deny|limit|only|please)\b/i.test(text) ||
    /\b(?:contract|policy|permission|credential|secret|sensitive|read.only|unsafe|security|safety|deadline|allerg|contraindicat|private)\b/i.test(text);
  return { type: ambiguous ? "constraint" : "belief", ambiguous };
}

function mayClassifyInstruction(text: string, topic: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (/^(?:source(?: code| context| snippet)?|supplied source|input data|example|fixture)$|untrusted data/i.test(topic)) return false;
  if (/\b(?:bearer|api[_ -]?key|password|private[_ -]?key|token)\b\s*[:=]/i.test(text)) return false;
  if (/\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9+/]{32,}={0,2})\b/.test(text)) return false;
  if (/^\s{4,}|^\s*(?:#|\/\/|\/\*|\*|--)|[{};<>]|\b(?:def|class|function|const|let|var|import|SELECT|INSERT)\b/.test(text)) return false;
  const imperative = /^(?:\s*[-*+]\s*)?(?:return|include|preserve|keep|avoid|use|follow|check|verify|show|provide|output|maintain|record|recover|classify|treat|consider|allow|deny|limit|only|please)\b/i.test(text);
  return imperative || /\b(?:rules|policy|constraints|instructions|requirements|output contract)\b/i.test(topic);
}

export async function collectItems(
  entries: SessionEntry[],
  firstKeptEntryId: string,
  currentTaskId: string,
  previous: TriageSnapshot | undefined,
  previousSummary: string | undefined,
  classifier: KnowledgeClassifier | undefined,
  signal?: AbortSignal,
  toolArtifactDirectory?: string,
  classifierSession?: string,
): Promise<{ items: KnowledgeItem[]; stats: TriageStats }> {
  signal?.throwIfAborted();
  const stats: TriageStats = { layaCalls: 0, layaFailures: 0, conservative: 0 };
  let lastCompaction = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") {
      lastCompaction = i;
      break;
    }
  }
  const oldCut = lastCompaction >= 0 ? (entries[lastCompaction] as any).firstKeptEntryId : undefined;
  const oldCutIndex = oldCut ? entries.findIndex((entry) => entry.id === oldCut) : 0;
  // Native summaries do not contain an exact archive. Rebuild from raw ancestors
  // when migrating, rather than silently losing everything before their cut.
  const start = previous?.extractionVersion === 4 ? oldCutIndex : 0;
  const end = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (start < 0 || end < start) throw new Error("Invalid Pi compaction cut point");
  const replayedSources = new Set(entries.slice(start, end).map((entry) => `session-entry:${entry.id}`));
  const replayedTools = new Set(entries.slice(start, end).filter((entry: any) => entry.message?.role === "toolResult")
    .map((entry: any) => `${sha256(entry.message.toolCallId ?? entry.id)}.observation.json`));
  const items = (previous?.items ?? []).filter((item) =>
    previous?.extractionVersion === 4 || !([item.source, ...(item.sources ?? [])].some(source => replayedSources.has(source) || replayedTools.has(source.split("/").at(-1)!)) ||
      (item.source_entry_id && replayedSources.has(`session-entry:${item.source_entry_id}`))));
  if (previous && previous.extractionVersion !== 4 && items.length) stats.reconstructionIncomplete = true;
  const seen = new Set(items.map(itemKey));
  let taskId = currentTaskId;
  for (let i = 0; i < start; i++) {
    const entry: any = entries[i];
    if (entry.customType === "knowledge_triage_state" && entry.data?.task_id) taskId = entry.data.task_id;
    if (entry.customType === "knowledge_triage_task" && entry.data?.task_id) taskId = entry.data.task_id;
  }
  const candidates: KnowledgeItem[] = [];
  function add(text: string, topic: string, source: string, origin: Origin, code: boolean,
    metadata: Partial<Pick<KnowledgeItem, "source_entry_id" | "source_kind" | "artifact">> = {}) {
    // Classify the complete logical item before splitting: every part of a long
    // rule must retain the same protection, including its trailing clauses.
    const rule = classifyRule(text, origin, code);
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 4000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(offset, end)); offset = end;
    }
    for (const [index, chunk] of chunks.entries()) {
      const part = chunks.length > 1 ? index : undefined;
      const key = itemKey({ taskId, origin, topic, source, text: chunk, part });
      if (seen.has(key)) continue;
      seen.add(key);
      const item: KnowledgeItem = {
        id: sha256(JSON.stringify([taskId, origin, source, topic, part, chunk])),
        text: chunk,
        type: rule.type,
        taskId,
        topic,
        source,
        origin,
        order: items.length + candidates.length,
        decidedBy: origin === "tool" || origin === "assistant" ? "source" : "rule",
        ...(part === undefined ? {} : { part }),
        ...(part === undefined ? {} : { parts: chunks.length }),
        ...metadata,
      };
      candidates.push(item);
      if (origin === "user" && rule.ambiguous && !code) {
        if (text.length <= 500) ambiguous.push(item);
        else { item.decidedBy = "conservative"; stats.conservative++; }
      }
    }
  }
  const ambiguous: KnowledgeItem[] = [];
  const hasRawHistory = entries.slice(0, Math.max(0, oldCutIndex))
    .some((entry) => entry.type === "message");
  if (!previous && previousSummary && !hasRawHistory) {
    stats.reconstructionIncomplete = true;
    for (const line of splitLines(previousSummary)) add(line.text, line.topic, "previous-compaction", "summary", line.code);
  }
  for (let i = start; i < end; i++) {
    signal?.throwIfAborted();
    const entry: any = entries[i];
    if (entry.customType === "knowledge_triage_state" && entry.data?.task_id) taskId = entry.data.task_id;
    if (entry.customType === "knowledge_triage_task" && entry.data?.task_id) taskId = entry.data.task_id;
    const source = `session-entry:${entry.id}`;
    const metadata = { source_entry_id: entry.id, source_kind: entry.type };
    if (entry.type === "branch_summary") { add(entry.summary ?? "", "branch summary", source, "summary", true, metadata); continue; }
    if (entry.type !== "custom_message" && (entry.type !== "message" || !entry.message)) continue;
    const message = entry.type === "custom_message" ? entry : entry.message;
    metadata.source_kind = message.role ?? entry.type;
    if (entry.type === "custom_message" || message.role === "custom") {
      for (const line of splitLines(textOf(message))) add(line.text, message.customType ?? "custom", source, "custom", true, metadata);
    } else if (message.role === "user") {
      for (const line of splitLines(textOf(message))) add(line.text, line.topic, source, "user", line.code, metadata);
    } else if (message.role === "assistant") {
      for (const line of splitLines(textOf(message))) add(line.text, line.topic, source, "assistant", line.code, metadata);
      for (const call of Array.isArray(message.content) ? message.content : []) {
        if (call.type === "toolCall") add(JSON.stringify({ tool: call.name, call_id: call.id, arguments: call.arguments }), "tool call", source, "assistant", true, metadata);
      }
    } else if (message.role === "bashExecution") {
      if (message.excludeFromContext) continue;
      const artifact = toolArtifactDirectory ? await archiveObservation(toolArtifactDirectory, { source_entry_id: entry.id, message }) : undefined;
      add(JSON.stringify({ command: message.command, output: message.output, exitCode: message.exitCode,
        cancelled: message.cancelled, truncated: message.truncated, fullOutputPath: message.fullOutputPath }),
      "bash execution", artifact?.path ?? source, "tool", true, { ...metadata, artifact });
    } else if (message.role === "toolResult") {
      // Retrieval replays existing archive content; archiving it again compounds history.
      if (message.toolName === "triage_retrieve") continue;
      const artifact = toolArtifactDirectory ? await archiveObservation(toolArtifactDirectory, { source_entry_id: entry.id, message }) : undefined;
      for (const line of splitLines(textOf(message))) add(line.text, message.toolName ?? "tool", artifact?.path ?? source, "tool", true, { ...metadata, artifact });
    }
    for (const [index, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (part.type !== "text" && part.type !== "thinking" && part.type !== "toolCall") {
        const artifact = toolArtifactDirectory ? await archiveObservation(toolArtifactDirectory, { source_entry_id: entry.id, content_index: index, attachment: part }) : undefined;
        add(`Attachment ${index}: ${part.type}; media type ${part.mimeType ?? "unknown"}; source ${source}.`, "attachment", artifact?.path ?? source, "tool", true, { ...metadata, artifact });
      }
    }
  }
  // Model calls only see new user instruction candidates. Failures retain the hard label.
  const toClassify = ambiguous.filter((item) => mayClassifyInstruction(item.text, item.topic)).slice(0, 16);
  if (classifier && toClassify.length) {
    stats.layaCalls = toClassify.length;
    try {
      const results = await classifier.classify(toClassify.map((item) => item.text), signal, classifierSession);
      signal?.throwIfAborted();
      if (results.length !== toClassify.length) throw new Error("Local Laya returned an incomplete batch");
      for (const [i, item] of toClassify.entries()) {
        const classified = results[i];
        if (classified && types.includes(classified)) {
          item.type = classified === "belief" || classified === "episodic" ? "constraint" : classified;
          item.decidedBy = "laya";
        } else {
          stats.layaFailures++;
          stats.layaFailureReason = "Local Laya returned an invalid or truncated classification";
          item.decidedBy = "conservative";
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      stats.layaFailures = toClassify.length;
      stats.layaFailureReason = String(error).slice(0, 300);
      for (const item of toClassify) {
        item.type = "constraint";
        item.decidedBy = "conservative";
      }
    }
  }
  for (const item of ambiguous) {
    if (item.decidedBy === "rule") item.decidedBy = "conservative";
    if (item.decidedBy === "conservative") stats.conservative++;
  }
  return { items: [...items, ...candidates], stats };
}

export const isMandatory = (item: KnowledgeItem): boolean => item.type === "constraint" || item.type === "procedural";
export const mandatoryKey = (item: KnowledgeItem): string => JSON.stringify([item.taskId, item.type, item.part, item.text]);

/** One instruction per exact equivalence class, with every source preserved. */
export function canonicalMandatory(items: KnowledgeItem[]): KnowledgeItem[] {
  const groups = new Map<string, { item: KnowledgeItem; sources: Set<string> }>();
  for (const item of items) {
    if (!isMandatory(item)) continue;
    const key = mandatoryKey(item), existing = groups.get(key);
    if (existing) {
      existing.sources.add(item.source);
      for (const source of item.sources ?? []) existing.sources.add(source);
    } else groups.set(key, { item, sources: new Set([item.source, ...(item.sources ?? [])]) });
  }
  return [...groups.values()].map(({ item, sources }) => ({ ...item, sources: [...sources] }));
}

/** Pin rules and procedures; allocate the rest as in the reference TypeCompact. */
export function typeCompact(items: KnowledgeItem[], budget: number, softBudget = 2048): { status: "ok" | "COMPACTION_UNSAFE"; kept: KnowledgeItem[]; minimum: number } {
  const pinned = canonicalMandatory(items);
  const minimum = pinned.length ? tokenEstimate(renderItems(pinned)) : 0;
  if (minimum > budget) return { status: "COMPACTION_UNSAFE", kept: pinned, minimum };
  const remaining = Math.max(0, Math.min(budget - minimum, softBudget));
  const take = (type: KnowledgeType, allowance: number) => {
    const kept: KnowledgeItem[] = [];
    let used = 0;
    for (const item of items.filter((candidate) => candidate.type === type)
      .sort((a, b) => b.order - a.order)) {
      const cost = itemTokens(item);
      if (used + cost > allowance) continue;
      kept.push(item);
      used += cost;
    }
    return kept;
  };
  const beliefs = take("belief", Math.floor(remaining * 0.5));
  const preferences = take("preference", Math.floor(remaining * 0.2));
  const used = [...beliefs, ...preferences].reduce((sum, item) => sum + itemTokens(item), 0);
  const episodic = take("episodic", remaining - used);
  return { status: "ok", kept: [...pinned, ...beliefs, ...preferences, ...episodic], minimum };
}

/** Build topic partitions and check the budget after global rules are replicated. */
export function typeDecompose(items: KnowledgeItem[], budget: number): Partition[] {
  const groups = new Map<string, KnowledgeItem[]>();
  const taskRules = new Map<string, KnowledgeItem[]>();
  for (const item of [...canonicalMandatory(items), ...items.filter(item => !isMandatory(item))]) {
    const key = `${item.taskId}\0${item.topic}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
    if (item.type === "constraint") {
      if (!taskRules.has(item.taskId)) taskRules.set(item.taskId, []);
      taskRules.get(item.taskId)!.push(item);
    }
  }
  const partitions: Partition[] = [];
  for (const [key, group] of groups) {
    const [taskId, topic] = key.split("\0");
    const rules = taskRules.get(taskId) ?? [];
    const ruleIds = new Set(rules.map((item) => item.id));
    const base = rules.length ? tokenEstimate(renderItems(rules)) : 0;
    if (base > budget) throw new Error(`COMPACTION_UNSAFE: rules exceed partition budget for ${taskId}`);
    let current: KnowledgeItem[] = [];
    let tokens = base;
    const flush = () => {
      if (!current.length) return;
      partitions.push({ taskId, topic, itemIds: [...ruleIds, ...current.map((item) => item.id)], tokens });
      current = [];
      tokens = base;
    };
    for (const item of group) {
      if (ruleIds.has(item.id)) continue;
      const cost = itemTokens(item);
      if (base + cost > budget) throw new Error(`COMPACTION_UNSAFE: item exceeds partition budget for ${taskId}`);
      if (tokens + cost > budget) flush();
      current.push(item);
      tokens += cost;
    }
    flush();
    if (!group.some((item) => !ruleIds.has(item.id)) && rules.length)
      partitions.push({ taskId, topic, itemIds: [...ruleIds], tokens: base });
  }
  return partitions;
}

export function countTypes(items: KnowledgeItem[]): Record<KnowledgeType, number> {
  const counts = Object.fromEntries(types.map((type) => [type, 0])) as Record<KnowledgeType, number>;
  for (const item of items) counts[item.type]++;
  return counts;
}

export function latestSnapshotRef(entries: SessionEntry[]): SnapshotRef | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "compaction") continue;
    const ref = (entry.details as any)?.triage as SnapshotRef | undefined;
    return ref;
  }
  return undefined;
}

/** Incremental renderer lets callers fit records without repeatedly rendering the prefix. */
export function itemRenderer() {
  const lines: string[] = [];
  let header = "", length = 0;
  const measure = (item: KnowledgeItem) => {
    const next = `[${item.type}; ${item.origin}; ${item.topic}; ${item.source}]`;
    const text = (next === header ? "" : next + "\n") + item.text;
    return { next, text, cost: text.length + (lines.length ? 1 : 0) };
  };
  return {
    get length() { return length; },
    cost(item: KnowledgeItem) { return measure(item).cost; },
    append(item: KnowledgeItem) { const value = measure(item); header = value.next; length += value.cost; lines.push(value.text); },
    render() { return lines.join("\n"); },
  };
}
export function renderItems(items: KnowledgeItem[]): string {
  const renderer = itemRenderer();
  for (const item of items) renderer.append(item);
  return renderer.render();
}
