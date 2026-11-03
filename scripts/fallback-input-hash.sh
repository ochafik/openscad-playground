#!/usr/bin/env bash
# Prints the INPUT HASH of the wasm2js fallback build at a git revision:
# sha256 over the blobs of everything that determines openscad.fallback.js
# (the build script, which pins the OpenSCAD and Binaryen refs, and the vendored
# patches). These are the same inputs build-fallback.yml keys its caches on.
# Releases are named fallback-<first 16 hex>.
#
#   scripts/fallback-input-hash.sh [rev]        # default HEAD; prints the full hash
#   scripts/fallback-input-hash.sh --tag [rev]  # prints fallback-<16 hex>
set -euo pipefail

tag=false
if [ "${1:-}" = "--tag" ]; then tag=true; shift; fi
rev="${1:-HEAD}"

hash="$(
  { echo "fallback-recipe-v1"
    git ls-tree -r "${rev}" -- scripts/build-wasm-fallback.sh scripts/patches
  } | shasum -a 256 | cut -d' ' -f1
)"
if [ "${tag}" = true ]; then echo "fallback-${hash:0:16}"; else echo "${hash}"; fi
