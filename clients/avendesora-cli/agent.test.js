import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, AgentMemory, ACTIVE_TOOLS } from "./agent.js";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/**
 * A stand-in Ollama server. It answers POST /api/chat from a queue of canned
 * responses shaped exactly like the real Ollama chat API, and records every
 * request body it received so tests can assert on the wire format the agent
 * emits. Because the agent talks to it over real HTTP, the fetch/serialise/
 * parse path — the tool-call formatting the CHANGELOG flagged as untested — is
 * exercised for real, only the model's judgement is faked.
 */
class MockOllama {
  constructor() {
    this.responses = [];
    this.requests = [];
    this.server = null;
    this.url = null;
  }

  /** Queue an assistant turn that asks for a tool call. */
  queueToolCall(name, args, { content = "" } = {}) {
    this.responses.push({
      message: {
        role: "assistant",
        content,
        tool_calls: [{ function: { name, arguments: args } }],
      },
      done: true,
    });
  }

  /** Queue an assistant turn that emits several tool calls at once. */
  queueMultiToolCall(calls) {
    this.responses.push({
      message: {
        role: "assistant",
        content: "",
        tool_calls: calls.map((c) => ({
          function: { name: c.name, arguments: c.args },
        })),
      },
      done: true,
    });
  }

  /** Queue a plain assistant answer with no tool calls (ends the loop). */
  queueFinal(content) {
    this.responses.push({
      message: { role: "assistant", content },
      done: true,
    });
  }

  async start() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        this.requests.push({ url: req.url, body: JSON.parse(body || "{}") });
        const next = this.responses.shift();
        if (!next) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no queued response" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(next));
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop() {
    if (!this.server) return;
    // undici's fetch keeps connections alive, so close() alone would hang until
    // they idle out; drop them so teardown is immediate.
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }
}

/** A stand-in MCP client that records tool calls and returns MCP-shaped content. */
class MockMcpClient {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async callTool({ name, arguments: args }) {
    this.calls.push({ name, args });
    return this.handler(name, args);
  }
}

/** MCP text-content helper mirroring what the real server returns. */
function textContent(text) {
  return { content: [{ type: "text", text }] };
}

const OLLAMA_TOOLS = [
  {
    type: "function",
    function: {
      name: "nmap",
      description: "Run an nmap scan.",
      parameters: { type: "object", properties: { target: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "metasploit",
      description: "Run a metasploit module.",
      parameters: { type: "object", properties: {} },
    },
  },
];

/**
 * Stand up a mock Ollama, a mock MCP client and an agent over a temp memory
 * dir, registering teardown on the test context so a failed assertion can never
 * leave the HTTP server open and hang the run.
 */
async function setup(t, { mcpHandler = () => textContent("ok"), agentOptions = {} } = {}) {
  const ollama = new MockOllama();
  await ollama.start();
  const mcp = new MockMcpClient(mcpHandler);
  const dir = mkdtempSync(join(tmpdir(), "avendesora-test-"));
  const memory = new AgentMemory(dir);
  const agent = new Agent({
    mcpClient: mcp,
    ollamaUrl: ollama.url,
    model: "avendesora",
    tools: OLLAMA_TOOLS,
    memory,
    ...agentOptions,
  });
  t.after(async () => {
    await ollama.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ollama, mcp, agent, memory, dir };
}

// -----------------------------------------------------------------------------
// The request the agent sends to Ollama
// -----------------------------------------------------------------------------

test("sends model, tools and stream:false in the /api/chat body", async (t) => {
  const { ollama, agent } = await setup(t);
  ollama.queueFinal("done");
  await agent.run({ sessionId: "s1", userGoal: "hello" });

  const req = ollama.requests[0];
  assert.equal(req.url, "/api/chat");
  assert.equal(req.body.model, "avendesora");
  assert.equal(req.body.stream, false);
  assert.deepEqual(req.body.tools, OLLAMA_TOOLS);
  assert.equal(req.body.messages[0].role, "system");
  assert.equal(req.body.messages.at(-1).role, "user");
  assert.equal(req.body.messages.at(-1).content, "hello");
});

// -----------------------------------------------------------------------------
// Tool-call parsing and MCP result formatting
// -----------------------------------------------------------------------------

test("parses a tool_call, invokes MCP, feeds the result back, then finishes", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: (name, args) => {
      assert.equal(name, "nmap");
      assert.deepEqual(args, { target: "192.168.1.100" });
      return textContent("PORT 22/tcp open ssh");
    },
  });

  ollama.queueToolCall("nmap", { target: "192.168.1.100" });
  ollama.queueFinal("Host has SSH open on 22.");

  const seen = { call: null, result: null, complete: null };
  const answer = await agent.run({
    sessionId: "s1",
    userGoal: "scan the node",
    onToolCall: (name, args) => (seen.call = { name, args }),
    onToolResult: (name, text) => (seen.result = { name, text }),
    onComplete: (c) => (seen.complete = c),
  });

  assert.equal(mcp.calls.length, 1);
  assert.deepEqual(seen.call, { name: "nmap", args: { target: "192.168.1.100" } });
  assert.equal(seen.result.text, "PORT 22/tcp open ssh");
  assert.equal(answer, "Host has SSH open on 22.");
  assert.equal(seen.complete, "Host has SSH open on 22.");

  const secondTurn = ollama.requests[1].body.messages;
  const toolMsg = secondTurn.find((m) => m.role === "tool");
  assert.equal(toolMsg.name, "nmap");
  assert.equal(toolMsg.content, "PORT 22/tcp open ssh");
});

test("joins MCP content blocks with newlines, blanking non-text parts", async (t) => {
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => ({
      content: [
        { type: "text", text: "line one" },
        { type: "image", data: "ignored" },
        { type: "text", text: "line two" },
      ],
    }),
  });

  ollama.queueToolCall("nmap", { target: "x" });
  ollama.queueFinal("ok");

  let resultText = null;
  await agent.run({
    sessionId: "s1",
    userGoal: "go",
    onToolResult: (_n, text) => (resultText = text),
  });
  // Non-text blocks map to "" and are kept as blank lines between the text.
  assert.equal(resultText, "line one\n\nline two");
});

test("substitutes a placeholder when MCP returns no text content", async (t) => {
  const { ollama, agent } = await setup(t, { mcpHandler: () => ({ content: [] }) });

  ollama.queueToolCall("nmap", { target: "x" });
  ollama.queueFinal("ok");

  let resultText = null;
  await agent.run({
    sessionId: "s1",
    userGoal: "go",
    onToolResult: (_n, text) => (resultText = text),
  });
  assert.equal(resultText, "(no output)");
});

test("defaults missing tool arguments to an empty object", async (t) => {
  const { ollama, mcp, agent } = await setup(t);

  // A tool call whose function has no `arguments` field at all.
  ollama.responses.push({
    message: { role: "assistant", content: "", tool_calls: [{ function: { name: "nmap" } }] },
    done: true,
  });
  ollama.queueFinal("ok");

  await agent.run({ sessionId: "s1", userGoal: "go" });
  assert.deepEqual(mcp.calls[0].args, {});
});

// -----------------------------------------------------------------------------
// One decision at a time
// -----------------------------------------------------------------------------

test("processes only the first of several tool_calls in one turn", async (t) => {
  const { ollama, mcp, agent } = await setup(t);

  ollama.queueMultiToolCall([
    { name: "nmap", args: { target: "a" } },
    { name: "nmap", args: { target: "b" } },
  ]);
  ollama.queueFinal("done");

  await agent.run({ sessionId: "s1", userGoal: "go" });
  assert.equal(mcp.calls.length, 1);
  assert.deepEqual(mcp.calls[0].args, { target: "a" });
});

// -----------------------------------------------------------------------------
// Unknown-tool handling
// -----------------------------------------------------------------------------

test("rejects a tool the Node does not expose without calling MCP", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => textContent("should not run"),
  });

  ollama.queueToolCall("rm_rf", { path: "/" });
  ollama.queueFinal("understood, that tool is unavailable");

  await agent.run({ sessionId: "s1", userGoal: "go" });
  assert.equal(mcp.calls.length, 0);

  const secondTurn = ollama.requests[1].body.messages;
  const toolMsg = secondTurn.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /not available on this Node/);
});

// -----------------------------------------------------------------------------
// Active-tool approval gate
// -----------------------------------------------------------------------------

test("metasploit is gated behind approval and runs when approved", async (t) => {
  assert.ok(ACTIVE_TOOLS.has("metasploit"));
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => textContent("session opened"),
  });

  ollama.queueToolCall("metasploit", { module: "exploit/x" });
  ollama.queueFinal("done");

  let asked = false;
  await agent.run({
    sessionId: "s1",
    userGoal: "exploit it",
    onApproval: async () => {
      asked = true;
      return true;
    },
  });
  assert.ok(asked, "approval callback should be invoked");
  assert.equal(mcp.calls.length, 1);
});

test("a declined active tool is not executed and the model is told", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => textContent("should not run"),
  });

  ollama.queueToolCall("metasploit", { module: "exploit/x" });
  ollama.queueFinal("ok, standing down");

  await agent.run({
    sessionId: "s1",
    userGoal: "exploit it",
    onApproval: async () => false,
  });
  assert.equal(mcp.calls.length, 0);

  const secondTurn = ollama.requests[1].body.messages;
  const toolMsg = secondTurn.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /declined to run active tool/);
});

test("nmap (a passive tool) does not trigger the approval prompt", async (t) => {
  const { ollama, agent } = await setup(t);

  ollama.queueToolCall("nmap", { target: "x" });
  ollama.queueFinal("done");

  let asked = false;
  await agent.run({
    sessionId: "s1",
    userGoal: "scan",
    onApproval: async () => {
      asked = true;
      return true;
    },
  });
  assert.equal(asked, false);
});

// -----------------------------------------------------------------------------
// Step budget
// -----------------------------------------------------------------------------

test("stops after maxSteps and asks for a summary", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => textContent("more ports"),
    agentOptions: { maxSteps: 3 },
  });

  // Exactly maxSteps tool-call turns, then the summary the loop asks for.
  for (let i = 0; i < 3; i++) ollama.queueToolCall("nmap", { target: `h${i}` });
  ollama.queueFinal("Summary: found several open ports.");

  const answer = await agent.run({ sessionId: "s1", userGoal: "scan everything" });
  assert.equal(mcp.calls.length, 3);
  assert.equal(answer, "Summary: found several open ports.");

  const lastReq = ollama.requests.at(-1).body.messages;
  assert.match(lastReq.at(-1).content, /Step budget exhausted/);
});

// -----------------------------------------------------------------------------
// Session memory
// -----------------------------------------------------------------------------

test("persists the conversation and reloads it across runs", async (t) => {
  const { ollama, agent, memory, dir } = await setup(t);

  ollama.queueFinal("first answer");
  await agent.run({ sessionId: "s1", userGoal: "first goal" });

  const stored = memory.getSession("s1").messages;
  assert.ok(stored.some((m) => m.role === "user" && m.content === "first goal"));
  assert.ok(stored.some((m) => m.role === "assistant" && m.content === "first answer"));

  const reloaded = new AgentMemory(dir);
  assert.equal(reloaded.getSession("s1").messages.length, stored.length);
});

test("preserves the session even when Ollama errors mid-run", async (t) => {
  const { agent, memory } = await setup(t);

  // No responses queued -> the mock returns HTTP 500 -> queryOllama throws.
  await assert.rejects(agent.run({ sessionId: "s1", userGoal: "will fail" }), /Ollama returned 500/);
  const stored = memory.getSession("s1").messages;
  assert.ok(stored.some((m) => m.content === "will fail"));
});

// -----------------------------------------------------------------------------
// Context compaction
// -----------------------------------------------------------------------------

test("compactContext keeps the system prompt and original goal while trimming history", async (t) => {
  const { agent } = await setup(t, { agentOptions: { maxHistoryMessages: 4 } });

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
  ];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "assistant", content: `assistant ${i}` });
    messages.push({ role: "tool", name: "nmap", content: `tool ${i}` });
  }

  const compacted = agent.compactContext(messages);
  assert.ok(compacted.length < messages.length);
  assert.ok(compacted.some((m) => m.content === "SYSTEM PROMPT"));
  assert.ok(compacted.some((m) => m.content === "ORIGINAL GOAL"));
});
