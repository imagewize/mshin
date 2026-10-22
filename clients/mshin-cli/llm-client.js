#!/usr/bin/env node
//
// llm-client.js — pluggable LLM backends for the Machin Shin CLI agent loop.
//
// The agent stores messages and tool calls in a provider-agnostic format:
//   { role: "system" | "user" | "assistant" | "tool", content: string }
// Tool-call assistant messages also carry:
//   tool_calls: [{ id, function: { name, arguments: object } }]
// Tool-result messages also carry:
//   name, tool_call_id
//
// Each subclass converts that format to its provider's wire format and
// normalizes the response back to the common format.

import http from "node:http";
import https from "node:https";
import {
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config.js";

/**
 * POST JSON and read the whole response body.
 *
 * node:http is used instead of fetch so the timeout can be set deliberately.
 * With non-streaming generations, undici's default headersTimeout of 300s
 * aborts long turns before they finish and throws a bare "fetch failed".
 */
function postJson(url, body, timeoutMs, apiKey) {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`LLM returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`LLM returned unparseable JSON: ${err.message}`));
          }
        });
      }
    );

    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          new Error(
            `LLM request timed out after ${Math.round(timeoutMs / 1000)}s.`
          )
        );
      });
    }

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getJson(url, apiKey, timeoutMs) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "GET",
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`LLM returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`LLM returned unparseable JSON: ${err.message}`));
          }
        });
      }
    );

    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("LLM connectivity check timed out."));
      });
    }

    req.on("error", reject);
    req.end();
  });
}

/**
 * Base class for LLM clients. Subclasses implement:
 *   - chat(messages, tools) -> { message: { role, content, tool_calls? } }
 *   - optional verify() -> Promise<void>
 */
export class LlmClient {
  constructor({ model, apiKey = "", apiBase = "", timeoutMs = DEFAULT_LLM_TIMEOUT_MS } = {}) {
    this.model = model;
    this.apiKey = apiKey;
    this.apiBase = apiBase;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Normalize raw tool_calls from a provider response into the common shape:
   * [{ id, function: { name, arguments: object } }]
   */
  normalizeToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map((call, idx) => {
      const fn = call.function || {};
      let args = fn.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (typeof args !== "object" || args === null) {
        args = {};
      }
      return {
        id: call.id || `${fn.name || "call"}-${idx}`,
        function: { name: fn.name || "", arguments: args },
      };
    });
  }

  /**
   * Normalize raw assistant message into common shape.
   */
  normalizeAssistantMessage(raw) {
    return {
      role: "assistant",
      content: raw?.content || "",
      tool_calls: this.normalizeToolCalls(raw?.tool_calls),
    };
  }

  async verify() {
    // Override if the provider supports a cheap connectivity check.
  }

  async chat(_messages, _tools) {
    throw new Error("LlmClient.chat() must be implemented by subclass.");
  }
}

/**
 * Local Ollama backend.
 */
export class OllamaClient extends LlmClient {
  constructor(options = {}) {
    super(options);
    this.apiBase = this.apiBase || "http://localhost:11434";
  }

  async verify() {
    const res = await getJson(`${this.apiBase}/api/tags`, "", this.timeoutMs);
    if (!res.models) {
      throw new Error("Ollama /api/tags did not return a models list.");
    }
  }

  async chat(messages, tools) {
    const body = {
      model: this.model,
      messages: this.toProviderMessages(messages),
      tools,
      stream: false,
      options: {
        temperature: 0,
        top_p: 0.9,
        top_k: 40,
      },
    };

    const response = await postJson(
      `${this.apiBase}/api/chat`,
      body,
      this.timeoutMs,
      ""
    );

    return { message: this.normalizeAssistantMessage(response.message) };
  }

  toProviderMessages(messages) {
    return messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", name: m.name, content: m.content };
      }
      return m;
    });
  }
}

/**
 * OpenAI-compatible backend. Works for OpenAI, Kimi (Moonshot), Mistral,
 * OpenRouter, and any other provider that exposes /v1/chat/completions.
 */
export class OpenAiCompatibleClient extends LlmClient {
  constructor(options = {}) {
    super(options);
    this.apiBase = this.apiBase || "https://api.openai.com/v1";
  }

  async verify() {
    // A lightweight models list check; not all providers support it, so
    // failures are ignored if the chat endpoint works.
    try {
      await getJson(`${this.apiBase}/models`, this.apiKey, 10000);
    } catch {
      // best effort
    }
  }

  async chat(messages, tools) {
    const body = {
      model: this.model,
      messages: this.toProviderMessages(messages),
      tools,
      tool_choice: "auto",
      temperature: 0,
      top_p: 0.9,
    };

    const response = await postJson(
      `${this.apiBase}/chat/completions`,
      body,
      this.timeoutMs,
      this.apiKey
    );

    const choice = response.choices?.[0]?.message;
    if (!choice) {
      throw new Error("OpenAI-compatible response missing choices[0].message");
    }

    return { message: this.normalizeAssistantMessage(choice) };
  }

  toProviderMessages(messages) {
    return messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id || m.name,
          content: m.content,
        };
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        return {
          role: "assistant",
          content: m.content,
          tool_calls: m.tool_calls.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: c.function.name,
              arguments: JSON.stringify(c.function.arguments),
            },
          })),
        };
      }
      return m;
    });
  }
}

/**
 * Factory that creates the right client from a backend name.
 */
export function createLlmClient(backend, options = {}) {
  switch (backend) {
    case "ollama":
      return new OllamaClient(options);
    case "openai":
    case "mistral":
    case "kimi":
      return new OpenAiCompatibleClient(options);
    default:
      throw new Error(`Unknown LLM backend: ${backend}`);
  }
}
