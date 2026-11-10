# Changelog

## OMP compatibility (2026-11-10)

- Add shared Pi/OMP loading, canonical context anchoring, prompt-array budgeting, and session/fork archive recovery.
- Add background Laya setup using external Node under compiled OMP, a 25-second compaction deadline, and explicit host status.
- Add actual OMP RPC/package, cancellation, setup, and real-Laya checks while retaining Pi regressions.

## Unreleased

- Add an optional OMP title-model isolation patch and FLM configuration guide to prevent background title requests from replacing a single-slot conversation cache; test automatic titles across read continuations with and without archived context.
- Add a version-pinned OMP host patch that exposes Knowledge triage in Compaction Method Order, honors manual/automatic priority, and preserves archive retrieval when another method runs.
- Preserve archived-context prefixes across continuations when headroom shrinks; defer new automatic retrieval blocks that cannot fit instead of aborting the turn. Deferred queries can retry when space becomes available, and explicit retrieval remains available.

## 0.1.0

- Extract knowledge triage into an independent, publishable Pi extension.
- Add automatic first-use CPU Laya setup with pinned downloads and a private managed Python runtime.
- Fall back to Pi's native compactor on Laya failure; preserve prior archive coverage and replay raw history when triage resumes.
- Enable `triage_retrieve` by default and add `/triage status` and `/triage setup`.
- Correct pagination after serialized output clipping.
- Preserve mandatory records, source attribution, bounded retrieval caches, segmented archives and fork materialization.
- Add lifecycle cleanup, setup locking/cancellation, offline inference and package installation coverage.
