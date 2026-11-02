#!/bin/bash
# Bundles the MCP server (server/vercel-entry.ts + deps) into api/_server.mjs,
# imported by api/mcp.ts. ESM because the package is "type": "module"; the
# banner provides `require` for CommonJS dependencies inside the bundle.
set -euo pipefail
cd "$(dirname "$0")/../server"
npx esbuild vercel-entry.ts --bundle --platform=node --format=esm \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=../api/_server.mjs
