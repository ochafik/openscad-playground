#!/usr/bin/env bash
#
# build-wasm-fallback.sh — build a pure-JavaScript (wasm2js) OpenSCAD module
# for devices where WebAssembly is disabled (iOS/macOS Lockdown Mode, a strict
# Content-Security-Policy, locked-down enterprise browsers, very old browsers).
#
#   Output:   public/openscad.fallback.js   — a single self-contained script.
#   Requires: Docker, git, ~6+ GB free disk, and patience (heavy C++ link step).
#
# Why a rebuild, and not a conversion of the existing openscad.wasm?
#   Emscripten removed classic asm.js in 2.0 (2020). The modern JS fallback is
#   wasm2js, a Binaryen pass selected at *link* time via -sWASM=0. OpenSCAD must
#   therefore be re-linked; openscad.wasm cannot be converted in place.
#   See docs/WASM_FALLBACK.md for the full rationale.
#
# This mirrors the upstream openscad-wasm build
# (https://github.com/openscad/openscad-wasm) but overrides the Emscripten link
# flags for a wasm2js target. Flag names occasionally drift between OpenSCAD
# versions — if the build fails, cross-check docs/WASM_FALLBACK.md and the
# Emscripten block of OpenSCAD's CMakeLists.txt.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${ROOT}/libs/openscad-fallback-build"
OUT="${ROOT}/public/openscad.fallback.js"

# Dependency image (CGAL/Boost/GMP/MPFR/... prebuilt for Emscripten), published
# by the openscad-wasm project and used by OpenSCAD's own CI.
BASE_IMAGE="${BASE_IMAGE:-openscad/wasm-base-release:latest}"
OPENSCAD_REPO="${OPENSCAD_REPO:-https://github.com/openscad/openscad.git}"
OPENSCAD_REF="${OPENSCAD_REF:-master}"

command -v docker >/dev/null || { echo "error: Docker is required."  >&2; exit 1; }
command -v git    >/dev/null || { echo "error: git is required."     >&2; exit 1; }

mkdir -p "${WORK}"
cd "${WORK}"

echo ">> Fetching OpenSCAD source (${OPENSCAD_REF})..."
if [ ! -d openscad/.git ]; then
  git clone --recurse-submodules --depth 1 --branch "${OPENSCAD_REF}" \
    "${OPENSCAD_REPO}" openscad
fi

# --- Patch OpenSCAD's Emscripten link flags for a wasm2js target ------------
# wasm2js cannot use an ES module loaded via importScripts, a >2 GB heap,
# WASM_BIGINT, or native wasm exception handling; the wasm-exception abort hook
# is also meaningless without wasm. Rewrite those tokens in OpenSCAD's
# CMakeLists.txt in place. The -fwasm-exceptions -> -fexceptions swap is
# defensive: OpenSCAD already builds with -fexceptions, but native wasm
# exceptions would not survive wasm2js, so guard against upstream drift.
echo ">> Patching CMakeLists.txt for the wasm2js (-sWASM=0) target..."
cd openscad
git checkout -- CMakeLists.txt 2>/dev/null || true
sed -i.bak \
  -e 's/-sEXPORT_ES6=1/-sEXPORT_ES6=0/g' \
  -e 's/-sMAXIMUM_MEMORY=4GB/-sMAXIMUM_MEMORY=2GB/g' \
  -e 's/-sABORT_ON_WASM_EXCEPTIONS//g' \
  -e 's/-fwasm-exceptions/-fexceptions/g' \
  CMakeLists.txt

# Append the wasm2js link flags. Emscripten resolves repeated -s settings
# last-wins, so these take effect regardless of what OpenSCAD already set:
#   -sWASM=0                 : emit wasm2js (pure JS) instead of WebAssembly.
#   -sSINGLE_FILE=1          : one self-contained .js (no .wasm / .mem sidecar).
#   -sWASM_BIGINT=0          : wasm2js rejects WASM_BIGINT (emcc 4.x default-on).
#   -sSUPPORT_LONGJMP=...    : JS-based setjmp/longjmp, so no WebAssembly.Tag.
#   -sMODULARIZE / EXPORT_NAME : pin the global `OpenSCAD` factory the loader
#                              expects (src/runner/openscad-loader.ts).
FALLBACK_LINK_FLAGS="-sWASM=0 -sSINGLE_FILE=1 -sWASM_BIGINT=0 -sSUPPORT_LONGJMP=emscripten -sMODULARIZE=1 -sEXPORT_NAME=OpenSCAD"

echo ">> Building OpenSCAD (wasm2js) inside ${BASE_IMAGE} — this takes a while..."
docker run --rm -v "${WORK}/openscad:/src" -w /src "${BASE_IMAGE}" bash -lc "
  set -euo pipefail
  emcmake cmake -B build-fallback -G Ninja \
    -DBoost_USE_STATIC_RUNTIME=ON -DBoost_USE_STATIC_LIBS=ON \
    -DCMAKE_BUILD_TYPE=Release -DEXPERIMENTAL=ON -DSNAPSHOT=ON \
    -DWASM_BUILD_TYPE=web \
    -DCMAKE_EXE_LINKER_FLAGS='${FALLBACK_LINK_FLAGS}'
  cmake --build build-fallback --parallel || cmake --build build-fallback -j2 || cmake --build build-fallback
"

SRC_JS="${WORK}/openscad/build-fallback/openscad.js"
if [ ! -f "${SRC_JS}" ]; then
  echo "error: build did not produce ${SRC_JS}" >&2
  exit 1
fi

cp "${SRC_JS}" "${OUT}"
echo ">> Wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
echo ">> Done. Rebuild the playground ('npm run build') to include the fallback."
