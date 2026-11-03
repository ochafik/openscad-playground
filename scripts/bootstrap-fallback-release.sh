#!/usr/bin/env bash
# Creates the first wasm2js fallback release from an existing CI build instead of
# waiting for publish-fallback.yml (which would also work, just slower).
#
#   bash scripts/bootstrap-fallback-release.sh            # download + verify only
#   bash scripts/bootstrap-fallback-release.sh --publish  # also create the release
#
# 1. Takes the newest successful "Build wasm2js fallback" run on the repo that
#    produced an `openscad.fallback.js` artifact (override with RUN_ID).
# 2. Checks the run's commit has the SAME recipe input hash as the current
#    checkout (otherwise the artifact is not the file this tree needs).
# 3. Verifies the file (scripts/check-wasm-fallback.mjs: syntax, nesting, cube(10)).
# 4. With --publish: `gh release create fallback-<hash16>` with the assets and
#    writes scripts/fallback.json (commit and push it yourself).
#
# Environment: REPO (default ochafik/openscad-playground), WORKDIR (default mktemp).
set -euo pipefail

REPO="${REPO:-ochafik/openscad-playground}"
publish=false
[ "${1:-}" = "--publish" ] && publish=true

cd "$(dirname "${BASH_SOURCE[0]}")/.."
WORKDIR="${WORKDIR:-$(mktemp -d)}"
tag="$(bash scripts/fallback-input-hash.sh --tag)"
hash="$(bash scripts/fallback-input-hash.sh)"
echo "this tree needs ${tag}"

if gh release view "${tag}" -R "${REPO}" >/dev/null 2>&1; then
  echo "release ${tag} already exists on ${REPO}; only pinning."
  publish_needed=false
else
  publish_needed=true
fi

run_id="${RUN_ID:-}"
if [ -z "${run_id}" ]; then
  # Newest successful runs first; pick the first that still has the artifact.
  for id in $(gh run list -R "${REPO}" --workflow "Build wasm2js fallback" --status success --limit 20 --json databaseId -q '.[].databaseId'); do
    if gh api "repos/${REPO}/actions/runs/${id}/artifacts" -q '.artifacts[] | select(.name=="openscad.fallback.js" and .expired==false) | .id' | grep -q .; then
      run_id="${id}"; break
    fi
  done
fi
[ -n "${run_id}" ] || { echo "no successful run with a live artifact found" >&2; exit 1; }
run_sha="$(gh run view "${run_id}" -R "${REPO}" --json headSha -q .headSha)"
echo "using run ${run_id} (commit ${run_sha})"

git cat-file -e "${run_sha}^{commit}" 2>/dev/null || git fetch --quiet "https://github.com/${REPO}.git" "${run_sha}" \
  || { echo "cannot fetch ${run_sha}; fetch the fork's branches first" >&2; exit 1; }
run_hash="$(bash scripts/fallback-input-hash.sh "${run_sha}")"
if [ "${run_hash}" != "${hash}" ]; then
  echo "recipe mismatch: run commit has input hash ${run_hash}, this tree ${hash}." >&2
  echo "Use a checkout whose recipe matches, or let publish-fallback.yml build it." >&2
  exit 1
fi

rm -f "${WORKDIR}/openscad.fallback.js"
gh run download "${run_id}" -R "${REPO}" -n openscad.fallback.js -D "${WORKDIR}"
f="${WORKDIR}/openscad.fallback.js"
node scripts/check-wasm-fallback.mjs "${f}"
sha256="$(shasum -a 256 "${f}" | cut -d' ' -f1)"
echo "${sha256}  openscad.fallback.js" > "${WORKDIR}/openscad.fallback.js.sha256"
# shellcheck disable=SC2016
openscad_commit="$(sed -n 's/^OPENSCAD_REF="\${OPENSCAD_REF:-\([0-9a-f]*\)}"/\1/p' scripts/build-wasm-fallback.sh)"
node -e '
  const [url, sha256, inputHash, openscadCommit] = process.argv.slice(1);
  console.log(JSON.stringify({ url, sha256, inputHash, openscadCommit, builtAt: new Date().toISOString() }, null, 2));
' "https://github.com/${REPO}/releases/download/${tag}/openscad.fallback.js" "${sha256}" "${hash}" "${openscad_commit}" > "${WORKDIR}/fallback.json"
echo "verified ${f} (sha256 ${sha256}); metadata in ${WORKDIR}/fallback.json"

if [ "${publish}" != true ]; then
  echo "dry run: re-run with --publish to create the release and scripts/fallback.json"
  exit 0
fi
if [ "${publish_needed}" = true ]; then
  gh release create "${tag}" -R "${REPO}" \
    "${f}" "${WORKDIR}/openscad.fallback.js.sha256" "${WORKDIR}/fallback.json" \
    --target "${run_sha}" --prerelease --title "wasm2js fallback ${hash:0:12}" \
    --notes "Bootstrapped from CI run https://github.com/${REPO}/actions/runs/${run_id} (recipe input hash \`${hash}\`)."
fi
cp "${WORKDIR}/fallback.json" scripts/fallback.json
echo "wrote scripts/fallback.json; commit and push it (git add scripts/fallback.json && git commit -m 'Pin wasm2js fallback ${tag}')"
