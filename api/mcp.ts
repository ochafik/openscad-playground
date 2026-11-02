/**
 * Vercel serverless function for the MCP endpoint.
 *
 * Imports from api/_server.mjs which is pre-bundled by esbuild during
 * the Vercel build step (includes all MCP SDK + server deps).
 *
 * The server is stateless — all viewer interaction happens through app
 * tools the view registers with the host — so each invocation creates a
 * fresh server + transport pair.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
// Built by esbuild before deploy (see vercel.json); the package is "type": "module".
// @ts-ignore: generated file, absent at type-check time
import { createServer, resolveBaseUrl, NodeStreamableHTTPServerTransport } from "./_server.mjs";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    // Asset base follows the request host (X-Forwarded-Host is trusted on
    // Vercel), so any deployment URL works without configuration.
    const server = createServer(resolveBaseUrl(req));
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    console.error(`MCP error (${req.method}):`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: error?.message ?? "Internal server error" },
        id: null,
      });
    }
  }
}
