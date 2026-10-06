# Changelog

## 0.1.0

- Extract knowledge triage into an independent, publishable Pi extension.
- Add automatic first-use CPU Laya setup with pinned downloads and a private managed Python runtime.
- Fall back to Pi's native compactor on Laya failure; preserve prior archive coverage and replay raw history when triage resumes.
- Enable `triage_retrieve` by default and add `/triage status` and `/triage setup`.
- Correct pagination after serialized output clipping.
- Preserve mandatory records, source attribution, bounded retrieval caches, segmented archives and fork materialization.
- Add lifecycle cleanup, setup locking/cancellation, offline inference and package installation coverage.
