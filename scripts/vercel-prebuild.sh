#!/bin/bash
# Pre-build step for the Vercel deployment (see vercel.json).
#
# The WASM build and library archives are produced by `npm run build:all`
# from the pinned sources in libs-config.json, so nothing needs to be
# downloaded from a CDN here.
#
# The wasm2js fallback (public/openscad.fallback.js, ~22 MB) cannot be built on
# Vercel (it needs a patched Binaryen and the OpenSCAD toolchain, see
# docs/WASM_FALLBACK.md). It is built by .github/workflows/publish-fallback.yml,
# published as a GitHub Release asset and pinned in scripts/fallback.json
# ({url, sha256, ...}) by the sync workflow. This script downloads that exact
# file and verifies its sha256; webpack then copies it into dist/.
# A missing pin, a 404 or a checksum mismatch FAILS the build on purpose: a
# deployment without the fallback leaves WebAssembly-less browsers with no
# renderer.
#
# Environment:
#   OPENSCAD_FALLBACK=off         skip the fallback (deploy without it)
#   OPENSCAD_FALLBACK_FILE=PATH   use a local file instead of downloading
#                                 (local testing, emergencies); a checksum
#                                 different from the pin only warns
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
DEST=public/openscad.fallback.js
PIN=scripts/fallback.json

sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [ "${OPENSCAD_FALLBACK:-}" = "off" ]; then
  echo "OPENSCAD_FALLBACK=off: deploying without the wasm2js fallback."
  rm -f "${DEST}"
  exit 0
fi

if [ ! -f "${PIN}" ]; then
  if [ -n "${OPENSCAD_FALLBACK_FILE:-}" ]; then
    cp "${OPENSCAD_FALLBACK_FILE}" "${DEST}"
    echo "no ${PIN}; using ${OPENSCAD_FALLBACK_FILE} unverified"
    exit 0
  fi
  echo "ERROR: ${PIN} is missing, so there is no pinned wasm2js fallback." >&2
  echo "Run the 'Publish wasm2js fallback' workflow / scripts/bootstrap-fallback-release.sh," >&2
  echo "or set OPENSCAD_FALLBACK=off to deploy without it." >&2
  exit 1
fi

url="$(node -p 'require("./scripts/fallback.json").url')"
want="$(node -p 'require("./scripts/fallback.json").sha256')"

if [ -n "${OPENSCAD_FALLBACK_FILE:-}" ]; then
  echo "Using local fallback ${OPENSCAD_FALLBACK_FILE}"
  cp "${OPENSCAD_FALLBACK_FILE}" "${DEST}"
  got="$(sha256_of "${DEST}")"
  [ "${got}" = "${want}" ] || echo "WARNING: local fallback sha256 ${got} differs from the pin ${want}" >&2
  exit 0
fi

echo "Fetching wasm2js fallback ${url}"
mkdir -p public
curl -fL --retry 3 --retry-delay 5 --retry-all-errors -o "${DEST}" "${url}" \
  || { echo "ERROR: could not download the pinned fallback from ${url}" >&2; exit 1; }
got="$(sha256_of "${DEST}")"
if [ "${got}" != "${want}" ]; then
  echo "ERROR: fallback sha256 mismatch: got ${got}, pinned ${want}" >&2
  rm -f "${DEST}"
  exit 1
fi
echo "Fallback verified: $(wc -c < "${DEST}") bytes, sha256 ${got}"
