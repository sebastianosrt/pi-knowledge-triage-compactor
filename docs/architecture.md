# Architecture

## Data flow

```text
Pi session_before_compact
  -> inspect active branch and previous archive
  -> extract complete logical records with provenance
  -> deterministic rules; local Laya for eligible ambiguous user instructions
  -> retain all mandatory constraints/procedures and budget optional records
  -> persist checksummed archive and return a verbatim summary to Pi

Laya setup/inference failure -> Pi native compaction -> record archive coverage gap

Pi context -> ranked archive search -> complete-record fitting -> context injection
triage_retrieve -> same search -> byte-bounded result and exact next-page cursor
```

## Modules

- `src/core`: Markdown-aware extraction, typed retention, ranking, bounded caches, immutable storage and artifacts.
- `src/laya`: isolated CPU subprocess, classification cache, managed setup, cancellation and failure handling.
- `src/pi`: branch state, retrieval response construction and context injection.
- `src/extension.ts`: registration, lifecycle, compaction, retrieval tool, status/setup command and fallback handoff.

The factory only registers capabilities. Processes and downloads start when requested by compaction or setup. Shutdown and session replacement terminate outstanding setup/inference. No recovery continuations are queued from `agent_settled`.

## Classification and retention

Records have a task ID, origin, source entry ID, topic, and one of five types: constraint, procedural, belief, preference, episodic. Extracted text is preserved; tool calls, tool results, custom messages, branch summaries, shell output and attachment references retain provenance. Thinking blocks and explicitly excluded shell messages are omitted. Retrieval tool results are not recursively re-archived.

Rules classify clear instructions first. Only eligible ambiguous user instructions reach Laya: at most 16 per batch and 500 characters per input. Code, quoted source, tool observations and secret-like strings are not reinterpreted as user instructions by the classifier. Valid low-confidence decisions retain constraints; invalid/truncated responses trigger native fallback at the extension boundary.

Long logical records are classified before being split into surrogate-safe chunks of at most 4,000 UTF-16 code units. Equivalent mandatory records merge sources. Constraints and procedures are retained completely; if they do not fit, triage cancels. Optional retention is bounded by 2,048 estimated tokens and the model's remaining compaction budget. Token accounting is an estimate, not a tokenizer-exact guarantee.

Laya is loaded once per classification batch and released afterward. Valid classification decisions are cached by session and runtime fingerprint, with 256 decisions per session and at most four sessions.

## Archives and forks

Internal snapshots use version 1; on-disk segmented manifests use version 2 and extraction version 4. SHA-256 verifies manifests, segments and artifacts. Each segment contains at most 512 records and 1 MiB. Incremental compaction reuses immutable prior segments.

The active Pi branch determines task scope and archive references. Branches outside that ancestry are ignored. Forks copy missing archives and artifacts into the child; ancestry lookup is bounded and cycle-checked. Legacy archive bytes remain unchanged during import so stored checksums stay valid.

After native fallback, a custom entry links the successful native compaction entry to the previous archive. Retrieval includes previously retained records because the native summary's exact coverage is unknown. Later triage replays raw ancestors; missing history is marked as an incomplete reconstruction.

Snapshot and retrieval-index caches share a maximum of four owners and approximately 64 MiB. Disk storage is persistent and unbounded. Content files are atomic and private to the operating-system account.

## Retrieval

The local inverted index matches Unicode words, identifiers and source references. Inverse document frequency and rare-term coverage favor specific identifiers and diverse matches; a heap ranks only the requested prefix. Mandatory records are pinned independently of the query.

Automatic retrieval examines the latest user question, selects up to 50 candidates, and fits complete records within context headroom and 8,000 characters. It reserves response space, accounts for the current system prompt and tool schemas, and preserves source/evidence status.

Explicit retrieval defaults to 10 records and supports up to 50 per requested page. The 32 KiB serialized limit includes pinned records, metadata and the cursor. `next_offset` and `next_page` are computed after clipping. If no matching record can fit alongside the mandatory records, it returns an error rather than a non-advancing page.
