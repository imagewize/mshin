import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, AgentMemory, ACTIVE_TOOLS, askYesNo, extractTextToolCall } from "./agent.js";

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

test("hydra and sqlmap are gated behind approval like metasploit", () => {
  assert.ok(ACTIVE_TOOLS.has("hydra"));
  assert.ok(ACTIVE_TOOLS.has("sqlmap"));
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

  const toolMessage = ollama.requests
    .at(-1)
    .body.messages.find((m) => m.role === "tool");
  assert.match(toolMessage.content, /cannot run on this Node/);
  assert.match(toolMessage.content, /do not retry it/);
  // The remaining work must be named explicitly: told only to stop retrying,
  // live models abandoned the rest of a two-tool goal and printed a placeholder.
  assert.match(toolMessage.content, /call that tool now/);
  assert.match(toolMessage.content, /Do not describe what a tool would return/);
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

test("a fabricated report is blocked even after another tool succeeded", async (t) => {
  const { ollama, agent } = await setup(t, {
    mcpHandler: (name) =>
      name === "metasploit" ? textContent("module completed") : textContent("ok"),
  });

  // metasploit really runs, then the model invents an nmap report.
  ollama.queueToolCall("metasploit", {});
  ollama.queueFinal(
    "Here are the results:\n\n```\nNmap scan report for 127.0.0.1\n22/tcp open ssh\n80/tcp open http\n```"
  );

  const answer = await agent.run({
    sessionId: "s1",
    userGoal: "scan it",
    onApproval: async () => true,
  });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.match(answer, /never returned one/);
  assert.match(answer, /nmap/);
  assert.doesNotMatch(answer, /22\/tcp/);
});

test("a failed tool call does not ground a fabricated report", async (t) => {
  // The live case: whois fails non-retryably, nmap is never called, and the
  // model prints a placeholder "Nmap Scan Results" block anyway.
  const { ollama, agent } = await setup(t, {
    mcpHandler: () => errorContent("Error: sudo: a password is required"),
  });

  ollama.queueToolCall("nmap", { target: "127.0.0.1" });
  ollama.queueFinal(
    "The whois lookup could not run. Here's the result:\n\n" +
      "**Nmap Scan Results for 127.0.0.1:**\n- 22/tcp open ssh"
  );

  const answer = await agent.run({ sessionId: "s1", userGoal: "recon it" });

  assert.equal(agent.metrics.fabricatedOutputsBlocked, 1);
  assert.doesNotMatch(answer, /22\/tcp/);
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
