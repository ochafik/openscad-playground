# OpenSCAD MCP Server

An [MCP](https://modelcontextprotocol.io/) server that exposes an interactive OpenSCAD 3D viewer as an [MCP App](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/apps). It lets LLMs create, edit, and render OpenSCAD models through tool calls, while users see a live 3D preview in the host UI.

## Quick Start

```bash
cd server
npm install

# Start the server (Streamable HTTP on port 3001)
npm start

# Or on a custom port
PORT=4000 npm start
```

The MCP endpoint is at `http://localhost:3001/mcp`.

## Transport Modes

The server supports two MCP transports:

### Streamable HTTP (default)

```bash
cd server
npm start
# or: npm run start:http
```

Listens on `http://0.0.0.0:<PORT>/mcp` (default port: 3001). Use this when connecting from MCP hosts that support HTTP-based transports (e.g., Claude Desktop with remote servers, basic-host).

### Stdio

```bash
cd server
npm run start:stdio
```

Communicates over stdin/stdout. Use this for local MCP hosts that launch the server as a subprocess (e.g., Claude Desktop local config).

To serve assets locally in stdio mode (fully self-contained, no CDN):

```bash
cd server
OPENSCAD_SERVE_DIST=1 npm run start:stdio
# or: npm run start:self-serve -- --stdio
```

This starts a lightweight HTTP server on a free port for static assets and automatically sets `OPENSCAD_BASE_URL` to point to it. The CSP headers are configured to allow the app to load from this local server.

> **Note:** The `.npmrc` sets `loglevel=silent` so npm doesn't print its lifecycle banner to stdout (which would corrupt the JSON-RPC stream). The `build` script also redirects its output to stderr (`1>&2`). If you add build steps, make sure they also redirect stdout to stderr.

**Claude Desktop config example** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "openscad": {
      "command": "npm",
      "args": ["run", "start:stdio"],
      "cwd": "/path/to/openscad-playground/server"
    }
  }
}
```

**Self-contained (with local asset serving):**
```json
{
  "mcpServers": {
    "openscad": {
      "command": "npm",
      "args": ["run", "start:stdio"],
      "cwd": "/path/to/openscad-playground/server",
      "env": { "OPENSCAD_SERVE_DIST": "1" }
    }
  }
}
```

## Running with an MCP App Host

### With basic-host (from ext-apps)

```bash
# Terminal 1: Start the OpenSCAD MCP server
cd server
npm start

# Terminal 2: Start the basic-host pointing to the server
cd ../ext-apps/examples/basic-host
SERVERS='["http://localhost:3001/mcp"]' npm start
```

Then open the basic-host URL (usually `http://localhost:3002`) in Chrome.

### Self-serve mode

By default, the app's HTML loads JS/WASM/CSS from the public deployment at `https://ochafik.com/openscad2/`. To serve all static files from the MCP server itself (fully self-contained, no CDN dependency):

```bash
# Make sure the client is built first
cd /path/to/openscad-playground
make public && npm install && npm run build

# Start server with self-serve
cd server
OPENSCAD_BASE_URL=http://localhost:3001/ npm run start:self-serve
```

This adds `express.static` serving of the `dist/` directory and points the app's base URL to the server itself.

## Deployment

### Vercel

The repo root has a `vercel.json` that deploys both the **web app** (static files from `dist/`) and the **MCP endpoint** (serverless function at `/mcp`) from the same project.

1. Set environment variables in your Vercel project:
   - `REDIS_URL` — e.g. an [Upstash Redis](https://upstash.com/) URL (required for serverless — each invocation is stateless)
   - `OPENSCAD_BASE_URL` — set to your Vercel deployment URL (e.g. `https://openscad.vercel.app/`)

2. Deploy from the repo root:
   ```bash
   vercel
   ```

This gives you:
- `https://openscad.vercel.app/` — the standalone web playground
- `https://openscad.vercel.app/mcp` — the MCP endpoint for AI hosts

The CSP headers automatically include the `OPENSCAD_BASE_URL` origin in `resourceDomains` and `connectDomains`, so the MCP App iframe can load scripts and WASM from whatever domain you configure.

### Other platforms (Fly.io, Railway, etc.)

The server is a standard Node.js/Express app. Deploy `server/` with:
- `npm install && npm start` as the start command
- Set `PORT`, `REDIS_URL`, and `OPENSCAD_BASE_URL` environment variables

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server port |
| `HOST` | `localhost` | HTTP server bind address |
| `OPENSCAD_BASE_URL` | `https://ochafik.com/openscad2/` | Base URL for loading app assets (JS, WASM, CSS). Also controls CSP `resourceDomains` and `connectDomains`. |
| `OPENSCAD_DIST_DIR` | `../dist` (relative to server/) | Path to the built dist/ directory (for `--serve-dist`) |
| `OPENSCAD_SERVE_DIST` | _(unset)_ | Set to any value to enable static file serving (alternative to `--serve-dist` flag) |
| `ASSET_PORT` | `0` (auto) | Port for the stdio-mode asset server (only used with `--stdio --serve-dist`) |
| `REDIS_URL` | _(unset)_ | Redis connection URL (e.g. `redis://localhost:6379`). When set, the command queue uses Redis instead of in-memory storage, enabling horizontal scaling across multiple server instances. |

## Tools

### Model tools (visible to LLM)

| Tool | Description |
|---|---|
| `create` | Create a new OpenSCAD viewer. Accepts optional initial `source`, `vars`, and `camera`. Returns a `viewUUID` in `_meta`. |
| `interact` | Send a command to a viewer. Uses an `action` enum with a flat schema of optional fields. All commands are fire-and-forget. |

**`interact` actions:**

| Action | Required fields | Description |
|---|---|---|
| `write_source` | `content` | Replace entire source code |
| `edit_source` | `old_text`, `new_text` | Find-and-replace in source |
| `read_source` | _(none)_ | Trigger a model context refresh with current state |
| `set_camera` | `view` or `theta`+`phi` | Set camera angle (preset name or custom radians) |
| `set_var` | `name`, `value` | Set a single customizer variable |
| `set_vars` | `vars` | Set multiple customizer variables at once |
| `render` | _(none)_ | Trigger a full (non-preview) render |

### Internal tools (app-only, invisible to LLM)

| Tool | Description |
|---|---|
| `poll_commands` | App polls for pending commands from the command queue. |

## Architecture

```
┌─────────────┐   openscad_create    ┌──────────────────┐     postMessage     ┌──────────────┐
│   LLM / AI  │   openscad_interact  │   MCP Server     │ ◀─────────────────▶ │  App (iframe) │
│   (model)   │ ──────────────────▶  │   command queue   │                     │  3D viewer    │
└─────────────┘   fire-and-forget    └──────────────────┘                     └──────────────┘
       ▲                                    ▲                                        │
       │  model context                     │  poll_openscad_commands                │
       └────────────────────────────────────┴────────────────────────────────────────┘
```

1. LLM calls `create` — server returns a `viewUUID` and optionally enqueues initial commands
2. LLM calls `interact` — commands are enqueued (fire-and-forget, returns immediately)
3. The app (running in the host's iframe) polls `poll_commands` every 300ms
4. App processes each command (updates source, renders, etc.)
5. App updates the model context with a screenshot and current state (source, errors, params)

## Testing

```bash
cd server
npm test
```

Runs the E2E test suite that exercises all tools via the MCP SDK client over Streamable HTTP. Tests cover:
- Tool and resource listing (verifies new tools, confirms old tools removed)
- `create` (basic + with initial state)
- `interact` with all actions (write, edit, read, camera, vars, render)
- Command batching (multiple commands in one poll)
- Input validation (missing required fields)
- Error handling (unknown viewUUID, empty queue)

## asm.js Fallback (Optional)

The app uses WebAssembly by default. For environments without WASM support, an optional asm.js variant can be built:

```bash
# From the project root (requires Docker for emscripten)
make asmjs
make src/asmjs   # creates symlink

# Rebuild the client (webpack auto-detects src/asmjs/)
npm run build
```

This produces `openscad-worker-asmjs.js` alongside the regular `openscad-worker.js`. At runtime, the app detects WebAssembly support and automatically falls back to the asm.js worker if available.

**Trade-offs:**
- asm.js binary is ~2-3x larger than WASM
- Runtime performance is ~5-10x slower
- 98%+ of browsers support WASM, so this is rarely needed

## Development

```bash
cd server
npm run dev          # Same as npm start, for development
npm test             # Run E2E tests
```

The server uses `tsx` for direct TypeScript execution — no build step needed for the server itself. The client-side code requires `npm run build` (webpack) from the project root.
