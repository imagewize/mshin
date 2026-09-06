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
 * Recover a tool call the model wrote as text instead of emitting through the
 * function-calling interface.
 *
 * Small models given a tools array sometimes narrate the call -- "To scan
 * 127.0.0.1, I will use nmap..." followed by `[{"name":"nmap","arguments":
 * {...}}]` and, worse, an invented scan report. Ollama returns that as plain
 * `content` with no `tool_calls`, so without this the loop treats the whole
 * fabrication as the model's final answer and hands it to the operator as
 * though a scan had run. Lowering the sampling temperature makes this rarer
 * but never impossible, so the loop refuses to depend on it.
 *
 * Returns { name, args } for the first payload naming a tool this Node
 * actually exposes, or null. Requiring a known tool name is what keeps a
 * legitimate answer that merely quotes JSON from being mistaken for a call.
 */
export function extractTextToolCall(content, isValidTool) {
  if (!content) return null;

  // Mistral-family models wrap the payload; strip the marker if present.
  const text = content.replace("[TOOL_CALLS]", " ");

  const json = extractJsonToolCall(text, isValidTool);
  if (json) return json;

  return extractFunctionSyntaxToolCall(text, isValidTool);
}

function extractJsonToolCall(text, isValidTool) {
  // Walk every balanced {...} span rather than regexing for one shape: the
  // payload may be bare, fenced in ```json, or embedded mid-sentence.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      if (depth !== 0) continue;

      let parsed;
      try {
        parsed = JSON.parse(text.slice(i, j + 1));
      } catch {
        break; // not JSON; move the start marker along
      }
      const name = parsed?.name ?? parsed?.function?.name;
      const args =
        parsed?.arguments ?? parsed?.parameters ?? parsed?.function?.arguments ?? {};
      if (typeof name === "string" && isValidTool(name) && typeof args === "object") {
        return { name, args };
      }
      break;
    }
  }
  return null;
}

function extractFunctionSyntaxToolCall(text, isValidTool) {
  // Some models emit calls as text: functions.nmap(target="127.0.0.1") or
  // nmap(target="127.0.0.1", flags=['-sS']). Prefer the `functions.` prefix
  // because it is less likely to appear in ordinary prose.
  for (const { name, argString } of findFunctionCalls(text)) {
    if (!isValidTool(name)) continue;
    try {
      const args = parsePythonLikeArgs(argString);
      return { name, args };
    } catch {
      continue;
    }
  }
  return null;
}

function findFunctionCalls(text) {
  const calls = [];
  // Match optional `functions.` prefix.
  const pattern = /(?:functions\.)?([a-zA-Z_]\w*)\s*\(/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    let quote = null;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\" && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      i++;
    }
    if (depth === 0) {
      calls.push({ name, argString: text.slice(start, i - 1) });
    }
  }
  return calls;
}

function parsePythonLikeArgs(argString) {
  const args = {};
  let i = 0;
  while (i < argString.length) {
    while (i < argString.length && /[\s,]/.test(argString[i])) i++;
    if (i >= argString.length) break;

    let key = "";
    while (i < argString.length && /[a-zA-Z0-9_]/.test(argString[i])) key += argString[i++];
    if (!key) {
      // Unexpected token; skip to next delimiter.
      while (i < argString.length && !/[,=]/.test(argString[i])) i++;
      continue;
    }

    while (i < argString.length && /\s/.test(argString[i])) i++;
    if (i >= argString.length || argString[i] !== "=") {
      // Positional argument; skip its value.
      let depth = 0;
      while (i < argString.length) {
        if (argString[i] === "(" || argString[i] === "[" || argString[i] === "{") depth++;
        else if (argString[i] === ")" || argString[i] === "]" || argString[i] === "}") depth--;
        else if (argString[i] === "," && depth === 0) break;
        i++;
      }
      continue;
    }
    i++; // skip =

    while (i < argString.length && /\s/.test(argString[i])) i++;
    const parsed = parsePythonLikeValue(argString, i);
    args[key] = parsed.value;
    i = parsed.nextIndex;
  }
  return args;
}

function parsePythonLikeValue(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return { value: null, nextIndex: i };

  const ch = text[i];
  if (ch === '"' || ch === "'") {
    let str = "";
    const quote = ch;
    i++;
    while (i < text.length && text[i] !== quote) {
      if (text[i] === "\\" && i + 1 < text.length) {
        str += text[i + 1];
        i += 2;
      } else {
        str += text[i];
        i++;
      }
    }
    i++; // skip closing quote
    return { value: str, nextIndex: i };
  }

  if (ch === "[") {
    const arr = [];
    i++; // skip [
    while (i < text.length && text[i] !== "]") {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i < text.length && text[i] === "]") break;
      const elem = parsePythonLikeValue(text, i);
      arr.push(elem.value);
      i = elem.nextIndex;
    }
    i++; // skip ]
    return { value: arr, nextIndex: i };
  }

  if (ch === "{") {
    let depth = 1;
    const startObj = i;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    try {
      return { value: JSON.parse(text.slice(startObj, i)), nextIndex: i };
    } catch {
      return { value: text.slice(startObj, i), nextIndex: i };
    }
  }

  let token = "";
  while (i < text.length && !/[,\)\]]/.test(text[i])) token += text[i++];
  token = token.trim();
  return { value: parseLiteral(token), nextIndex: i };
}

function parseLiteral(token) {
  if (token === "True" || token === "true") return true;
  if (token === "False" || token === "false") return false;
  if (token === "None" || token === "null") return null;
  if (/^-?\d+$/.test(token)) return parseInt(token, 10);
  if (/^-?\d+\.\d+$/.test(token)) return parseFloat(token);
  return token;
}

function looksLikeFabricatedToolOutput(content) {
  if (!content) return false;

  // Fenced code block containing "Result:" or scan-like output.
  const fenced = content.match(/```[\s\S]*?```/g) || [];
  for (const block of fenced) {
    const inner = block.slice(3, -3).toLowerCase();
    if (
      inner.includes("result:") ||
      inner.includes("results:") ||
      (/\b(open|closed|filtered)\b/.test(inner) && /\d+\/(tcp|udp)\b/.test(inner))
    ) {
      return true;
    }
  }

  // "Result:" followed by output that looks like a tool report.
  const resultIdx = content.toLowerCase().indexOf("result:");
  if (resultIdx !== -1) {
    const tail = content.slice(resultIdx);
    if (
      /\d+\/(tcp|udp)\b/i.test(tail) ||
      /\b(open|closed|filtered)\b/i.test(tail)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Persistent session memory for the Machin Shin agent.
 *
 * Sessions are stored as JSON so the operator can review, delete, or migrate
 * them easily. The storage path can be swapped for SQLite later if multi-user
 * or concurrent access is needed.
 */
class AgentMemory {
  constructor(dataDir = join(homedir(), ".mshin")) {
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
 * and the Machin Shin Node MCP server.
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

  async run({ sessionId, userGoal, onToolCall, onToolResult, onApproval, onComplete, onNarratedToolCall }) {
    let messages = this.memory.getSession(sessionId).messages.slice();

    const systemPrompt =
      "You are Machin Shin, a careful cybersecurity assistant. " +
      "Use the provided tools one at a time. After each tool result, " +
      "decide the single next best action or finish with a concise answer. " +
      "Never assume results; base every decision on actual tool output.";

    if (messages.length === 0) {
      messages.push({ role: "system", content: systemPrompt });
    }

    messages.push({ role: "user", content: userGoal });

    try {
      let toolWasExecuted = false;
      for (let step = 0; step < this.maxSteps; step++) {
        messages = this.compactContext(messages);

        const response = await this.queryOllama(messages);
        const assistantMessage = response.message;
        messages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls || [];

        // No native call: before accepting this as the final answer, check
        // whether the model narrated a call instead of emitting one.
        const narrated =
          toolCalls.length === 0
            ? extractTextToolCall(assistantMessage.content, (n) => this.isValidTool(n))
            : null;

        if (toolCalls.length === 0 && !narrated) {
          if (!toolWasExecuted && looksLikeFabricatedToolOutput(assistantMessage.content)) {
            // The model narrated tool output without ever emitting a call. Do
            // not return the fabrication as an answer, and drop the turn so the
            // invented result cannot become history.
            messages.pop();
            const warning =
              "The model produced output that looks like a tool result, but no tool executed. I will not show unverified results.";
            this.memory.storeSession(sessionId, messages);
            if (onComplete) onComplete(warning);
            return warning;
          }
          this.memory.storeSession(sessionId, messages);
          if (onComplete) onComplete(assistantMessage.content);
          return assistantMessage.content;
        }

        // The model is allowed to emit multiple tool_calls in one turn by the
        // Ollama API, but the agent contract is one decision at a time. Process
        // only the first call and ignore the rest to keep the loop grounded.
        let call;
        if (narrated) {
          // Drop the narrated turn from the transcript. Its prose typically
          // carries invented tool output, and leaving it in history would let
          // the model treat its own fabrication as an established finding.
          messages.pop();
          call = { function: { name: narrated.name, arguments: narrated.args } };
          messages.push({ role: "assistant", content: "", tool_calls: [call] });
          if (onNarratedToolCall) onNarratedToolCall(narrated.name);
        } else {
          call = toolCalls[0];
        }
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
        toolWasExecuted = true;
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
        temperature: 0,
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
