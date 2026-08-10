#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fake_bin="$(mktemp -d)"
trap 'rm -rf "$fake_bin"' EXIT

cat >"$fake_bin/git" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == *"rev-parse --is-inside-work-tree"* ]]; then
  exit 0
fi
if [[ "$*" == *"ls-files -z"* ]]; then
  printf 'deploy/dockerhub/publish.sh\0'
  echo "producer-private-detail" >&2
  exit 7
fi
exit 1
SH
chmod +x "$fake_bin/git"

set +e
PATH="$fake_bin:$PATH" bash "$repo_root/deploy/dockerhub/test-source-build-shells.sh" >"$fake_bin/output" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "partial tracked-shell enumeration must fail" >&2
  exit 1
fi
if [[ "$(<"$fake_bin/output")" != "tracked shell enumeration failed" ]]; then
  echo "tracked-shell enumeration failure output must be fixed" >&2
  exit 1
fi

echo "partial tracked-shell enumeration: rejected"
