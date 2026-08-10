#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts=(
  "$repo_root/deploy/dockerhub/publish.sh"
  "$repo_root/deploy/panel-knowledge-combined/build.sh"
  "$repo_root/deploy/panel-knowledge-combined/publish.sh"
  "$repo_root/deploy/panel-knowledge-combined/start-combined.sh"
  "$repo_root/MemoryPanel/scripts/secret-scan.sh"
)

for script in "${scripts[@]}"; do
  if grep -q $'\r' "$script"; then
    echo "CRLF is not valid for Bash source-build script: $script" >&2
    exit 1
  fi
  bash -n "$script"
done

echo "source-build shell scripts: LF and syntax OK"
