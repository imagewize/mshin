#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { tools } from "./tools.js";

const PORT = process.env.AVENDESORA_NODE_PORT
  ? parseInt(process.env.AVENDESORA_NODE_PORT, 10)
  : 3000;

function parseEnabledTools() {
  const idx = process.argv.indexOf("--tools");
  if (idx === -1 || !process.argv[idx + 1]) {
    return tools.map((t) => t.name);
  }
  return process.argv[idx + 1].split(",").map((s) => s.trim());
}

const enabledNames = new Set(parseEnabledTools());
const enabledTools = tools.filter((t) => enabledNames.has(t.name));

if (enabledTools.length === 0) {
  console.error("[ERROR] No enabled tools matched the --tools list.");
  process.exit(1);
}

console.error(`[INFO] Avendesora Node starting on port ${PORT}`);
console.error(`[INFO] Enabled tools: ${enabledTools.map((t) => t.name).join(", ")}`);

// Build a fresh Server instance for each client connection. A single Server
// can only be bound to one transport at a time, so sharing one across clients
// (or across reconnects) would clobber the previous session.
function createServer() {
  const server = new Server(
    { name: "avendesora-kali-node", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: enabledTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = enabledTools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool '${name}' is not enabled.` }],
        isError: true,
      };
    }

    try {
      return await tool.handler(args || {});
    } catch (err) {
      console.error(`[ERROR] Tool ${name} failed:`, err.message);
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

const app = express();

// Active SSE transports keyed by session id, so concurrent clients (and
// reconnects) each get their own message channel.
const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  console.error(`[INFO] MCP client connected via SSE (session ${transport.sessionId})`);

  res.on("close", () => {
    transports.delete(transport.sessionId);
    console.error(`[INFO] MCP client disconnected (session ${transport.sessionId})`);
  });

  const server = createServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessionId ? transports.get(sessionId) : null;
  if (!transport) {
    res.status(425).send("No active SSE session for the given sessionId");
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    tools: enabledTools.map((t) => t.name),
  });
});

app.listen(PORT, () => {
  console.error(`[INFO] Avendesora Node listening on http://0.0.0.0:${PORT}`);
});
