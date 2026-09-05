#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 24_000;

// Tools that can alter state or launch exploits require explicit user approval
// before each invocation.
const ACTIVE_TOOLS = new Set(["metasploit"]);

function estimateTokens(text) {
  // Fast, conservative approximation: ~4 characters per token for English text.
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(message) {
  const text = message.content || "";
  return estimateTokens(text) + 4; // small overhead for role/name
}

/**
 * Persistent session memory for the Avendesora agent.
 *
 * Sessions are stored as JSON so the operator can review, delete, or migrate
 * them easily. The storage path can be swapped for SQLite later if multi-user
 * or concurrent access is needed.
 */
class AgentMemory {
  constructor(dataDir = join(homedir(), ".avendesora")) {
    this.dataDir = dataDir;
    this.storePath = join(dataDir, "memory.json");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.sessions = this.load();
  }

  load() {
    try {
      return JSON.parse(readFileSync(this.storePath, "utf8"));
    } catch {
      return {};
    }
  }

  save() {
    writeFileSync(this.storePath, JSON.stringify(this.sessions, null, 2));
  }

  getSession(id) {
    return this.sessions[id] || { messages: [], createdAt: Date.now() };
  }

  storeSession(id, messages) {
    this.sessions[id] = {
      messages,
      updatedAt: Date.now(),
      createdAt: this.sessions[id]?.createdAt || Date.now(),
    };
    this.save();
  }

  clearSession(id) {
    delete this.sessions[id];
    this.save();
  }
}

/**
 * Cybersecurity agent that drives the observe-decide-act loop between Ollama
 * and the Avendesora Node MCP server.
 */
class Agent {
  constructor({
    mcpClient,
    ollamaUrl,
    model,
    tools,
    memory,
    maxSteps = DEFAULT_MAX_STEPS,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
    contextTokenBudget = DEFAULT_CONTEXT_TOKEN_BUDGET,
  }) {
    this.mcpClient = mcpClient;
    this.ollamaUrl = ollamaUrl;
    this.model = model;
    this.tools = tools;
    this.memory = memory;
    this.maxSteps = maxSteps;
    this.maxHistoryMessages = maxHistoryMessages;
    this.contextTokenBudget = contextTokenBudget;
  }

  async run({ sessionId, userGoal, onToolCall, onToolResult, onApproval, onComplete }) {
    let messages = this.memory.getSession(sessionId).messages.slice();

    const systemPrompt =
      "You are Avendesora, a careful cybersecurity assistant. " +
      "Use the provided tools one at a time. After each tool result, " +
      "decide the single next best action or finish with a concise answer. " +
      "Never assume results; base every decision on actual tool output.";

    if (messages.length === 0) {
      messages.push({ role: "system", content: systemPrompt });
    }

    messages.push({ role: "user", content: userGoal });

    try {
      for (let step = 0; step < this.maxSteps; step++) {
        messages = this.compactContext(messages);

        const response = await this.queryOllama(messages);
        const assistantMessage = response.message;
        messages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls || [];
        if (toolCalls.length === 0) {
          this.memory.storeSession(sessionId, messages);
          if (onComplete) onComplete(assistantMessage.content);
          return assistantMessage.content;
        }

        // The model is allowed to emit multiple tool_calls in one turn by the
        // Ollama API, but the agent contract is one decision at a time. Process
        // only the first call and ignore the rest to keep the loop grounded.
        const call = toolCalls[0];
        const name = call.function?.name;
        const args = call.function?.arguments || {};

        if (!this.isValidTool(name)) {
          const errorText = `Tool '${name}' is not available on this Node.`;
          messages.push({ role: "tool", name, content: errorText });
          continue;
        }

        if (onToolCall) onToolCall(name, args);

        if (this.isActiveTool(name)) {
          const approved = await onApproval(name, args);
          if (!approved) {
            const blockedText = `User declined to run active tool '${name}'.`;
            messages.push({ role: "tool", name, content: blockedText });
            continue;
          }
        }

        const result = await this.mcpClient.callTool({ name, arguments: args });
        const text = result.content
          ?.map((c) => (c.type === "text" ? c.text : ""))
          .join("\n") || "(no output)";

        if (onToolResult) onToolResult(name, text);
        messages.push({ role: "tool", name, content: text });
      }

      const budgetMessage =
        "Step budget exhausted. Here is a summary of what was discovered:";
      messages.push({ role: "user", content: budgetMessage });
      const final = await this.queryOllama(messages);
      messages.push(final.message);
      this.memory.storeSession(sessionId, messages);
      if (onComplete) onComplete(final.message.content);
      return final.message.content;
    } catch (err) {
      this.memory.storeSession(sessionId, messages);
      throw err;
    }
  }

  async queryOllama(messages) {
    const body = {
      model: this.model,
      messages,
      tools: this.tools,
      stream: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      },
    };

    const res = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama returned ${res.status}: ${text}`);
    }

    return res.json();
  }

  isValidTool(name) {
    return this.tools.some((t) => t.function.name === name);
  }

  isActiveTool(name) {
    return ACTIVE_TOOLS.has(name);
  }

  /**
   * Keep the context window healthy by dropping the oldest tool-result pairs
   * while preserving the system prompt and the original user goal.
   *
   * This is intentionally simple: a production version can swap in a
   * summarization pass or vector memory here.
   */
  compactContext(messages) {
    const systemIdx = messages.findIndex((m) => m.role === "system");
    const userGoalIdx = messages.findIndex((m) => m.role === "user");

    const preserved = [];
    if (systemIdx !== -1) preserved.push(systemIdx);
    if (userGoalIdx !== -1) preserved.push(userGoalIdx);

    let working = messages.slice();
    let tokens = working.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

    while (
      (working.length > this.maxHistoryMessages || tokens > this.contextTokenBudget) &&
      working.length > preserved.length + 2
    ) {
      // Drop the oldest non-preserved message.
      for (let i = 0; i < working.length; i++) {
        if (preserved.includes(i)) continue;
        tokens -= estimateMessageTokens(working[i]);
        working.splice(i, 1);
        break;
      }
    }

    return working;
  }
}

/**
 * Ask the user a y/n question on stdin and return a boolean promise.
 */
function askYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

export { Agent, AgentMemory, ACTIVE_TOOLS, askYesNo };
export default Agent;
