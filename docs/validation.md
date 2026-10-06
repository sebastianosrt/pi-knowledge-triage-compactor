# Validation

Validated locally on 2026-10-06. These results apply to this standalone package, rather than the earlier harness benchmark.

| Check | Result |
| --- | --- |
| TypeScript strict type checking | Passed |
| Deterministic core, storage, retrieval, extension and setup tests | 36 passed, no skips |
| Actual Pi RPC and npm package installation tests | 5 passed on Pi 1.0.4 and Pi 0.85.1 |
| Real Laya classification and compaction through Pi CLI | Passed; zero model-provider requests during local compaction |
| Linux Docker with Node 22.22.2, `--network none`, read-only package and runtime mounts | All 42 tests passed |
| Host Node 26.9.0 | Type checking, unit tests, Pi integration and real Laya passed |

## What was exercised

- Initial managed installation downloaded uv, Python 3.13, locked CPU dependencies and the pinned Laya model, then completed an offline inference check.
- Setup concurrency, interrupted installation, process-group termination, lock release, ready-marker validation, repair and warm reuse were exercised with local executable fixtures through the real subprocess/`flock` path.
- Real inference used Laya 0.3.27, CPU Torch 2.10.0 and model revision `1720e3e3357cfe1e281542e223f8273b0890ca34`. The full suite also ran with external networking disabled after installation.
- Actual Pi requests included the enabled retrieval tool and the built-in read/bash/edit/write tools. The retrieval tool was called through a local provider fixture.
- A failed Laya worker caused Pi's native compactor to call the local fixture provider and produce a native compaction entry.
- Corrupt and oversized archived context caused the real Pi turn to abort with zero provider requests.
- Tests cover fallback archive references, replay across fallback gaps, fork artifact copying, cache invalidation, source attribution, mandatory instruction retention and clipping-aware pagination.
- A packed npm tarball was installed in a disposable directory and registered using `pi install`; Pi discovered the package entrypoint, retrieval tool and `/triage` command.

Provider fixtures bind only to loopback and use dummy credentials. No OpenRouter or other paid inference benchmark was run for this release. Prior harness quality/performance measurements are not presented as measurements of this standalone package.

## Limits

The GitHub Actions matrix is configured but has not been run remotely from this workspace. Node 22.19.0 and Node 24 are included in that matrix; the locally exercised Node versions are listed above. macOS, Windows, ARM and musl-based Linux distributions are not supported in this release.

This directory and its tarball are prepared for publication. No npm publication, remote repository creation or pi.dev indexing was performed.
