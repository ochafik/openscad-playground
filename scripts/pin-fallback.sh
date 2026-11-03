#!/usr/bin/env bash
# Pins the wasm2js fallback for the current checkout: finds the GitHub Release
# `fallback-<input hash>` (see scripts/fallback-input-hash.sh), copies its
# `fallback.json` asset to scripts/fallback.json and commits it when it changed.
#
#   scripts/pin-fallback.sh
#
# Exit codes: 0 pinned (or already pinned), 3 no release for this input hash
# (the fallback has to be built: .github/workflows/publish-fallback.yml), 1 error.
# Needs `gh` with a token that can read releases (GH_TOKEN) and GH_REPO or a
# GitHub remote. NO_COMMIT=true leaves the change uncommitted.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
tag="$(bash scripts/fallback-input-hash.sh --tag)"
hash="$(bash scripts/fallback-input-hash.sh)"
echo "fallback input hash ${hash} -> release ${tag}"

if ! gh release view "${tag}" >/dev/null 2>&1; then
  echo "no release ${tag}: the fallback for these inputs has not been built" >&2
  exit 3
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
gh release download "${tag}" --pattern fallback.json --dir "${tmp}"
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const k of ["url", "sha256", "inputHash", "openscadCommit", "builtAt"])
    if (!j[k]) { console.error("fallback.json lacks " + k); process.exit(1); }
  if (j.inputHash !== process.argv[2]) { console.error("release " + process.argv[3] + " has inputHash " + j.inputHash); process.exit(1); }
' "${tmp}/fallback.json" "${hash}" "${tag}"

if [ -f scripts/fallback.json ] && cmp -s "${tmp}/fallback.json" scripts/fallback.json; then
  echo "scripts/fallback.json already pins ${tag}"
  exit 0
fi
cp "${tmp}/fallback.json" scripts/fallback.json
echo "pinned $(cat scripts/fallback.json)"
if [ "${NO_COMMIT:-false}" != "true" ]; then
  git config user.name  >/dev/null 2>&1 || git config user.name  "github-actions[bot]"
  git config user.email >/dev/null 2>&1 || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add scripts/fallback.json
  git commit -q -m "Pin wasm2js fallback ${tag}" -m "Release asset built from the recipe with input hash ${hash}."
fi
