import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, AgentMemory, ACTIVE_TOOLS, askYesNo, extractTextToolCall, compressToolResult } from "./agent.js";
import { SessionLogger } from "./session-logger.js";

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
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  const memory = new AgentMemory(dir);
  const agent = new Agent({
    mcpClient: mcp,
    ollamaUrl: ollama.url,
    model: "mshin",
    tools: OLLAMA_TOOLS,
    memory,
    sessionLogger: null,
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
  assert.equal(req.body.model, "mshin");
  assert.equal(req.body.stream, false);
  assert.equal(req.body.options?.temperature, 0);
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

test("runs every tool_call in one turn, in the order asked", async (t) => {
  const { ollama, mcp, agent } = await setup(t);

  // The model asks for two calls at once. Both must run -- dropping the second
  // is the recon-chain bug. They execute in order, before the next model turn.
  ollama.queueMultiToolCall([
    { name: "nmap", args: { target: "a" } },
    { name: "nmap", args: { target: "b" } },
  ]);
  ollama.queueFinal("done");

  await agent.run({ sessionId: "s1", userGoal: "go" });
  assert.equal(mcp.calls.length, 2);
  assert.deepEqual(mcp.calls[0].args, { target: "a" });
  assert.deepEqual(mcp.calls[1].args, { target: "b" });
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

test("hydra, sqlmap and john are gated behind approval like metasploit", () => {
  assert.ok(ACTIVE_TOOLS.has("hydra"));
  assert.ok(ACTIVE_TOOLS.has("sqlmap"));
  assert.ok(ACTIVE_TOOLS.has("john"));
});

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

test("compactContext keeps the original goal even once a findings summary is inserted", async (t) => {
  const { agent } = await setup(t, {
    agentOptions: { maxHistoryMessages: 3, contextTokenBudget: 1 },
  });
  agent.findingsMemory.processToolResult(
    "nmap",
    "Nmap scan report for 10.0.0.5\n22/tcp open ssh OpenSSH 8.9"
  );

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
    { role: "tool", name: "nmap", content: "tool output 1" },
    { role: "tool", name: "nmap", content: "tool output 2" },
    { role: "tool", name: "nmap", content: "tool output 3" },
  ];

  const compacted = agent.compactContext(messages);
  assert.ok(
    compacted.some((m) => m.role === "user" && m.content === "ORIGINAL GOAL"),
    "the original goal must survive compaction once a findings summary occupies a slot"
  );
});

test("compactContext refreshes the findings summary instead of freezing it", async (t) => {
  const { agent } = await setup(t);
  agent.findingsMemory.processToolResult(
    "nmap",
    "Nmap scan report for 10.0.0.5\n22/tcp open ssh OpenSSH 8.9"
  );

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
  ];
  const firstPass = agent.compactContext(messages);
  const firstSummary = firstPass.find((m) => m.content?.startsWith("[Findings Summary"));
  assert.ok(firstSummary.content.includes("10.0.0.5"));

  agent.findingsMemory.processToolResult(
    "nmap",
    "Nmap scan report for 10.0.0.9\n80/tcp open http nginx 1.18"
  );
  const secondPass = agent.compactContext(firstPass);
  const findingsMessages = secondPass.filter((m) =>
    m.content?.startsWith("[Findings Summary")
  );
  assert.equal(findingsMessages.length, 1, "the findings summary must not be duplicated");
  assert.ok(findingsMessages[0].content.includes("10.0.0.9"), "the summary must include newly discovered hosts");
});

test("compressToolResult keeps short output unchanged", () => {
  const text = "line one\nline two\nline three";
  assert.equal(compressToolResult(text), text);
});

test("compressToolResult truncates long output to head and tail", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  const compressed = compressToolResult(lines.join("\n"), {
    maxLines: 60,
    headLines: 5,
    tailLines: 5,
  });

  const compressedLines = compressed.split("\n");
  assert.equal(compressedLines[0], "line 1");
  assert.equal(compressedLines[5], "... (90 lines omitted) ...");
  assert.equal(compressedLines[6], "line 96");
  assert.equal(compressedLines.at(-1), "line 100");
});

test("compactContext compresses long tool results before dropping messages", async (t) => {
  const { agent } = await setup(t, {
    agentOptions: {
      maxHistoryMessages: 100,
      contextTokenBudget: 1000,
      maxToolResultLines: 10,
      toolResultHeadLines: 3,
      toolResultTailLines: 3,
    },
  });

  const longResult = Array.from({ length: 200 }, (_, i) => `scan line ${i + 1}`).join("\n");
  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "scan everything" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "nmap", arguments: { target: "127.0.0.1" } } }] },
    { role: "tool", name: "nmap", content: longResult },
  ];

  const compacted = agent.compactContext(messages);
  const toolMessage = compacted.find((m) => m.role === "tool");
  assert.ok(toolMessage);
  assert.ok(toolMessage.content.includes("scan line 1"));
  assert.ok(toolMessage.content.includes("scan line 200"));
  assert.ok(toolMessage.content.includes("lines omitted"));
  assert.ok(toolMessage.content.split("\n").length <= 10);
  assert.equal(compacted.length, messages.length);
});

test("compressToolResult leaves output at exactly the line cap unchanged", () => {
  // The cap is inclusive: maxLines lines fit without compression, one more
  // does not.
  const atCap = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.equal(compressToolResult(atCap), atCap);

  const overCap = atCap + "\nline 61";
  assert.notEqual(compressToolResult(overCap), overCap);
  assert.ok(compressToolResult(overCap).includes("lines omitted"));
});

test("compactContext leaves a small history unchanged", async (t) => {
  const { agent } = await setup(t);

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
    { role: "assistant", content: "working on it" },
    { role: "tool", name: "nmap", content: "22/tcp open ssh" },
  ];

  const compacted = agent.compactContext(messages);
  assert.deepEqual(compacted, messages);
});

test("compactContext does not mutate the input messages", async (t) => {
  const { agent } = await setup(t, {
    agentOptions: {
      maxToolResultLines: 10,
      toolResultHeadLines: 2,
      toolResultTailLines: 2,
    },
  });

  const longResult = Array.from({ length: 200 }, (_, i) => `scan line ${i + 1}`).join("\n");
  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "scan everything" },
    { role: "tool", name: "nmap", content: longResult },
  ];

  const compacted = agent.compactContext(messages);

  // The compacted copy the model sees is slimmed...
  const compactedTool = compacted.find((m) => m.role === "tool");
  assert.ok(compactedTool.content.includes("lines omitted"));
  // ...but the caller's transcript keeps the full output: it is what
  // AgentMemory persists, and compaction must never hollow it out.
  assert.equal(messages[2].content, longResult);
  assert.notEqual(compacted, messages, "compaction must return a new array");
});

test("compactContext evicts by token budget even under the message cap", async (t) => {
  const { agent } = await setup(t, {
    agentOptions: { maxHistoryMessages: 100, contextTokenBudget: 100 },
  });

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
  ];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "tool", name: "nmap", content: `tool result number ${i}` });
  }

  const compacted = agent.compactContext(messages);
  // The message count was well under the cap; only the token budget forced
  // evictions.
  assert.ok(compacted.length < messages.length);
  assert.ok(
    compacted.some((m) => m.role === "user" && m.content === "ORIGINAL GOAL"),
    "the goal must survive token-budget eviction"
  );
  assert.ok(
    !compacted.some((m) => m.content === "tool result number 0"),
    "the oldest tool result must be evicted first"
  );
  assert.ok(
    compacted.some((m) => m.content === "tool result number 19"),
    "the newest tool result must survive"
  );
});

test("compactContext stops at the preserved floor rather than dropping everything", async (t) => {
  const { agent } = await setup(t, {
    agentOptions: { contextTokenBudget: 1 },
  });
  agent.findingsMemory.processToolResult(
    "nmap",
    "Nmap scan report for 10.0.0.5\n22/tcp open ssh OpenSSH 8.9"
  );

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
    { role: "tool", name: "nmap", content: "tool output 1" },
    { role: "tool", name: "nmap", content: "tool output 2" },
    { role: "tool", name: "nmap", content: "tool output 3" },
  ];

  const compacted = agent.compactContext(messages);

  // Preserved here: system, user goal, findings summary -- three slots, so
  // eviction halts with five messages standing even though the token budget
  // is still blown. Dropping past that floor would only eat preserved slots.
  assert.equal(compacted.length, 5);
  assert.ok(compacted.some((m) => m.content === "SYSTEM PROMPT"));
  assert.ok(compacted.some((m) => m.content === "ORIGINAL GOAL"));
  assert.ok(
    compacted.some((m) => (m.content || "").startsWith("[Findings Summary")),
    "the findings summary must survive at the floor"
  );
});

test("compactContext tracks the context high-water mark", async (t) => {
  const { agent } = await setup(t);

  const messages = [
    { role: "system", content: "SYSTEM PROMPT" },
    { role: "user", content: "ORIGINAL GOAL" },
    { role: "tool", name: "nmap", content: "22/tcp open ssh" },
  ];
  const expected = messages.reduce(
    (sum, m) => sum + Math.ceil((m.content || "").length / 4) + 4,
    0
  );

  agent.compactContext(messages);
  assert.equal(agent.metrics.contextHighWaterTokens, expected);

  // A second, smaller pass must not lower it.
  agent.compactContext([{ role: "system", content: "short" }]);
  assert.equal(agent.metrics.contextHighWaterTokens, expected);
});

test("compactContext preserves the user goal when there is no system prompt", async (t) => {
  const { agent } = await setup(t, {
    agentOptions: { maxHistoryMessages: 4 },
  });

  const messages = [{ role: "user", content: "ORIGINAL GOAL" }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: "tool", name: "nmap", content: `tool ${i}` });
  }

  const compacted = agent.compactContext(messages);
  assert.ok(
    compacted.some((m) => m.role === "user" && m.content === "ORIGINAL GOAL"),
    "the goal must survive without a system prompt to anchor the array"
  );
  // No system message means no findings summary is inserted either; the
  // preserved set is just the goal.
  assert.ok(
    !compacted.some((m) => (m.content || "").startsWith("[Findings Summary"))
  );
});

// -----------------------------------------------------------------------------
// Narrated tool calls
//
// Small models given a tools array sometimes write the call out as text instead
// of emitting it, then invent the result. Ollama returns that as plain content
// with no tool_calls, so the loop must notice rather than pass the fabrication
// off as an answer.
// -----------------------------------------------------------------------------

const isNmap = (n) => n === "nmap";

test("extracts a bare text-emitted tool call", () => {
  const call = extractTextToolCall(
    'To scan it I will use nmap.\n\n[{"name":"nmap","arguments":{"target":"127.0.0.1"}}]',
    isNmap
  );
  assert.deepEqual(call, { name: "nmap", args: { target: "127.0.0.1" } });
});

test("extracts a call behind a [TOOL_CALLS] marker", () => {
  const call = extractTextToolCall(
    '[TOOL_CALLS] [{"name": "nmap", "arguments": {"target": "10.0.0.1"}}]',
    isNmap
  );
  assert.deepEqual(call, { name: "nmap", args: { target: "10.0.0.1" } });
});

test("extracts a call fenced in a code block", () => {
  const call = extractTextToolCall(
    'Here is the call:\n```json\n{"name":"nmap","arguments":{"target":"h"}}\n```',
    isNmap
  );
  assert.deepEqual(call, { name: "nmap", args: { target: "h" } });
});

test("ignores JSON that names no available tool", () => {
  assert.equal(
    extractTextToolCall('{"name":"rm","arguments":{"path":"/"}}', isNmap),
    null
  );
});

test("ignores an answer that merely quotes JSON", () => {
  assert.equal(
    extractTextToolCall('The scan returned {"ports": [22, 80]} in total.', isNmap),
    null
  );
});

test("ignores prose with no JSON at all", () => {
  assert.equal(extractTextToolCall("No open ports were found.", isNmap), null);
  assert.equal(extractTextToolCall("", isNmap), null);
  assert.equal(extractTextToolCall(null, isNmap), null);
});

test("recovers a narrated call, runs it, and drops the invented output", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => textContent("22/tcp open ssh"),
  });

  // The model narrates the call and fabricates a scan report in the same turn.
  ollama.queueFinal(
    'To scan 127.0.0.1 I will use nmap.\n' +
      '[{"name":"nmap","arguments":{"target":"127.0.0.1"}}]\n' +
      "PORT   STATE SERVICE\n3306/tcp open  mysql"
  );
  ollama.queueFinal("Port 22 is open.");

  const narrated = [];
  const answer = await agent.run({
    sessionId: "s-narrated",
    userGoal: "scan localhost",
    onNarratedToolCall: (name) => narrated.push(name),
  });

  // The tool actually ran, and the real result -- not the invention -- is the
  // basis of the answer.
  assert.deepEqual(narrated, ["nmap"]);
  assert.equal(mcp.calls.length, 1);
  assert.equal(mcp.calls[0].name, "nmap");
  assert.equal(answer, "Port 22 is open.");

  // The fabricated report must not survive in the transcript the model sees.
  const sent = ollama.requests.at(-1).body.messages;
  assert.ok(
    !sent.some((m) => (m.content || "").includes("3306/tcp")),
    "invented tool output leaked into the transcript"
  );
  assert.ok(sent.some((m) => m.role === "tool" && m.content === "22/tcp open ssh"));
});

test("a genuine text answer still ends the loop", async (t) => {
  const { ollama, mcp, agent } = await setup(t);
  ollama.queueFinal("No scan was needed; the host is documented as offline.");

  const answer = await agent.run({ sessionId: "s-plain", userGoal: "status?" });

  assert.equal(mcp.calls.length, 0);
  assert.equal(answer, "No scan was needed; the host is documented as offline.");
});

test("extracts a functions.name(args) text-emitted call", () => {
  const call = extractTextToolCall(
    'functions.nmap(target="127.0.0.1", flags=["-sS"])',
    isNmap
  );
  assert.deepEqual(call, { name: "nmap", args: { target: "127.0.0.1", flags: ["-sS"] } });
});

test("extracts a bare name(args) text-emitted call", () => {
  const call = extractTextToolCall(
    'To scan it I will use nmap(target="10.0.0.1").',
    isNmap
  );
  assert.deepEqual(call, { name: "nmap", args: { target: "10.0.0.1" } });
});

test("ignores function-syntax prose that names no available tool", () => {
  assert.equal(
    extractTextToolCall('rm(path="/")', isNmap),
    null
  );
});

test("extracts function-syntax calls with parentheses inside string args", () => {
  const call = extractTextToolCall(
    'nmap(target="127.0.0.1 (localhost)", flags=["-sS"])',
    isNmap
  );
  assert.deepEqual(call, { name: "nmap", args: { target: "127.0.0.1 (localhost)", flags: ["-sS"] } });
});

test("recovers a functions.name narrated call and drops invented results", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => textContent("22/tcp open ssh"),
  });

  ollama.queueFinal(
    'functions.nmap(target="127.0.0.1", flags=["-sS"])\n\n' +
      "Result:\n" +
      "22/tcp   open  ssh\n" +
      "80/tcp   open  http\n" +
      "3306/tcp open  mysql"
  );
  ollama.queueFinal("Port 22 is open.");

  const narrated = [];
  const answer = await agent.run({
    sessionId: "s-func-syntax",
    userGoal: "scan localhost",
    onNarratedToolCall: (name) => narrated.push(name),
  });

  assert.deepEqual(narrated, ["nmap"]);
  assert.equal(mcp.calls.length, 1);
  assert.deepEqual(mcp.calls[0].args, { target: "127.0.0.1", flags: ["-sS"] });
  assert.equal(answer, "Port 22 is open.");

  const sent = ollama.requests.at(-1).body.messages;
  assert.ok(!sent.some((m) => (m.content || "").includes("3306/tcp")));
  assert.ok(sent.some((m) => m.role === "tool" && m.content === "22/tcp open ssh"));
});

test("backstop blocks unparseable fabricated results from reaching the user", async (t) => {
  const { ollama, mcp, agent, memory } = await setup(t, {
    mcpHandler: () => textContent("should not run"),
  });

  // No parseable call syntax, but the model invented a scan report.
  ollama.queueFinal(
    "I ran a scan.\n\n" +
      "Result:\n" +
      "22/tcp   open  ssh\n" +
      "80/tcp   open  http\n" +
      "3306/tcp open  mysql"
  );

  const answer = await agent.run({ sessionId: "s-backstop", userGoal: "scan localhost" });

  assert.equal(mcp.calls.length, 0);
  assert.match(answer, /no tool executed/i);
  assert.ok(!answer.includes("3306/tcp"));

  // The fabricated turn must not persist as a valid assistant answer.
  const stored = memory.getSession("s-backstop").messages;
  assert.ok(!stored.some((m) => (m.content || "").includes("3306/tcp")));
});

test("backstop catches fenced invented output", async (t) => {
  const { ollama, mcp, agent } = await setup(t);

  ollama.queueFinal(
    "The scan returned:\n```\n22/tcp open ssh\n80/tcp open http\n```"
  );

  const answer = await agent.run({ sessionId: "s-fenced", userGoal: "scan localhost" });

  assert.equal(mcp.calls.length, 0);
  assert.match(answer, /no tool executed/i);
});

test("does not block a genuine final answer after a real tool ran", async (t) => {
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => textContent("22/tcp open ssh"),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("Result: port 22 is open.");

  const answer = await agent.run({ sessionId: "s-real-result", userGoal: "scan localhost" });
  assert.equal(answer, "Result: port 22 is open.");
});

test("askYesNo reads through an injected reader instead of opening stdin", async () => {
  const prompts = [];
  const ask = (prompt) => {
    prompts.push(prompt);
    return Promise.resolve("y\n");
  };

  // The CLI owns the only readline interface for the session, so askYesNo
  // must never create a second one on the same stdin.
  const before = process.stdin.listenerCount("data");
  const approved = await askYesNo("Allow this execution?", ask);
  assert.equal(process.stdin.listenerCount("data"), before);

  assert.equal(approved, true);
  assert.deepEqual(prompts, ["Allow this execution? (y/n): "]);
});

test("askYesNo treats anything but a leading y as a denial", async () => {
  assert.equal(await askYesNo("q", () => "n"), false);
  assert.equal(await askYesNo("q", () => ""), false);
  assert.equal(await askYesNo("q", () => "  YES  "), true);
  assert.equal(await askYesNo("q", () => "nope"), false);
});

// -----------------------------------------------------------------------------
// Non-retryable tool failures
// -----------------------------------------------------------------------------

/** MCP error content, shaped like the server's handler-throw path. */
function errorContent(text) {
  return { content: [{ type: "text", text }], isError: true };
}

test("a non-retryable tool error is not retried", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () =>
      errorContent("Error: Command failed: sudo -n /usr/bin/nmap 127.0.0.1\nsudo: a password is required"),
  });

  // The model asks for the same tool three times, as both live models did.
  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("I could not run nmap on this Node.");

  const answer = await agent.run({ sessionId: "s1", userGoal: "scan it" });

  // Executed once; the two repeats were answered from the transcript.
  assert.equal(mcp.calls.length, 1);
  assert.equal(agent.metrics.nonRetryableToolErrors, 1);
  assert.equal(agent.metrics.blockedToolRetries, 2);
  assert.equal(answer, "I could not run nmap on this Node.");
});

test("the model is told the failure is environmental, not a bad argument", async (t) => {
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => errorContent("Error: Tool binary not found: /usr/bin/nikto. Is nikto installed?"),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("done");
  await agent.run({ sessionId: "s1", userGoal: "scan it" });

  const messages = ollama.requests.at(-1).body.messages;
  const toolMessage = messages.find((m) => m.role === "tool");
  const instruction = messages.find(
    (m) => m.role === "user" && m.content.includes("Continue the rest of the task")
  );
  // The tool slot stays short: error plus retry suppression.
  assert.match(toolMessage.content, /cannot run on this Node/);
  assert.match(toolMessage.content, /do not retry it/);
  assert.doesNotMatch(toolMessage.content, /call that tool now/);
  // The imperative direction to continue belongs in a user message.
  assert.ok(instruction, "continue instruction should be a user message");
  assert.match(instruction.content, /Continue the rest of the task/);
  assert.match(instruction.content, /Do not describe output no tool returned/);
  // The underlying error is preserved, not swallowed.
  assert.match(toolMessage.content, /Tool binary not found/);
});

test("an ordinary tool error stays retryable", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () => errorContent("Error: Host 10.0.0.1 appears to be down."),
  });

  ollama.queueToolCall("nmap", { target: "10.0.0.1" });
  ollama.queueToolCall("nmap", { target: "10.0.0.1" });
  ollama.queueFinal("host is down");

  await agent.run({ sessionId: "s1", userGoal: "scan it" });

  // A transient failure must not disable the tool: both calls reached MCP.
  assert.equal(mcp.calls.length, 2);
  assert.equal(agent.metrics.nonRetryableToolErrors, 0);
  assert.equal(agent.metrics.blockedToolRetries, 0);
});

test("a successful call is never treated as non-retryable", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    // Output that merely mentions permissions, without isError.
    mcpHandler: () => textContent("22/tcp open ssh — permission denied banner seen"),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("done");

  await agent.run({ sessionId: "s1", userGoal: "scan it" });

  assert.equal(mcp.calls.length, 2);
  assert.equal(agent.metrics.nonRetryableToolErrors, 0);
});

test("blocking one tool leaves the others usable", async (t) => {
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: (name) =>
      name === "nmap"
        ? errorContent("Error: sudo: a password is required")
        : textContent("metasploit ran"),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueToolCall("metasploit", {});
  ollama.queueFinal("done");

  await agent.run({
    sessionId: "s1",
    userGoal: "scan it",
    onApproval: async () => true,
  });

  assert.deepEqual(mcp.calls.map((c) => c.name), ["nmap", "metasploit"]);
  assert.equal(agent.metrics.blockedToolRetries, 1);
});

// -----------------------------------------------------------------------------
// Fabricated output after a tool has already run
// -----------------------------------------------------------------------------

test("a fabricated report is caught, then the skipped tool is actually run", async (t) => {
  // The recon-chain continuation bug: one tool succeeds (metasploit), and the
  // model invents the next tool's report (nmap) instead of calling it. The loop
  // must refuse the fabrication, direct the model to run nmap, and let the real
  // result through -- not terminate at the fabrication.
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: (name) =>
      name === "metasploit"
        ? textContent("module completed")
        : textContent("22/tcp open ssh"),
  });

  ollama.queueToolCall("metasploit", {});
  ollama.queueFinal(
    "Here are the results:\n\n```\nNmap scan report for 127.0.0.1\n9999/tcp open leak\n```"
  );
  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("Result: nmap found 22/tcp open (ssh).");

  const answer = await agent.run({
    sessionId: "s1",
    userGoal: "run metasploit then scan it",
    onApproval: async () => true,
  });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.equal(agent.metrics.continuationNudges, 1);
  // nmap was actually called after the nudge, not just described.
  assert.ok(mcp.calls.some((c) => c.name === "nmap"));
  // The real result is delivered; the invented port never leaks through.
  assert.match(answer, /22\/tcp open/);
  assert.doesNotMatch(answer, /9999\/tcp/);
});

test("an unfenced inline scan list is caught when its tool never ran", async (t) => {
  // The exact live recon-chain shape: nmap fails non-retryably (so it is
  // unavailable and cannot be re-run), then the model reports an inline
  // markdown list of ports with no code fence and no "Result:" label. The
  // broadened detector must catch it, and with no runnable tool left the
  // fabrication is refused rather than nudged.
  const { ollama, mcp, agent } = await setup(t, {
    mcpHandler: () =>
      errorContent(
        "Error: Command failed: sudo -n /usr/bin/nmap\nsudo: a password is required"
      ),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal(
    "The nmap scan revealed the following open ports:\n" +
      "- 22/tcp (SSH)\n- 80/tcp (HTTP)\n- 443/tcp (HTTPS)"
  );

  const answer = await agent.run({ sessionId: "s1", userGoal: "scan it" });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.equal(agent.metrics.continuationNudges, 0);
  assert.match(answer, /never returned one/);
  assert.doesNotMatch(answer, /22\/tcp/);
  // nmap was tried once and, being unavailable, was not re-run.
  assert.equal(mcp.calls.filter((c) => c.name === "nmap").length, 1);
});

test("the debug trace records dropped tool_calls and each decision", async (t) => {
  const events = [];
  const { ollama, mcp, agent } = await setup(t, {
    agentOptions: { debug: (event, data) => events.push([event, data]) },
  });

  // The model asks for two tools in one turn. The trace's model.turn event
  // records both -- the signal that was missing when this exact shape hid a
  // real bug (the loop dropping the second call) in a live run.
  ollama.queueMultiToolCall([
    { name: "nmap", args: { target: "127.0.0.1" } },
    { name: "metasploit", args: {} },
  ]);
  ollama.queueFinal("Result: nmap found 22/tcp open (ssh).");

  await agent.run({
    sessionId: "s1",
    userGoal: "scan it",
    onApproval: async () => true,
  });

  // Both tools actually ran, not just the first.
  assert.deepEqual(mcp.calls.map((c) => c.name), ["nmap", "metasploit"]);
  const turn = events.find(([e]) => e === "model.turn");
  assert.ok(turn, "a model.turn event was recorded");
  assert.deepEqual(turn[1].toolCalls, ["nmap", "metasploit"]);
  assert.ok(events.some(([e]) => e === "run.start"));
  assert.ok(events.some(([e]) => e === "tool.call"));
});

test("with no budget left, a fabrication is refused rather than nudged", async (t) => {
  // The continuation nudge needs a turn to spend. On the final step there is
  // none, so an invented result is refused outright.
  const { ollama, agent } = await setup(t, { agentOptions: { maxSteps: 1 } });

  ollama.queueFinal(
    "The nmap scan revealed the following open ports:\n- 22/tcp (SSH)"
  );

  const answer = await agent.run({ sessionId: "s1", userGoal: "scan it" });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.equal(agent.metrics.continuationNudges, 0);
  assert.match(answer, /never returned one/);
});

test("summarising a tool's real output is not blocked", async (t) => {
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => textContent("22/tcp open ssh\n80/tcp open http"),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("Result: nmap found 22/tcp open (ssh) and 80/tcp open (http).");

  const answer = await agent.run({ sessionId: "s1", userGoal: "scan it" });

  // The tool really ran and really returned this, so the summary must survive.
  assert.equal(agent.metrics.fabricatedOutputsBlocked, 0);
  assert.match(answer, /22\/tcp open/);
});

test("a tool that returned nothing usable cannot ground its own report", async (t) => {
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => errorContent("Error: Host 10.0.0.1 appears to be down."),
  });

  ollama.queueToolCall("nmap", { target: "10.0.0.1" });
  ollama.queueFinal("Result:\n```\n10.0.0.1\n443/tcp open https\n```");

  const answer = await agent.run({ sessionId: "s1", userGoal: "scan it" });

  // The error is honest output, but it is not a scan result.
  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.doesNotMatch(answer, /443\/tcp/);
});

// -----------------------------------------------------------------------------
// Fabrication-detection narrowness
//
// looksLikeFabricatedToolOutput is deliberately narrow: it targets confident
// invention (scan signatures, "Result:"-labelled reports), not every code
// fence or use of the word "result". These tests pin the non-firing cases so
// the detector cannot quietly grow into blocking genuine answers.
// -----------------------------------------------------------------------------

test("ungroundedToolsIn lists only known tools that never returned a result", async (t) => {
  const { agent } = await setup(t);

  const succeeded = new Set(["nmap"]);
  // Both tools are mentioned, but nmap succeeded: only metasploit is ungrounded.
  assert.deepEqual(
    agent.ungroundedToolsIn("The nmap scan and the metasploit module are done.", succeeded),
    ["metasploit"]
  );
  // A mention of a succeeded tool grounds nothing.
  assert.deepEqual(agent.ungroundedToolsIn("nmap found 22/tcp open", succeeded), []);
});

test("ungroundedToolsIn matches names case-insensitively but never inside words", async (t) => {
  const { agent } = await setup(t);

  assert.deepEqual(agent.ungroundedToolsIn("Nmap finished", new Set()), ["nmap"]);
  // "nmapx" is a different word: naming it must not ground -- or accuse -- nmap.
  assert.deepEqual(agent.ungroundedToolsIn("nmapx is not a tool", new Set()), []);
  assert.deepEqual(agent.ungroundedToolsIn("", new Set()), []);
  assert.deepEqual(agent.ungroundedToolsIn(null, new Set()), []);
});

test("a plain code fence with no scan signature is not treated as fabrication", async (t) => {
  const { ollama, mcp, agent } = await setup(t);

  ollama.queueFinal('Here is the config I recommend:\n```json\n{"ports": []}\n```');

  const answer = await agent.run({ sessionId: "s-fence-benign", userGoal: "advise me" });

  assert.equal(mcp.calls.length, 0);
  assert.equal(agent.metrics.fabricatedOutputsBlocked, 0);
  assert.match(answer, /\{"ports": \[\]\}/);
});

test("a 'Result:' label followed by non-scan prose is not treated as fabrication", async (t) => {
  const { ollama, agent } = await setup(t);

  ollama.queueFinal("Result: The host did not respond to any probe.");

  const answer = await agent.run({ sessionId: "s-result-plain", userGoal: "scan it" });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 0);
  assert.equal(answer, "Result: The host did not respond to any probe.");
});

test("an unfenced udp signature is caught like a tcp one", async (t) => {
  const { ollama, agent } = await setup(t);

  ollama.queueFinal(
    "The scan found these open ports:\n- 53/udp (DNS)\n- 123/udp (NTP)"
  );

  const answer = await agent.run({ sessionId: "s-udp", userGoal: "scan it" });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.doesNotMatch(answer, /53\/udp/);
  assert.match(answer, /no tool executed/i);
});

// -----------------------------------------------------------------------------
// Ollama request timeout
// -----------------------------------------------------------------------------

test("a stalled Ollama request fails with a timeout that names itself", async (t) => {
  // A server that accepts the request and never answers — what a non-streaming
  // generation looks like on the wire while the model is still working.
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const agent = new Agent({
    mcpClient: new MockMcpClient(() => textContent("ok")),
    ollamaUrl: `http://127.0.0.1:${port}`,
    model: "mshin",
    tools: OLLAMA_TOOLS,
    memory: new AgentMemory(dir),
    ollamaTimeoutMs: 150,
  });

  // Before this, undici's 300s default produced a bare "fetch failed" with no
  // hint that a timeout was involved — it killed two live eval runs at ~329s.
  await assert.rejects(
    agent.run({ sessionId: "s1", userGoal: "hello" }),
    /timed out after 0s \(model 'mshin'\).*raise ollamaTimeoutMs/s
  );
});

test("the request timeout is generous by default", async (t) => {
  const { agent } = await setup(t);
  // A single turn on a 70B can run for minutes; the default must not be tight.
  assert.equal(agent.ollamaTimeoutMs, 600_000);
});

// -----------------------------------------------------------------------------
// Session JSONL logging
// -----------------------------------------------------------------------------

test("SessionLogger writes append-only JSONL events", () => {
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  const logger = new SessionLogger(dir);
  logger.write("s1", { type: "test.a", value: 1 });
  logger.write("s1", { type: "test.b", value: 2 });

  const lines = readFileSync(join(dir, "sessions", "s1.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.type, "test.a");
  assert.equal(first.value, 1);
  assert.equal(first.sessionId, "s1");
  assert.ok(first.timestamp);

  const second = JSON.parse(lines[1]);
  assert.equal(second.type, "test.b");
  assert.equal(second.value, 2);

  rmSync(dir, { recursive: true, force: true });
});

test("agent logs session.start, tool calls, results, and session.end", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  const logger = new SessionLogger(dir);
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => textContent("PORT 22/tcp open ssh"),
    agentOptions: { sessionLogger: logger },
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal("Port 22 is open.");

  await agent.run({ sessionId: "s-logged", userGoal: "scan localhost" });

  const events = readFileSync(join(dir, "sessions", "s-logged.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.ok(events.some((e) => e.type === "session.start" && e.goal === "scan localhost"));
  assert.ok(events.some((e) => e.type === "tool.call" && e.name === "nmap" && e.args.target === "127.0.0.1"));
  assert.ok(events.some((e) => e.type === "tool.result" && e.name === "nmap" && e.text.includes("22/tcp open ssh")));
  assert.ok(events.some((e) => e.type === "session.end" && e.answer === "Port 22 is open."));

  rmSync(dir, { recursive: true, force: true });
});

test("agent logs session.error when Ollama fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  const logger = new SessionLogger(dir);
  const { agent } = await setup(t, {
    agentOptions: { sessionLogger: logger },
  });

  // No responses queued -> the mock returns HTTP 500.
  await assert.rejects(agent.run({ sessionId: "s-error", userGoal: "will fail" }), /Ollama returned 500/);

  const events = readFileSync(join(dir, "sessions", "s-error.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.ok(events.some((e) => e.type === "session.start"));
  assert.ok(events.some((e) => e.type === "session.error" && /Ollama returned 500/.test(e.error)));

  rmSync(dir, { recursive: true, force: true });
});

test("SessionLogger prunes files older than maxAgeDays", () => {
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  const logger = new SessionLogger(dir, { maxSessions: 100, maxAgeDays: 1 });
  logger.write("old-session", { type: "session.start" });

  const oldPath = join(dir, "sessions", "old-session.jsonl");
  const ancient = Date.now() - 2 * 24 * 60 * 60 * 1000;
  utimesSync(oldPath, new Date(ancient), new Date(ancient));

  // Creating a second logger re-runs prune with the same policy.
  new SessionLogger(dir, { maxSessions: 100, maxAgeDays: 1 });

  assert.ok(!existsSync(oldPath), "ancient session file should be pruned");
  rmSync(dir, { recursive: true, force: true });
});

test("SessionLogger keeps only the most recent maxSessions files", () => {
  const dir = mkdtempSync(join(tmpdir(), "mshin-test-"));
  const logger = new SessionLogger(dir, { maxSessions: 2, maxAgeDays: 30 });
  logger.write("first", { type: "session.start" });
  logger.write("second", { type: "session.start" });
  logger.write("third", { type: "session.start" });

  new SessionLogger(dir, { maxSessions: 2, maxAgeDays: 30 });

  assert.ok(!existsSync(join(dir, "sessions", "first.jsonl")), "oldest file should be pruned");
  assert.ok(existsSync(join(dir, "sessions", "second.jsonl")));
  assert.ok(existsSync(join(dir, "sessions", "third.jsonl")));
  rmSync(dir, { recursive: true, force: true });
});
