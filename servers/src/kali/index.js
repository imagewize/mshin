#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { tools } from "./tools.js";
import { ALLOWED_TARGETS } from "./config.js";

const PORT = process.env.MSHIN_NODE_PORT
  ? parseInt(process.env.MSHIN_NODE_PORT, 10)
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

console.error(`[INFO] Machin Shin Node starting on port ${PORT}`);
console.error(`[INFO] Enabled tools: ${enabledTools.map((t) => t.name).join(", ")}`);
if (ALLOWED_TARGETS && ALLOWED_TARGETS.length > 0) {
  console.error(`[INFO] Target scope allowlist: ${ALLOWED_TARGETS.join(", ")}`);
} else {
  console.error(`[INFO] No target scope allowlist configured (MSHIN_ALLOWED_TARGETS)`);
}

// Build a fresh Server instance for each client connection. A single Server
// can only be bound to one transport at a time, so sharing one across clients
// (or across reconnects) would clobber the previous session.
function createServer() {
  const server = new Server(
    { name: "mshin-kali-node", version: "1.0.0" },
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

// Active Streamable HTTP transports keyed by session id, so concurrent clients
// (and reconnects) each get their own message channel.
const transports = new Map();

// GET opens the server-to-client stream and DELETE terminates the session.
// Both address a session that already exists, so they share one lookup and let
// the transport dispatch on the method. Without the DELETE route a client's
// terminateSession() gets Express's 404 (the SDK only tolerates 405), and the
// session is never dropped from the map: DELETE is the only path that fires
// onsessionclosed, so a long-lived Node would leak a transport and a Server
// instance per CLI run.
async function routeToSession(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : null;
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", routeToSession);
app.delete("/mcp", routeToSession);

app.post("/mcp", express.json(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session: this must be the initialize request.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      console.error(`[INFO] MCP client connected via Streamable HTTP (session ${sid})`);
    },
    onsessionclosed: (sid) => {
      transports.delete(sid);
      console.error(`[INFO] MCP client session closed (session ${sid})`);
    },
  });

  // A DELETE closes the transport right after onsessionclosed has already
  // dropped the entry; only log here when this handler is the one removing it,
  // so an explicit termination reports once rather than twice.
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports.delete(sid)) {
      console.error(`[INFO] MCP client disconnected (session ${sid})`);
    }
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    tools: enabledTools.map((t) => t.name),
  });
});

app.listen(PORT, () => {
  console.error(`[INFO] Machin Shin Node listening on http://0.0.0.0:${PORT}`);
});
