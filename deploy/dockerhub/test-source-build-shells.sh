#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

tracked_shells() {
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" ls-files -z -- '*.sh'
  elif command -v git.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    git.exe -C "$(wslpath -w "$repo_root")" ls-files -z -- '*.sh'
  else
    echo "cannot enumerate tracked shell scripts" >&2
    return 1
  fi
}

tracked=0
crlf_failures=0
syntax_failures=0
while IFS= read -r -d '' relative_path; do
  script="$repo_root/$relative_path"
  tracked=$((tracked + 1))
  if grep -q $'\r' "$script"; then
    echo "CRLF is not valid for Bash source-build script: $script" >&2
    crlf_failures=$((crlf_failures + 1))
  fi
  if ! bash -n "$script"; then
    echo "Bash syntax check failed: $script" >&2
    syntax_failures=$((syntax_failures + 1))
  fi
done < <(tracked_shells)

if [[ "$tracked" -eq 0 ]]; then
  echo "no tracked shell scripts found" >&2
  exit 1
fi

echo "tracked=$tracked crlf_failures=$crlf_failures syntax_failures=$syntax_failures"
test "$crlf_failures" -eq 0
test "$syntax_failures" -eq 0
