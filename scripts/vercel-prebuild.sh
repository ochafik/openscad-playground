#!/bin/bash
# Pre-build step for the Vercel deployment (see vercel.json).
#
# The WASM build and library archives are produced by `npm run build:all`
# from the pinned sources in libs-config.json, so nothing needs to be
# downloaded from a CDN here.
#
# The optional wasm2js fallback (public/openscad.fallback.js, ~22 MB) is NOT
# built on Vercel: it needs a patched Binaryen and the OpenSCAD toolchain
# (see docs/WASM_FALLBACK.md). To ship it with the deployment, host a prebuilt
# copy somewhere and set OPENSCAD_FALLBACK_URL in the Vercel project; it is
# then fetched into public/ and copied into dist/ by webpack.
# TODO: no default URL is configured; without the variable the deployment has
# no JS fallback and WebAssembly-less browsers get the "rendering unavailable"
# banner.
set -euo pipefail

if [ -n "${OPENSCAD_FALLBACK_URL:-}" ]; then
  echo "Fetching wasm2js fallback from ${OPENSCAD_FALLBACK_URL}"
  curl -fSL "${OPENSCAD_FALLBACK_URL}" -o public/openscad.fallback.js
else
  echo "OPENSCAD_FALLBACK_URL not set: deploying without the wasm2js fallback."
fi
