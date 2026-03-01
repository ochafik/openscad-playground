#!/usr/bin/env node

import * as path from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { createServer } from "./openscad-server.js";
import { isRedisEnabled, closeRedis } from "./redis-client.js";
import { shutdownQueue } from "./command-queue.js";

const DIST_DIR = process.env.OPENSCAD_DIST_DIR ?? path.resolve(import.meta.dirname ?? __dirname, "../dist");

async function startStreamableHTTPServer(): Promise<void> {
  const host = process.env.HOST ?? "localhost";
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const selfServe = process.argv.includes("--serve-dist") || !!process.env.OPENSCAD_SERVE_DIST;

  const app = createMcpExpressApp({ host });
  app.use(cors());

  app.use((req: Request, _res: Response, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} [${req.headers['host']}]`);
    next();
  });

  // Optionally serve dist/ files — enables self-contained mode
  // where BASE_URL points to this server instead of a CDN.
  if (selfServe) {
    app.use(express.static(DIST_DIR));
    console.log(`Serving dist/ files from ${DIST_DIR}`);
  }

  // Each request gets a fresh McpServer instance. Tool registrations are cheap;
  // state lives in the shared command queue (in-memory or Redis), not the server.
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
      console.error(`MCP error (${req.method}):`, error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
    console.log(`  -> ${res.statusCode} ${req.method} ${req.url}`);
  });

  const httpServer = app.listen(port, host, () => {
    if (isRedisEnabled()) {
      console.log(`Redis enabled: ${process.env.REDIS_URL}`);
    } else {
      console.log("Using in-memory command queue");
    }
    console.log(`OpenSCAD MCP server listening on http://${host}:${port}/mcp`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    await shutdownQueue();
    await closeRedis();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdioServer(): Promise<void> {
  const selfServe = process.argv.includes("--serve-dist") || !!process.env.OPENSCAD_SERVE_DIST;

  // In stdio mode with self-serve, start a lightweight HTTP server for static assets.
  // This lets the MCP App iframe load JS/WASM/CSS without a separate CDN.
  if (selfServe) {
    const assetApp = express();
    assetApp.use(cors());
    assetApp.use(express.static(DIST_DIR));

    const assetPort = parseInt(process.env.ASSET_PORT ?? "0", 10); // 0 = pick free port
    const assetServer = assetApp.listen(assetPort, "127.0.0.1", () => {
      const addr = assetServer.address();
      if (addr && typeof addr === "object") {
        const url = `http://127.0.0.1:${addr.port}/`;
        // Set BASE_URL so createServer() uses it for CSP and HTML generation
        process.env.OPENSCAD_BASE_URL = url;
        console.error(`Serving assets from ${DIST_DIR} at ${url}`);
      }
    });

    // Wait for server to be ready before starting stdio
    await new Promise<void>(resolve => assetServer.on("listening", resolve));
  }

  await createServer().connect(new StdioServerTransport());
  console.error("OpenSCAD MCP server running on stdio");
}

async function main() {
  if (process.argv.includes("--stdio")) {
    await startStdioServer();
  } else {
    await startStreamableHTTPServer();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
