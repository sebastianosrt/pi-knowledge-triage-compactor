import { canonicalMandatory, isMandatory, mandatoryKey, type KnowledgeItem, type TriageSnapshot } from "./knowledge-triage.ts";
import { archiveIdentity, cacheGet, cachePut } from "./triage-cache.ts";

const stopWords = new Set("the a an and or to of in on is are was were be for with what which please find show return about from this that".split(" "));
const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(word => word.length > 1 && !stopWords.has(word));
interface Posting { document: number; weight: number }
interface Index { items: KnowledgeItem[]; postings: Map<string, Posting[]>; idf: Map<string, number>; mandatory: KnowledgeItem[] }

function retrievalIndex(snapshot: TriageSnapshot, taskId: string): Index {
  const owner = archiveIdentity(snapshot), key = `index:${taskId}`;
  const cached = cacheGet<Index>(owner, key);
  if (cached) return cached;
  const items = snapshot.items.filter(item => item.taskId === taskId), postings = new Map<string, Posting[]>();
  let bytes = items.length * 16;
  // In-memory callers may have no materialization entry accounting for these
  // strong item references. Include their estimated retained size in that case.
  if (!cacheGet(owner, "snapshot")) for (const item of items)
    bytes += 256 + 2 * (item.text.length + item.id.length + item.source.length + item.topic.length +
      (item.sources ?? []).reduce((sum, source) => sum + source.length, 0));
  for (const [document, item] of items.entries()) {
    const weights = new Map<string, number>();
    for (const [text, weight] of [[item.text, 1], [item.topic, .2], [[item.source, ...(item.sources ?? []), item.source_entry_id ?? ""].join(" "), .5]] as const) {
      for (const term of new Set(words(text))) weights.set(term, (weights.get(term) ?? 0) + weight);
    }
    for (const [term, weight] of weights) {
      let list = postings.get(term);
      if (!list) { list = []; postings.set(term, list); bytes += 80 + term.length * 2; }
      list.push({ document, weight }); bytes += 32;
    }
  }
  const idf = new Map([...postings].map(([term, list]) => [term, Math.log(1 + (items.length + 1) / (list.length + 1))]));
  const mandatory = canonicalMandatory(items);
  for (const item of mandatory) { Object.freeze(item.sources); Object.freeze(item); }
  const index = { items, postings, idf, mandatory };
  if (Object.isFrozen(snapshot) && Object.isFrozen(snapshot.items) && snapshot.items.every(item => Object.isFrozen(item) && (!item.sources || Object.isFrozen(item.sources))))
    cachePut(owner, key, index, bytes);
  return index;
}

/** A heap ranks just the requested prefix; coverage updates touch affected postings only. */
class Heap {
  private values: number[];
  private positions: Int32Array;
  private better: (a: number, b: number) => boolean;
  constructor(values: number[], size: number, better: (a: number, b: number) => boolean) {
    this.better = better;
    this.values = [...values]; this.positions = new Int32Array(size).fill(-1);
    this.values.forEach((value, i) => { this.positions[value] = i; });
    for (let i = (values.length >>> 1) - 1; i >= 0; i--) this.down(i);
  }
  private swap(a: number, b: number) {
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    this.positions[this.values[a]] = a; this.positions[this.values[b]] = b;
  }
  private down(i: number) {
    for (;;) {
      let best = i, left = i * 2 + 1, right = left + 1;
      if (left < this.values.length && this.better(this.values[left], this.values[best])) best = left;
      if (right < this.values.length && this.better(this.values[right], this.values[best])) best = right;
      if (best === i) return;
      this.swap(i, best); i = best;
    }
  }
  decreased(value: number) { const i = this.positions[value]; if (i >= 0) this.down(i); }
  pop(): number | undefined {
    const first = this.values[0];
    if (first === undefined) return;
    this.swap(0, this.values.length - 1); this.values.pop(); this.positions[first] = -1;
    if (this.values.length) this.down(0);
    return first;
  }
}

export function typeRetrieve(snapshot: TriageSnapshot, taskId: string, query: string, limit = 10, offset = 0,
  excludeIds: ReadonlySet<string> = new Set()): { pinned: KnowledgeItem[]; matches: KnowledgeItem[]; incomplete: boolean; total: number } {
  const index = retrievalIndex(snapshot, taskId), n = index.items.length;
  const excludedMandatory = new Set(index.items.filter(item => isMandatory(item) && excludeIds.has(item.id)).map(mandatoryKey));
  const pinned = index.mandatory.filter(item => !excludedMandatory.has(mandatoryKey(item)));
  const scores = new Float64Array(n), coverage = new Float64Array(n), candidates = new Set<number>();
  const rare = new Map<string, Posting[]>();
  for (const term of new Set(words(query))) {
    const list = index.postings.get(term); if (!list) continue;
    const weight = index.idf.get(term)!;
    const distinct = list.length <= Math.max(1, n / 4);
    if (distinct) rare.set(term, list);
    for (const entry of list) {
      const item = index.items[entry.document];
      if (isMandatory(item) || excludeIds.has(item.id)) continue;
      scores[entry.document] += weight * entry.weight;
      if (distinct) coverage[entry.document] += weight;
      candidates.add(entry.document);
    }
  }
  if (query.trim() === "*") index.items.forEach((item, i) => { if (!isMandatory(item) && !excludeIds.has(item.id)) candidates.add(i); });
  const tie = (a: number, b: number) => scores[a] - scores[b] || index.items[a].order - index.items[b].order || index.items[b].id.localeCompare(index.items[a].id);
  const heap = new Heap([...candidates], n, (a, b) => coverage[a] - coverage[b] > 1e-10 || (Math.abs(coverage[a] - coverage[b]) <= 1e-10 && tie(a, b) > 0));
  const termsByDocument = new Map<number, string[]>();
  for (const [term, list] of rare) for (const { document } of list) {
    const terms = termsByDocument.get(document) ?? []; terms.push(term); termsByDocument.set(document, terms);
  }
  const matches: KnowledgeItem[] = [], end = Math.min(candidates.size, Math.max(0, offset) + Math.max(0, limit));
  for (let rank = 0; rank < end; rank++) {
    const selected = heap.pop()!;
    if (rank >= offset) matches.push(index.items[selected]);
    for (const term of termsByDocument.get(selected) ?? []) {
      const list = rare.get(term); if (!list) continue;
      rare.delete(term);
      for (const { document } of list) { coverage[document] = Math.max(0, coverage[document] - index.idf.get(term)!); heap.decreased(document); }
    }
  }
  return { pinned, matches, incomplete: offset + limit < candidates.size, total: candidates.size };
}
