/**
 * E2E test for the OpenSCAD MCP server.
 * Tests all tools via the MCP SDK client over Streamable HTTP.
 *
 * Usage: node --import tsx test-e2e.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "./openscad-server.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import type { Server } from "http";

// ─── Test utilities ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${message}`);
    throw new Error(message);
  }
  passed++;
  console.log(`  PASS: ${message}`);
}

function assertIncludes(haystack: string, needle: string, context: string) {
  assert(haystack.includes(needle), `${context}: expected to include "${needle}", got: ${haystack.slice(0, 200)}`);
}

function getToolResultText(result: any): string {
  const text = result?.content?.[0]?.text;
  assert(typeof text === "string", "Tool result has text content");
  return text;
}

function parseToolResultJson(result: any): any {
  return JSON.parse(getToolResultText(result));
}

// ─── Server setup ──────────────────────────────────────────────────────

async function startTestServer(port: number): Promise<Server> {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use(cors());

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(port, () => {
      resolve(httpServer);
    });
  });
}

async function createClient(port: number): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
  );
  return client;
}

// ─── Tests ─────────────────────────────────────────────────────────────

async function testListTools(client: Client) {
  console.log("\n--- Test: List Tools ---");
  const { tools } = await client.listTools();
  const toolNames = tools.map((t: any) => t.name);

  const expectedTools = [
    "create",
    "interact",
    "poll_commands",
  ];

  for (const name of expectedTools) {
    assert(toolNames.includes(name), `Tool "${name}" is registered`);
  }

  // Verify old tools are gone
  const removedTools = [
    "openscad_write_source", "openscad_edit_source", "openscad_read_source",
    "openscad_set_camera", "openscad_set_var", "openscad_set_vars", "openscad_render",
    "_openscad_poll_actions", "_openscad_submit_result",
  ];
  for (const name of removedTools) {
    assert(!toolNames.includes(name), `Old tool "${name}" is no longer registered`);
  }
}

async function testListResources(client: Client) {
  console.log("\n--- Test: List Resources ---");
  const { resources } = await client.listResources();
  assert(resources.length > 0, "At least one resource registered");
  const viewer = resources.find((r: any) => r.uri === "ui://openscad/viewer.html");
  assert(!!viewer, "Viewer UI resource found");
}

async function testReadResource(client: Client) {
  console.log("\n--- Test: Read Resource ---");
  const result = await client.readResource({ uri: "ui://openscad/viewer.html" });
  const content = result.contents[0];
  assert(!!content, "Resource has content");
  assert(typeof (content as any).text === "string", "Content is text");
  assertIncludes((content as any).text, 'name="openscad-base-url"', "HTML contains base URL meta tag");
  assertIncludes((content as any).text, "index.js", "HTML loads index.js");
}

async function testCreateBasic(client: Client, appClient: Client): Promise<string> {
  console.log("\n--- Test: openscad_create (basic) ---");
  const result = await client.callTool({
    name: "create",
    arguments: {},
  });
  const text = getToolResultText(result);
  assertIncludes(text, "viewUUID:", "Result text mentions viewUUID");

  // Extract viewUUID from text
  const match = text.match(/viewUUID:\s*([0-9a-f-]+)/);
  assert(!!match, "viewUUID found in text");
  const viewUUID = match![1];
  assert(typeof viewUUID === "string" && viewUUID.length > 0, `viewUUID returned: ${viewUUID}`);

  // Check _meta has viewUUID
  assert((result as any)._meta?.viewUUID === viewUUID, "viewUUID in _meta matches text");

  // Drain initial commands (write_source + set_camera from defaults)
  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const pollData = parseToolResultJson(pollResult);
  assert(pollData.commands.length === 2, `Expected 2 initial commands (write_source + set_camera), got ${pollData.commands.length}`);

  return viewUUID;
}

async function testCreateWithInitialState(client: Client, appClient: Client) {
  console.log("\n--- Test: openscad_create (with initial state) ---");
  const result = await client.callTool({
    name: "create",
    arguments: {
      source: "cube(10);",
      vars: { size: 20 },
      camera: "front",
    },
  });
  const text = getToolResultText(result);
  const match = text.match(/viewUUID:\s*([0-9a-f-]+)/);
  assert(!!match, "viewUUID in create result");
  const viewUUID = match![1];

  // Poll should return the initial commands
  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const pollData = parseToolResultJson(pollResult);
  const commands = pollData.commands;
  assert(Array.isArray(commands), "Commands is an array");
  assert(commands.length === 3, `Expected 3 initial commands, got ${commands.length}`);

  assert(commands[0].type === "write_source", "First command is write_source");
  assert(commands[0].content === "cube(10);", "write_source has correct content");

  assert(commands[1].type === "set_vars", "Second command is set_vars");
  assert(commands[1].vars.size === 20, "set_vars has correct vars");

  assert(commands[2].type === "set_camera", "Third command is set_camera");
  assert(commands[2].view === "front", "set_camera has correct view");
}

async function testInteractWriteSource(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (write_source) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "write_source", content: "sphere(5);" },
  });
  const text = getToolResultText(result);
  assertIncludes(text, "Queued write_source", "Response confirms queued");

  // Poll and verify
  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "write_source", "Command type is write_source");
  assert(commands[0].content === "sphere(5);", "Content matches");
}

async function testInteractEditSource(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (edit_source) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "edit_source", old_text: "sphere(5)", new_text: "cylinder(10, 5, 5)" },
  });
  const text = getToolResultText(result);
  assertIncludes(text, "Queued edit_source", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "edit_source", "Command type is edit_source");
  assert(commands[0].old_text === "sphere(5)", "old_text matches");
  assert(commands[0].new_text === "cylinder(10, 5, 5)", "new_text matches");
}

async function testInteractReadSource(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (read_source) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "read_source" },
  });
  const text = getToolResultText(result);
  assertIncludes(text, "Queued read_source", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "read_source", "Command type is read_source");
}

async function testInteractSetCamera(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (set_camera preset) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_camera", view: "front" },
  });
  assertIncludes(getToolResultText(result), "Queued set_camera", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "set_camera", "Command type is set_camera");
  assert(commands[0].view === "front", "Camera preset is 'front'");
}

async function testInteractSetCameraCustom(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (set_camera custom) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_camera", theta: 1.57, phi: 0.78 },
  });
  assertIncludes(getToolResultText(result), "Queued set_camera", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands[0].theta === 1.57, "theta matches");
  assert(commands[0].phi === 0.78, "phi matches");
}

async function testInteractSetVar(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (set_var) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_var", name: "radius", value: 10 },
  });
  assertIncludes(getToolResultText(result), "Queued set_var", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands[0].type === "set_var", "Command type is set_var");
  assert(commands[0].name === "radius", "Variable name matches");
  assert(commands[0].value === 10, "Variable value matches");
}

async function testInteractSetVars(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (set_vars) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_vars", vars: { radius: 20, height: 30 } },
  });
  assertIncludes(getToolResultText(result), "Queued set_vars", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands[0].type === "set_vars", "Command type is set_vars");
  assert(commands[0].vars.radius === 20, "radius matches");
  assert(commands[0].vars.height === 30, "height matches");
}

async function testInteractRender(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (render) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "render" },
  });
  assertIncludes(getToolResultText(result), "Queued render", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands[0].type === "render", "Command type is render");
}

async function testInteractBatching(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: Command batching ---");

  // Send multiple commands quickly
  await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "write_source", content: "cube(1);" },
  });
  await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_camera", view: "top" },
  });
  await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "render" },
  });

  // Poll should return all commands at once
  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 3, `Expected 3 batched commands, got ${commands.length}`);
  assert(commands[0].type === "write_source", "First batched command is write_source");
  assert(commands[1].type === "set_camera", "Second batched command is set_camera");
  assert(commands[2].type === "render", "Third batched command is render");
}

async function testInteractValidation(client: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact validation ---");

  // Missing required field for write_source
  const r1 = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "write_source" },
  });
  assert((r1 as any).isError === true, "write_source without content is an error");
  assertIncludes(getToolResultText(r1), "content", "Error mentions missing field");

  // Missing required field for edit_source
  const r2 = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "edit_source", old_text: "foo" },
  });
  assert((r2 as any).isError === true, "edit_source without new_text is an error");

  // Missing required field for set_var
  const r3 = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_var", value: 10 },
  });
  assert((r3 as any).isError === true, "set_var without name is an error");

  // Missing required field for set_vars
  const r4 = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "set_vars" },
  });
  assert((r4 as any).isError === true, "set_vars without vars is an error");
}

async function testInteractUnknownViewUUID(client: Client) {
  console.log("\n--- Test: openscad_interact unknown viewUUID ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID: "nonexistent-uuid", action: "render" },
  });
  assert((result as any).isError === true, "Error for unknown viewUUID");
  assertIncludes(getToolResultText(result), "nonexistent-uuid", "Error mentions the UUID");
}

async function testPollEmptyQueue(client: Client) {
  console.log("\n--- Test: Poll empty queue ---");

  // Create a fresh view
  const createResult = await client.callTool({
    name: "create",
    arguments: {},
  });
  const text = getToolResultText(createResult);
  const match = text.match(/viewUUID:\s*([0-9a-f-]+)/);
  const viewUUID = match![1];

  // First poll drains initial commands from create
  const firstPoll = await client.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const firstData = parseToolResultJson(firstPoll);
  assert(firstData.commands.length > 0, "First poll returns initial commands");

  // Second poll should be empty (with timeout — don't wait the full 20s)
  const pollResult = await client.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const data = parseToolResultJson(pollResult);
  assert(Array.isArray(data.commands), "Commands is an array");
  assert(data.commands.length === 0, "No commands queued after drain");
}

async function testInteractZoom(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (zoom) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "zoom", factor: 0.5 },
  });
  assertIncludes(getToolResultText(result), "Queued zoom", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "zoom", "Command type is zoom");
  assert(commands[0].factor === 0.5, "Zoom factor matches");
}

async function testInteractAutoFit(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (auto_fit) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "auto_fit" },
  });
  assertIncludes(getToolResultText(result), "Queued auto_fit", "Response confirms queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "auto_fit", "Command type is auto_fit");
}

async function testInteractCommandsArray(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: openscad_interact (commands array) ---");

  const result = await client.callTool({
    name: "interact",
    arguments: {
      viewUUID,
      commands: [
        { action: "write_source", content: "cube(5);" },
        { action: "set_camera", view: "top" },
        { action: "zoom", factor: 0.8 },
      ],
    },
  });
  assertIncludes(getToolResultText(result), "Queued 3 commands", "Response confirms 3 queued");

  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 3, `Expected 3 commands, got ${commands.length}`);
  assert(commands[0].type === "write_source", "First is write_source");
  assert(commands[1].type === "set_camera", "Second is set_camera");
  assert(commands[2].type === "zoom", "Third is zoom");
}

async function testSubmitResult(client: Client, appClient: Client, viewUUID: string) {
  console.log("\n--- Test: submit_result ---");

  // Enqueue a get_state command (which creates a pending request)
  const interactPromise = client.callTool({
    name: "interact",
    arguments: { viewUUID, action: "get_state" },
  });

  // Poll to get the command with its requestId
  const pollResult = await appClient.callTool({
    name: "poll_commands",
    arguments: { viewUUID },
  });
  const { commands } = parseToolResultJson(pollResult);
  assert(commands.length === 1, "One command queued");
  assert(commands[0].type === "get_state", "Command is get_state");
  const requestId = commands[0].requestId;
  assert(typeof requestId === "string", "requestId is present");

  // Submit result back
  const submitResult = await appClient.callTool({
    name: "submit_result",
    arguments: { requestId, data: { source: "cube(10);", errors: [] } },
  });
  assertIncludes(getToolResultText(submitResult), "OK", "submit_result succeeds");

  // The interact call should now resolve with the state
  const interactResult = await interactPromise;
  const state = JSON.parse(getToolResultText(interactResult));
  assert(state.source === "cube(10);", "State source matches submitted data");
  assert(Array.isArray(state.errors), "State errors is an array");

  // submit_result for unknown requestId should error
  const badResult = await appClient.callTool({
    name: "submit_result",
    arguments: { requestId: "nonexistent-id", data: {} },
  });
  assert((badResult as any).isError === true, "Unknown requestId returns error");
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const port = 13579; // Use a non-standard port for tests
  console.log(`Starting test server on port ${port}...`);
  const httpServer = await startTestServer(port);

  try {
    const modelClient = await createClient(port);
    const appClient = await createClient(port);

    // Tool and resource listing
    await testListTools(modelClient);
    await testListResources(modelClient);
    await testReadResource(modelClient);

    // Create
    const viewUUID = await testCreateBasic(modelClient, appClient);
    await testCreateWithInitialState(modelClient, appClient);

    // Interact with all actions
    await testInteractWriteSource(modelClient, appClient, viewUUID);
    await testInteractEditSource(modelClient, appClient, viewUUID);
    await testInteractReadSource(modelClient, appClient, viewUUID);
    await testInteractSetCamera(modelClient, appClient, viewUUID);
    await testInteractSetCameraCustom(modelClient, appClient, viewUUID);
    await testInteractSetVar(modelClient, appClient, viewUUID);
    await testInteractSetVars(modelClient, appClient, viewUUID);
    await testInteractRender(modelClient, appClient, viewUUID);
    await testInteractZoom(modelClient, appClient, viewUUID);
    await testInteractAutoFit(modelClient, appClient, viewUUID);

    // Commands array
    await testInteractCommandsArray(modelClient, appClient, viewUUID);

    // Batching (multiple individual calls)
    await testInteractBatching(modelClient, appClient, viewUUID);

    // Request-response
    await testSubmitResult(modelClient, appClient, viewUUID);

    // Validation
    await testInteractValidation(modelClient, viewUUID);
    await testInteractUnknownViewUUID(modelClient);

    // Polling
    await testPollEmptyQueue(appClient);

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${"=".repeat(50)}`);

    await modelClient.close();
    await appClient.close();
  } finally {
    httpServer.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
