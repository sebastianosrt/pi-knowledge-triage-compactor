# Pi Knowledge Triage Compactor

Local, source-attributed knowledge compaction for [Pi](https://pi.dev), with an archive you can search after compaction.
Based on the paper [The Compaction Cliff in Long-Running AI Agent Memory](https://arxiv.org/pdf/2608.22752v1).

The extension retains constraints and procedures verbatim, selects other useful records within a token budget, and stores the complete extracted history in checksummed session archives. A local [Laya](https://github.com/NandhaKishorM/laya) classifier helps classify ambiguous user instructions. `triage_retrieve` is enabled by default.

**Laya setup and inference failures fall back to Pi's default compactor. That fallback can send conversation content to your configured remote model provider and incur its normal charges.** Successful triage compaction uses no inference API. First-use setup downloads public software and model weights.

## Install

After publication:

```sh
pi install npm:pi-knowledge-triage-compactor
```

From a checkout, before publication:

```sh
pi install /absolute/path/to/pi-knowledge-triage-compactor
```

Reload Pi with `/reload`, or start a new Pi process. No build step or API key is needed for Laya. Published packages use Pi's supplied dependencies; contributors working from a checkout should run `npm ci` first.

The first compaction that needs Laya automatically prepares the runtime. You can prepare it ahead of time with `/triage setup` inside Pi, or `npm run triage:setup` in a checkout.

### Requirements

- Linux x86_64 with glibc, `tar`, and `flock` (normally supplied by util-linux).
- Node.js 22.19 or newer and Pi. Compatibility checks cover Pi 0.85.1 and 1.0.4.
- Network access for first-use downloads from GitHub, Python package indexes, the CPU PyTorch index, and Hugging Face.
- Model weights are approximately 1.3 GB. Allow several GB of free disk space for Python, dependencies, downloads, and weights. CPU inference also needs several GB of RAM; actual use depends on the input and environment.

Python and uv are provisioned privately in the user cache; setup does not require root or a system Python installation. Initial setup can take several minutes. It reports stages, supports cancellation, and has a 30-minute timeout. Classification batches have a 120-second timeout. Concurrent Pi processes share a kernel-managed installation lock.

## Usage

Pi's automatic compaction and `/compact` use the extension. Its normal compaction settings still determine when compaction happens and how much recent history remains.

| Interface | Purpose |
| --- | --- |
| `/triage status` | Show runtime readiness, last Laya error, archive coverage, and retrieval availability. |
| `/triage setup` | Prepare Laya, retry failed setup, or repair the managed runtime after an inference failure. |
| `triage_retrieve` | Model-callable, read-only search of the active task's archive. Enabled by default. |

Example tool arguments:

```json
{"query":"connection_timeout OBS_42","limit":10,"offset":0,"include_retained":false}
```

Use `"query":"*"` to list records. Follow the returned `next_page` object unchanged until it is `null`. Set `include_retained:true` to include records already retained in the summary. Before the first archive exists, the tool returns `archive_available:false`; repeating the lookup will not create one.

Retrieval returns exact records, original source references, pinned instructions, archive coverage, and pagination. It supplies JSON text, `details.result`, and structured content for Pi versions supporting it. Archived observations remain context hints to verify against their sources.

Automatic retrieval injects relevant archived records before a model request, fitting complete records into available context and an 8,000-character ceiling. Explicit retrieval is limited to 32 KiB per response. The extension respects explicitly disabled tools and does not replace Pi's built-in tools, selected model, or thinking level.

## Storage and configuration

Runtime defaults to `$XDG_CACHE_HOME/pi-knowledge-triage-compactor`, or `~/.cache/pi-knowledge-triage-compactor`.

| Environment variable | Meaning |
| --- | --- |
| `PI_TRIAGE_HOME` | Absolute directory for the managed runtime, weights, and setup cache. |
| `PI_TRIAGE_PYTHON` | Absolute path to an existing Laya Python interpreter; requires `PI_TRIAGE_MODEL_DIR`. |
| `PI_TRIAGE_MODEL_DIR` | Absolute local model directory; requires `PI_TRIAGE_PYTHON`. |

Both custom-runtime variables bypass automatic downloads. The extension does not repair or remove a user-supplied runtime. Inference uses CPU, offline Hugging Face/Transformers settings, and an environment without provider credentials.

The managed runtime pins Laya 0.3.27, CPU Torch 2.10.0, uv 0.12.5, and model revision `1720e3e3357cfe1e281542e223f8273b0890ca34` of `convaiinnovations/laya-multilingual`. Python uses the managed 3.13 series. Dependency versions are locked in the package.

Archives live beside the Pi session file:

```text
<session-directory>/
  <session>.jsonl
  triage/<session-id>/          # checksummed manifests and immutable segments
  artifacts/<session-id>/      # complete tool observations and attachments
```

Session archives are independent of the runtime cache. They can contain the same sensitive information as the conversation and use private file permissions. They are not encrypted. Disk usage grows with history; there is no automatic archive deletion. Back up the session file together with its archive and artifacts. Forks materialize referenced archives into their own session directories.

A session is one task. Forks inherit its task state; starting a new Pi session starts a new task. Sessions without persistent storage use native compaction and have no triage archive.

## Failure behavior

- Laya installation, subprocess, timeout, invalid-output, or inference failures invoke Pi's default compactor. Failed automatic setup is not repeatedly attempted within that session; use `/triage setup` to retry.
- Valid but uncertain classifications conservatively retain the instruction. Unclassifiable long or source-like text follows deterministic retention rules.
- Cancellation stops the operation without launching native fallback.
- Archive corruption or insufficient space for mandatory instructions cancels unsafe triage compaction. Context-hook failures abort the model turn before it can send incomplete archived context.
- After native fallback, earlier archives remain retrievable with `archive_coverage:"before_native_fallback"`. Newer native-summarized content is not claimed to be archived. Successful subsequent triage replays available raw history before resuming incremental extraction.

Native fallback has Pi's normal summarization behavior; it does not provide triage's verbatim-retention guarantees.

## Existing harness users

Load this package as the compactor for a normal Pi installation. Do not load it alongside the harness extension or another custom compactor: both may register `triage_retrieve` and compaction hooks. Setting the harness's `AUDIT_COMPACTOR=pi` alone does not remove its retrieval tool.

This package has no runtime imports from the harness. Its storage reader retains v1/v2 archive compatibility, but automatic migration of harness research-task state is not provided; start a standalone session rather than claiming complete migrated task scope.

## Development and release

```sh
npm ci
npm run check
npm run triage:setup
npm run test:laya
npm pack --dry-run
npm pack
```

`npm run check` runs type checking, deterministic regressions, actual Pi RPC tests against a local provider fixture, and tarball installation/discovery. `npm run test:laya` requires an installed model and checks real local inference and compaction through Pi. No paid provider requests are part of these suites.

See [architecture](docs/architecture.md), [release instructions](docs/releasing.md), and [validation notes](docs/validation.md).

## License

Apache-2.0. See [NOTICE](NOTICE) and [upstream licenses](licenses). The npm package excludes model weights, Python, uv binaries, node_modules, session data, and test fixtures.
