import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// These tests boot the real server as a child process and drive it with a real
// MCP client over Streamable HTTP. What they pin is the session lifecycle: a
// client can terminate its session, and the server actually forgets it. DELETE
// is the only request that fires onsessionclosed, so without its route the
// `transports` map grows by one transport (and one Server) per CLI run on a
// long-lived Node. Tool execution is not covered here — that needs a real Node
// with the Kali binaries installed.

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

async function connectClient() {
    const client = new Client(
        { name: "mshin-transport-test", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl));
    await client.connect(transport);
    return { client, transport };
}

before(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    // These tests pin the session lifecycle, not auth: boot the server without
    // a token even when the host shell exports MSHIN_NODE_TOKEN (a configured
    // deployment does), or every /mcp request answers 401.
    const env = { ...process.env, MSHIN_NODE_PORT: String(port) };
    delete env.MSHIN_NODE_TOKEN;
    child = spawn(process.execPath, [ENTRY, "--tools", "nmap,whois"], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.resume();
    await waitForHealth(`${baseUrl}/health`);
});

after(() => {
    child?.kill();
});

test("health reports only the enabled tools", async () => {
    const body = await waitForHealth(`${baseUrl}/health`);
    assert.equal(body.status, "ok");
    assert.deepEqual(body.tools, ["nmap", "whois"]);
});

test("a client can initialize and list tools over Streamable HTTP", async () => {
    const { client, transport } = await connectClient();
    assert.ok(transport.sessionId, "server must assign a session id");

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["nmap", "whois"]);

    await transport.terminateSession();
    await client.close();
});

test("terminateSession succeeds and the server forgets the session", async () => {
    const { client, transport } = await connectClient();
    const sessionId = transport.sessionId;

    // Would throw before the DELETE /mcp route existed: the SDK accepts only
    // 200 or 405 here, and Express answered an unrouted DELETE with 404.
    await transport.terminateSession();
    await client.close();

    // The session must be gone from the server's map, not merely closed
    // client-side.
    const res = await fetch(new URL("/mcp", baseUrl), {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId },
    });
    assert.equal(res.status, 404);
    await res.body?.cancel();
});

test("requests for an unknown session are rejected", async () => {
    for (const method of ["GET", "DELETE"]) {
        const res = await fetch(new URL("/mcp", baseUrl), {
            method,
            headers: { "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
        });
        assert.equal(res.status, 404, `${method} with an unknown session must 404`);
        await res.body?.cancel();
    }
});
