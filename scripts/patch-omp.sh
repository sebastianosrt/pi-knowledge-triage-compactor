#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "Usage: $0 /path/to/oh-my-pi-v18.18.6" >&2
  exit 2
fi
checkout=$1
patch_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
base=9058ab9d229663e229e2867824ba6df6f21e9e59
if [[ $(git -C "$checkout" rev-parse HEAD) != "$base" ]]; then
  echo "This patch requires OMP v18.18.6 at $base; no files changed." >&2
  exit 1
fi
for patch_name in omp-18.18.6-method-order.patch omp-18.18.6-title-isolation.patch; do
  patch_file="$patch_dir/$patch_name"
  # Later patches also extend Unreleased. Check the actual code/tests when
  # detecting an applied patch so adjacent changelog entries do not hide it.
  if git -C "$checkout" apply --reverse --check --exclude=packages/coding-agent/CHANGELOG.md "$patch_file" 2>/dev/null; then
    echo "$patch_name is already applied."
    continue
  fi
  git -C "$checkout" apply --check "$patch_file"
  git -C "$checkout" apply "$patch_file"
  echo "Applied $patch_name."
done
echo "Build OMP as described in docs/omp-method-order.md."
