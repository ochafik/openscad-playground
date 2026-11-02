/**
 * Vercel entry point — bundles all server logic + deps into a single file.
 * Built by esbuild during the Vercel build step.
 */

export { createServer } from "./openscad-server.js";
export { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
