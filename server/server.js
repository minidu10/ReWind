#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge, DEFAULT_PORT } from "./lib/bridge.js";
import { createSourceMapper } from "./lib/sourcemap.js";
import { DEFAULT_WINDOW_MS, Store } from "./lib/store.js";
import { registerTools } from "./lib/tools.js";

// stdout carries the MCP protocol, so all logging goes to stderr.
const log = (message) => process.stderr.write(`[rewind] ${message}\n`);

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const port = process.env.REWIND_PORT === undefined ? DEFAULT_PORT : Number(process.env.REWIND_PORT);
const windowMs = positiveNumber(process.env.REWIND_WINDOW_SECONDS, DEFAULT_WINDOW_MS / 1000) * 1000;
const extensionId = process.env.REWIND_EXTENSION_ID?.trim() || undefined;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  log(`REWIND_PORT must be a port number, got "${process.env.REWIND_PORT}"`);
  process.exit(1);
}
if (extensionId && !/^[a-p]{32}$/.test(extensionId)) {
  log("REWIND_EXTENSION_ID must be the 32-letter extension ID shown in chrome://extensions");
  process.exit(1);
}

const store = new Store({ windowMs });
const bridge = new Bridge({ store, port, extensionId, log });
const mapper = createSourceMapper();

const server = new McpServer(
  { name: "rewind", version: "0.1.0" },
  {
    instructions:
      "Rewind records what happens in one Chrome tab (user actions, network requests, console output, exceptions, page changes). " +
      "When the user reports a bug in their web app, call get_errors or explain_error to see what happened instead of guessing, " +
      "and call check_fix after changing code to confirm the error is gone."
  }
);
registerTools(server, { store, bridge, mapper });

await bridge.start();
if (bridge.listening) log(`waiting for the Chrome extension on ws://127.0.0.1:${bridge.port}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await bridge.close().catch(() => {});
  process.exit(0);
}

const transport = new StdioServerTransport();
transport.onclose = shutdown;
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(transport);
