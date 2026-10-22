import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  LlmClient,
  OllamaClient,
  OpenAiCompatibleClient,
  createLlmClient,
} from "./llm-client.js";

class MockHttpServer {
  constructor() {
    this.requests = [];
    this.responses = [];
    this.server = null;
    this.url = null;
  }

  queueResponse(handler) {
    this.responses.push(handler);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const parsed = body ? JSON.parse(body) : {};
        this.requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
        const next = this.responses.shift();
        if (!next) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no queued response" }));
          return;
        }
        const response = typeof next === "function" ? next(parsed) : next;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }
}

const TOOLS = [
  {
    type: "function",
    function: { name: "nmap", description: "scan", parameters: { type: "object", properties: {} } },
  },
];

const MESSAGES = [
  { role: "system", content: "You are a test assistant." },
  { role: "user", content: "scan" },
];

describe("createLlmClient factory", () => {
  it("creates an OllamaClient for backend 'ollama'", () => {
    const client = createLlmClient("ollama", { model: "mshin" });
    assert.ok(client instanceof OllamaClient);
  });

  it("creates an OpenAiCompatibleClient for openai, mistral and kimi", () => {
    for (const backend of ["openai", "mistral", "kimi"]) {
      const client = createLlmClient(backend, { model: "test" });
      assert.ok(client instanceof OpenAiCompatibleClient);
    }
  });

  it("throws on an unknown backend", () => {
    assert.throws(() => createLlmClient("unknown", { model: "test" }), /Unknown LLM backend/);
  });
});

describe("LlmClient.normalizeToolCalls", () => {
  const client = new LlmClient({ model: "test" });

  it("parses string arguments into objects", () => {
    const normalized = client.normalizeToolCalls([
      { id: "call-1", function: { name: "nmap", arguments: '{"target":"127.0.0.1"}' } },
    ]);
    assert.equal(normalized[0].id, "call-1");
    assert.equal(normalized[0].function.name, "nmap");
    assert.deepEqual(normalized[0].function.arguments, { target: "127.0.0.1" });
  });

  it("keeps object arguments unchanged", () => {
    const normalized = client.normalizeToolCalls([
      { function: { name: "nmap", arguments: { target: "127.0.0.1" } } },
    ]);
    assert.deepEqual(normalized[0].function.arguments, { target: "127.0.0.1" });
  });

  it("generates an id when absent", () => {
    const normalized = client.normalizeToolCalls([
      { function: { name: "nmap", arguments: {} } },
    ]);
    assert.match(normalized[0].id, /^nmap-/);
  });

  it("falls back to an empty object for unparseable argument strings", () => {
    const normalized = client.normalizeToolCalls([
      { function: { name: "nmap", arguments: "not-json" } },
    ]);
    assert.deepEqual(normalized[0].function.arguments, {});
  });
});

describe("OllamaClient", () => {
  let server;

  it("calls /api/chat with the right body", async () => {
    server = new MockHttpServer();
    server.queueResponse({
      message: { role: "assistant", content: "done" },
      done: true,
    });
    await server.start();

    const client = new OllamaClient({ model: "mshin", apiBase: server.url, timeoutMs: 5000 });
    await client.chat(MESSAGES, TOOLS);

    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.url, "/api/chat");
    assert.equal(req.body.model, "mshin");
    assert.equal(req.body.stream, false);
    assert.equal(req.body.options.temperature, 0);
    assert.deepEqual(req.body.tools, TOOLS);
    assert.equal(req.body.messages[0].role, "system");

    await server.stop();
  });

  it("normalizes a tool-call response", async () => {
    server = new MockHttpServer();
    server.queueResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "nmap", arguments: { target: "127.0.0.1" } } }],
      },
      done: true,
    });
    await server.start();

    const client = new OllamaClient({ model: "mshin", apiBase: server.url, timeoutMs: 5000 });
    const { message } = await client.chat(MESSAGES, TOOLS);
    assert.equal(message.tool_calls.length, 1);
    assert.equal(message.tool_calls[0].function.name, "nmap");
    assert.deepEqual(message.tool_calls[0].function.arguments, { target: "127.0.0.1" });

    await server.stop();
  });
});

describe("OpenAiCompatibleClient", () => {
  let server;

  it("calls /v1/chat/completions with the right body", async () => {
    server = new MockHttpServer();
    server.queueResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [],
          },
        },
      ],
    });
    await server.start();

    const client = new OpenAiCompatibleClient({
      model: "gpt-4",
      apiBase: server.url,
      apiKey: "secret",
      timeoutMs: 5000,
    });
    await client.chat(MESSAGES, TOOLS);

    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.url, "/chat/completions");
    assert.equal(req.headers.authorization, "Bearer secret");
    assert.equal(req.body.model, "gpt-4");
    assert.equal(req.body.temperature, 0);
    assert.equal(req.body.tool_choice, "auto");
    assert.deepEqual(req.body.tools, TOOLS);

    await server.stop();
  });

  it("normalizes tool calls with string arguments", async () => {
    server = new MockHttpServer();
    server.queueResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "nmap", arguments: '{"target":"127.0.0.1"}' },
              },
            ],
          },
        },
      ],
    });
    await server.start();

    const client = new OpenAiCompatibleClient({
      model: "gpt-4",
      apiBase: server.url,
      timeoutMs: 5000,
    });
    const { message } = await client.chat(MESSAGES, TOOLS);
    assert.equal(message.tool_calls[0].id, "call-1");
    assert.equal(message.tool_calls[0].function.name, "nmap");
    assert.deepEqual(message.tool_calls[0].function.arguments, { target: "127.0.0.1" });

    await server.stop();
  });

  it("converts tool result messages to the provider format", async () => {
    server = new MockHttpServer();
    server.queueResponse({
      choices: [{ message: { role: "assistant", content: "done" } }],
    });
    await server.start();

    const client = new OpenAiCompatibleClient({
      model: "gpt-4",
      apiBase: server.url,
      timeoutMs: 5000,
    });
    const messages = [
      ...MESSAGES,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", function: { name: "nmap", arguments: { target: "127.0.0.1" } } }],
      },
      { role: "tool", name: "nmap", tool_call_id: "call-1", content: "22/tcp open ssh" },
    ];
    await client.chat(messages, TOOLS);

    const req = server.requests[0];
    const toolMessage = req.body.messages.find((m) => m.role === "tool");
    assert.equal(toolMessage.tool_call_id, "call-1");
    assert.equal(toolMessage.content, "22/tcp open ssh");

    await server.stop();
  });

  it("times out a stalled request with a descriptive error", async () => {
    // A server that accepts the request and never answers — what a non-streaming
    // generation looks like while the model is still working.
    const stallServer = http.createServer(() => {});
    await new Promise((r) => stallServer.listen(0, "127.0.0.1", r));
    const { port } = stallServer.address();

    const client = new OpenAiCompatibleClient({
      model: "gpt-4",
      apiBase: `http://127.0.0.1:${port}`,
      timeoutMs: 50,
    });

    await assert.rejects(client.chat(MESSAGES, TOOLS), /timed out/);

    await new Promise((r) => stallServer.close(r));
  });
});
