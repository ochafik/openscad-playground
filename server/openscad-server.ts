import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ACTIONS,
  createQueue,
  dequeueCommands,
  enqueueCommand,
  hasQueue,
  submitResult,
  waitForCommands,
  waitForResult,
  type OpenSCADCommand,
} from "./command-queue.js";

const BASE_URL = process.env.OPENSCAD_BASE_URL ?? "https://ochafik.com/openscad2/";
const RESOURCE_URI = "ui://openscad/viewer.html";

// ─── Default source for the create tool ─────────────────────────────────

const DEFAULT_SOURCE = `// Parametric rounded box — try the customizer!

/* [Dimensions] */
width = 30;   // [10:100]
depth = 20;   // [10:100]
height = 15;  // [5:50]

/* [Style] */
rounding = 3; // [0:0.5:10]
wall = 2;     // [1:0.5:5]

$fn = $preview ? 32 : 64;

difference() {
  minkowski() {
    cube([width - 2*rounding, depth - 2*rounding, height - rounding], center = true);
    sphere(r = rounding);
  }
  translate([0, 0, wall])
    minkowski() {
      cube([width - 2*wall - 2*rounding, depth - 2*wall - 2*rounding, height], center = true);
      sphere(r = max(0.01, rounding - wall));
    }
}`;

// ─── Helpers ────────────────────────────────────────────────────────────

function buildCommand(args: Record<string, unknown>): { value?: OpenSCADCommand; error?: CallToolResult } {
  const action = args.action as string;
  switch (action) {
    case "write_source":
      if (!args.content) return { error: errResult("Missing required field: content") };
      return { value: { type: "write_source", content: args.content as string } };
    case "edit_source":
      if (!args.old_text || args.new_text === undefined) return { error: errResult("Missing required fields: old_text, new_text") };
      return { value: { type: "edit_source", old_text: args.old_text as string, new_text: args.new_text as string } };
    case "read_source":
      return { value: { type: "read_source" } };
    case "set_camera":
      return { value: { type: "set_camera", view: args.view as string | undefined, theta: args.theta as number | undefined, phi: args.phi as number | undefined } };
    case "set_var":
      if (!args.name) return { error: errResult("Missing required field: name") };
      return { value: { type: "set_var", name: args.name as string, value: args.value } };
    case "set_vars":
      if (!args.vars) return { error: errResult("Missing required field: vars") };
      return { value: { type: "set_vars", vars: args.vars as Record<string, unknown> } };
    case "render":
      return { value: { type: "render" } };
    case "zoom":
      if (args.factor === undefined) return { error: errResult("Missing required field: factor") };
      return { value: { type: "zoom", factor: args.factor as number } };
    case "auto_fit":
      return { value: { type: "auto_fit" } };
    default:
      return { error: errResult(`Unknown action: ${action}`) };
  }
}

function errResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ─── Server ─────────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({
    name: "OpenSCAD Playground",
    version: "0.1.0",
  });

  // ─── Create tool (app tool — opens the viewer) ─────────────────────

  registerAppTool(server, "create", {
    title: "Create OpenSCAD Viewer",
    description:
      "Opens an interactive OpenSCAD 3D viewer. Returns a viewUUID for use with the interact tool. " +
      "Optionally pass initial source code, customizer variables, and camera preset. " +
      "If no source is provided, a default parametric model is shown.",
    inputSchema: {
      source: z.string().default(DEFAULT_SOURCE).describe("OpenSCAD source code (.scad)"),
      vars: z.record(z.unknown()).optional().describe("Initial customizer variable values"),
      camera: z.string().default("diagonal").describe(
        'Camera preset: "diagonal", "front", "right", "back", "left", "top", "bottom"'
      ),
    },
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async ({ source, vars, camera }): Promise<CallToolResult> => {
    const viewUUID = crypto.randomUUID();
    await createQueue(viewUUID);

    // Enqueue initial state commands so the app picks them up on first poll
    await enqueueCommand(viewUUID, { type: "write_source", content: source });
    if (vars) await enqueueCommand(viewUUID, { type: "set_vars", vars });
    await enqueueCommand(viewUUID, { type: "set_camera", view: camera });

    return {
      content: [{
        type: "text",
        text: `OpenSCAD viewer created (viewUUID: ${viewUUID}). Use the interact tool to modify the model, change views, or capture screenshots.`,
      }],
      _meta: { viewUUID },
    };
  });

  // ─── Interact tool (regular tool — visible to model) ────────────────

  server.tool(
    "interact",
    "Send a command to an OpenSCAD viewer.\n\n" +
    "Fire-and-forget actions (result appears in model context):\n" +
    "- write_source: Replace source code entirely\n" +
    "- edit_source: Find-and-replace within source (old_text → new_text)\n" +
    "- read_source: Trigger a context update with current state\n" +
    "- set_camera: Change camera angle (preset name, or theta/phi in radians)\n" +
    "- set_var: Set one customizer parameter (name + value)\n" +
    "- set_vars: Set multiple customizer parameters (vars object)\n" +
    "- render: Full (non-preview) render\n" +
    "- zoom: Zoom by factor (<1 = zoom in, >1 = zoom out, e.g. 0.5 doubles size)\n" +
    "- auto_fit: Reset zoom to fit model in view\n\n" +
    "Request-response actions (return data directly):\n" +
    "- get_screenshot: Capture current view as image\n" +
    "- get_state: Read current source, errors, warnings, and customizer state\n\n" +
    "You can also pass a `commands` array to batch multiple fire-and-forget actions.",
    {
      viewUUID: z.string().describe("The viewer instance ID from create"),
      action: z.enum(ACTIONS).optional().describe("The action to perform (required unless using commands array)"),
      // write_source
      content: z.string().optional().describe("New source code (for write_source)"),
      // edit_source
      old_text: z.string().optional().describe("Text to find (for edit_source)"),
      new_text: z.string().optional().describe("Replacement text (for edit_source)"),
      // set_camera
      view: z.string().optional().describe(
        'Camera preset name: "diagonal", "front", "right", "back", "left", "top", "bottom"'
      ),
      theta: z.number().optional().describe("Horizontal angle in radians (for set_camera)"),
      phi: z.number().optional().describe("Vertical angle in radians (for set_camera)"),
      // set_var
      name: z.string().optional().describe("Variable name (for set_var)"),
      value: z.unknown().optional().describe("Variable value (for set_var)"),
      // set_vars
      vars: z.record(z.unknown()).optional().describe("Map of variable names to values (for set_vars)"),
      // zoom
      factor: z.number().optional().describe("Zoom factor (<1 zooms in, >1 zooms out, e.g. 0.5 doubles size)"),
      // batch
      commands: z.array(z.object({
        action: z.enum(ACTIONS),
        content: z.string().optional(),
        old_text: z.string().optional(),
        new_text: z.string().optional(),
        view: z.string().optional(),
        theta: z.number().optional(),
        phi: z.number().optional(),
        name: z.string().optional(),
        value: z.unknown().optional(),
        vars: z.record(z.unknown()).optional(),
        factor: z.number().optional(),
      })).optional().describe("Batch of fire-and-forget commands to execute in order"),
    },
    async (args): Promise<CallToolResult> => {
      const { viewUUID } = args;
      if (!await hasQueue(viewUUID)) {
        return errResult(`Unknown viewUUID: ${viewUUID}`);
      }

      // ── Batch mode ──
      if (args.commands && args.commands.length > 0) {
        for (const cmd of args.commands) {
          const result = buildCommand(cmd as Record<string, unknown>);
          if (result.error) return result.error;
          await enqueueCommand(viewUUID, result.value!);
        }
        return {
          content: [{ type: "text", text: `Queued ${args.commands.length} commands for ${viewUUID}.` }],
        };
      }

      if (!args.action) {
        return errResult("Either 'action' or 'commands' is required.");
      }

      // ── Request-response: get_screenshot ──
      if (args.action === "get_screenshot") {
        const requestId = crypto.randomUUID();
        await enqueueCommand(viewUUID, { type: "get_screenshot", requestId });
        try {
          const result = await waitForResult(requestId) as { screenshot?: string };
          if (result?.screenshot) {
            const base64 = result.screenshot.includes(',')
              ? result.screenshot.split(',')[1]
              : result.screenshot;
            return {
              content: [
                { type: "image", data: base64, mimeType: "image/png" },
                { type: "text", text: "Screenshot captured." },
              ],
            };
          }
          return errResult("Screenshot capture failed: no image data.");
        } catch (e) {
          return errResult(`Screenshot failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      // ── Request-response: get_state ──
      if (args.action === "get_state") {
        const requestId = crypto.randomUUID();
        await enqueueCommand(viewUUID, { type: "get_state", requestId });
        try {
          const state = await waitForResult(requestId) as Record<string, unknown>;
          return {
            content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
          };
        } catch (e) {
          return errResult(`get_state failed: ${e instanceof Error ? e.message : e}`);
        }
      }

      // ── Fire-and-forget ──
      const result = buildCommand(args as Record<string, unknown>);
      if (result.error) return result.error;
      await enqueueCommand(viewUUID, result.value!);
      return {
        content: [{ type: "text", text: `Queued ${args.action} command for ${viewUUID}.` }],
      };
    },
  );

  // ─── Poll tool (app-only, long-polling) ─────────────────────────────

  registerAppTool(server, "poll_commands", {
    title: "Poll Commands",
    description: "Internal: App polls for pending commands. Uses long-polling (up to 30s hold).",
    inputSchema: {
      viewUUID: z.string(),
    },
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  }, async ({ viewUUID }): Promise<CallToolResult> => {
    // Long-poll: parks until commands arrive or 30s timeout
    await waitForCommands(viewUUID);
    const commands = await dequeueCommands(viewUUID);
    return {
      content: [{ type: "text", text: JSON.stringify({ commands }) }],
    };
  });

  // ─── Submit result tool (app-only, for request-response bridge) ─────

  registerAppTool(server, "submit_result", {
    title: "Submit Result",
    description: "Internal: App submits results for request-response commands (screenshots, state).",
    inputSchema: {
      requestId: z.string().describe("The requestId from the command"),
      data: z.record(z.unknown()).describe("Result data"),
    },
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
  }, async ({ requestId, data }): Promise<CallToolResult> => {
    const found = await submitResult(requestId, data);
    return {
      content: [{ type: "text", text: found ? "OK" : `No pending request: ${requestId}` }],
      ...(!found && { isError: true }),
    };
  });

  // ─── UI Resource ───────────────────────────────────────────────────

  registerAppResource(server, "OpenSCAD Viewer", RESOURCE_URI, {
    description: "Interactive OpenSCAD 3D viewer and editor",
    _meta: {
      ui: {
        csp: {
          resourceDomains: [new URL(BASE_URL).origin],
          connectDomains: [new URL(BASE_URL).origin, "blob:", "data:"],
        },
        permissions: { clipboardWrite: {} },
      },
    },
  }, async (): Promise<ReadResourceResult> => {
    const html = buildAppHtml(BASE_URL);
    return {
      contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
    };
  });

  return server;
}

/**
 * Build the MCP App HTML that loads the OpenSCAD playground.
 */
function buildAppHtml(baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const cacheBust = `?v=${Date.now()}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="openscad-base-url" content="${base}">
  <title>OpenSCAD Playground</title>

  <!-- No prefetch links: assets are fetched on-demand by the app -->

  <script type="module" src="${base}model-viewer.min.js${cacheBust}" defer></script>
  <script src="${base}browserfs.min.js${cacheBust}" defer></script>
  <script src="${base}index.js${cacheBust}" defer></script>

  <style>
    #root, body, html {
      display: flex;
      flex-direction: column;
      flex: 1;
      margin: 0;
      height: 100vh;
      height: var(--app-height);
      overflow: hidden;
    }
    .p-tabmenu-nav { justify-content: center; }
    .p-fieldset .p-fieldset-content { padding: 0 !important; }
    .p-fieldset-legend { background-color: rgba(255,255,255,0.4) !important; }
    .p-fieldset-legend, .p-fieldset-content { padding-top: 0 !important; padding-bottom: 0 !important; }
    .absolute-fill { position: absolute; top: 0; right: 0; left: 0; bottom: 0; }
    .opacity-animated { transition: opacity 0.5s ease-in-out; }
    .opacity-0 { opacity: 0; }
  </style>
</head>
<body>
  <noscript>You need to enable JavaScript to run the OpenSCAD Playground.</noscript>
  <div id="root"></div>
</body>
</html>`;
}
