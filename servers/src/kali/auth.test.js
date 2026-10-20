import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Set the token BEFORE importing config.js, because config.js computes
// AUTH_TOKEN at module load time. This file pins two layers: the pure token
// comparison in config.js, and the HTTP middleware in index.js, exercised by
// booting the real server with MSHIN_NODE_TOKEN set and driving it with real
// requests. The child process inherits process.env, so it picks the token up.

const TOKEN = "test-token-0123456789abcdef";
process.env.MSHIN_NODE_TOKEN = TOKEN;

const { isValidAuthToken, tokensMatch } = await import("./config.js");

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "index.js");

let child;
let baseUrl;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server never became healthy at ${url}`);
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [ENTRY, "--tools", "nmap,whois"], {
    env: { ...process.env, MSHIN_NODE_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.resume();
  await waitForHealth(`${baseUrl}/health`);
});

after(() => {
  child?.kill();
});

test("tokensMatch compares exactly, hashing both sides", () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch("wrong", TOKEN), false);
  assert.equal(tokensMatch(TOKEN, "wrong"), false);
  assert.equal(tokensMatch("", TOKEN), false);
  assert.equal(tokensMatch(TOKEN, ""), false);
  assert.equal(tokensMatch(undefined, TOKEN), false);
  assert.equal(tokensMatch(TOKEN, undefined), false);
});

test("isValidAuthToken accepts the configured token and rejects the rest", () => {
  assert.equal(isValidAuthToken(TOKEN), true);
  assert.equal(isValidAuthToken("wrong"), false);
  assert.equal(isValidAuthToken(undefined), false);
});

test("health stays open without a token", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("POST /mcp without a token is rejected with 401", async () => {
  const res = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /Bearer/);
  await res.body?.cancel();
});

test("POST /mcp with the wrong token is rejected with 401", async () => {
  const res = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer wrong-token",
    },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  await res.body?.cancel();
});

test("GET /mcp without a token is rejected before session lookup", async () => {
  const res = await fetch(new URL("/mcp", baseUrl), {
    headers: { "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
  });
  // 401, not 404: auth runs before the session is looked up.
  assert.equal(res.status, 401);
  await res.body?.cancel();
});

test("a client with the correct token can initialize and list tools", async () => {
  const client = new Client(
    { name: "mshin-auth-test", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  assert.ok(transport.sessionId, "server must assign a session id");

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["nmap", "whois"]);

  await transport.terminateSession();
  await client.close();
});

test("a client without a token cannot initialize", async () => {
  const client = new Client(
    { name: "mshin-auth-test", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl));
  await assert.rejects(client.connect(transport));
  await client.close();
});
