#!/usr/bin/env bash
#
# build-wasm-fallback.sh — build a pure-JavaScript (wasm2js) OpenSCAD module
# for devices where WebAssembly is disabled (iOS/macOS Lockdown Mode, a strict
# Content-Security-Policy, locked-down enterprise browsers, very old browsers).
#
#   Output:   public/openscad.fallback.js   — a single self-contained script.
#   Requires: Docker, git, ~6+ GB free disk, and patience.
#
# Why a rebuild, and not a conversion of the existing openscad.wasm?
#   Emscripten removed classic asm.js in 2.0 (2020). The modern JS fallback is
#   wasm2js, a Binaryen pass selected at *link* time via -sWASM=0. OpenSCAD
#   must therefore be re-linked; openscad.wasm cannot be converted in place.
#
# Why the *patched* Binaryen from ochafik/binaryen?
#   Upstream wasm2js produces deeply-nested JS (~1500 levels deep) for
#   OpenSCAD-scale modules — browser JS engines can't compile it. The patch
#   bounds the nesting depth (flattens deep block/if chains into a shallow
#   `while(1){switch(state){…}}` dispatch loop). Without it the generated
#   fallback file fails to parse in the browser.
#
# See docs/WASM_FALLBACK.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${ROOT}/libs/openscad-fallback-build"
OUT="${ROOT}/public/openscad.fallback.js"

# Patched Binaryen (wasm2js chain-flattening fix).
BINARYEN_REPO="${BINARYEN_REPO:-https://github.com/ochafik/binaryen.git}"
BINARYEN_REF="${BINARYEN_REF:-wasm2js-flatten-deep-control-flow}"

# Optional override: skip the Binaryen Linux build and use an existing
# patched `wasm2js` binary (Linux ELF) at this path.
PATCHED_WASM2JS="${PATCHED_WASM2JS:-}"

# Dependency image (CGAL/Boost/GMP/MPFR/... prebuilt for Emscripten), used
# by openscad-wasm and OpenSCAD's own CI.
BASE_IMAGE="${BASE_IMAGE:-openscad/wasm-base-release:latest}"
OPENSCAD_REPO="${OPENSCAD_REPO:-https://github.com/openscad/openscad.git}"
OPENSCAD_REF="${OPENSCAD_REF:-master}"

command -v docker >/dev/null || { echo "error: Docker is required."  >&2; exit 1; }
command -v git    >/dev/null || { echo "error: git is required."     >&2; exit 1; }

mkdir -p "${WORK}"
cd "${WORK}"

# --- 1. Patched Binaryen (Linux native build) ------------------------------
# We need a NATIVE Linux wasm2js binary to mount into the emsdk inside the
# openscad build container — not a wasm-targeted build.
if [ -z "${PATCHED_WASM2JS}" ]; then
  echo ">> Fetching patched Binaryen (${BINARYEN_REF}) from ${BINARYEN_REPO}..."
  if [ ! -d binaryen/.git ]; then
    git clone --recurse-submodules --depth 1 --branch "${BINARYEN_REF}" \
      "${BINARYEN_REPO}" binaryen
  fi
  if [ ! -x binaryen/build-linux/bin/wasm2js ]; then
    echo ">> Building patched Binaryen wasm2js (native Linux)..."
    docker run --rm -v "${WORK}/binaryen:/src" -w /src ubuntu:22.04 bash -lc '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq cmake ninja-build g++ python3
      cmake -B build-linux -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF
      cmake --build build-linux --target wasm2js --parallel
    '
  fi
  PATCHED_WASM2JS="${WORK}/binaryen/build-linux/bin/wasm2js"
fi
[ -x "${PATCHED_WASM2JS}" ] || { echo "error: patched wasm2js not found/executable at ${PATCHED_WASM2JS}" >&2; exit 1; }
echo ">> Using patched wasm2js: ${PATCHED_WASM2JS}"

# --- 2. OpenSCAD source ----------------------------------------------------
echo ">> Fetching OpenSCAD source (${OPENSCAD_REF})..."
if [ ! -d openscad/.git ]; then
  git clone --recurse-submodules --depth 1 --branch "${OPENSCAD_REF}" \
    "${OPENSCAD_REPO}" openscad
fi

# --- 3. Patch OpenSCAD's Emscripten link flags for a wasm2js target -------
# wasm2js cannot use an ES module loaded via importScripts, a >2 GB heap,
# WASM_BIGINT, or native wasm exception handling; the wasm-exception abort
# hook is also meaningless without wasm. Rewrite those tokens in OpenSCAD's
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

# --- 4. Build OpenSCAD with -sWASM=0 using the patched wasm2js -------------
# Bind-mount the patched wasm2js binary over the emsdk's wasm2js inside the
# build container, so emcc picks it up during the -sWASM=0 link.
echo ">> Building OpenSCAD (wasm2js) inside ${BASE_IMAGE}, using patched wasm2js..."
docker run --rm \
  -v "${WORK}/openscad:/src" \
  -v "${PATCHED_WASM2JS}:/emsdk/upstream/bin/wasm2js:ro" \
  -w /src "${BASE_IMAGE}" bash -lc "
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
