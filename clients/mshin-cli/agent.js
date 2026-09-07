#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import http from "node:http";
import https from "node:https";

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 24_000;

// One model turn, not one run. Ten minutes is generous for an 8B on a laptop
// and still finite, so a genuinely wedged request surfaces instead of hanging
// the operator's session.
const DEFAULT_OLLAMA_TIMEOUT_MS = 600_000;

// Tools that can alter state or launch exploits require explicit user approval
// before each invocation. hydra brute-forces live credentials (can lock out
// real accounts) and sqlmap actively exploits SQL injection (can read or
// modify database contents), so both carry the same real-world risk as
// metasploit.
const ACTIVE_TOOLS = new Set(["metasploit", "hydra", "sqlmap"]);

// Tool failures no retry can fix. Every one of these is environmental — the
// binary is absent, the sudoers allowlist does not cover it, or systemd blocks
// the privilege transition — so an identical second call fails identically.
// Measured on a live run: given a whois the Node could not execute, both
// mistral- and qwen-class models spent their entire step budget re-issuing the
// same call, then gave up. The loop now marks the tool unavailable after the
// first such failure instead.
const NON_RETRYABLE_TOOL_ERROR_RE = new RegExp(
  [
    "sudo: a password is required",
    "no new privileges",
    "Tool binary not found",
    "Unknown tool:",
    "is not enabled",
    "command not found",
    "permission denied",
  ].join("|"),
  "i"
);

function isNonRetryableToolError(text) {
  return NON_RETRYABLE_TOOL_ERROR_RE.test(text || "");
}

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
      break; // valid JSON but not a call to a known tool; try the next `{`
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

/**
 * Locate `name(...)`-style calls in free text and return each one's name
 * alongside the raw, unparsed argument string between its parentheses.
 *
 * The regex only finds the opening `name(`; everything after that is walked
 * by hand rather than matched with a closing-paren regex, because the naive
 * `\)` match breaks the moment an argument contains its own parens (a
 * nested call) or a `)` inside a quoted string (e.g. a shell flag). The scan
 * below tracks paren depth and, while inside a quote, ignores parens
 * entirely (and skips an escaped quote so it doesn't end the string early).
 */
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

/**
 * Parse a Python-like keyword-argument string -- `target="1.2.3.4", flags=['-sS']`
 * -- into a plain object, without a general expression parser.
 *
 * Only `key=value` pairs are collected; a bare positional value (no `=`) is
 * scanned past and dropped, since every tool this agent calls takes named
 * arguments (per its MCP schema), so a positional the model wrote has no
 * schema field to land in anyway. Each value's own syntax (string/list/
 * object/literal) is handled by `parsePythonLikeValue`.
 */
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

/**
 * Recursive-descent parser for one argument value at `text[start:]`, used by
 * `parsePythonLikeArgs`. Returns the parsed JS value and the index just past
 * what it consumed, so the caller can keep scanning the rest of the string.
 *
 * Handles the shapes a model actually emits: a quoted string (with `\`
 * escapes), a `[...]` list (elements recursively parsed, so nested
 * lists/objects/strings all work), a `{...}` object (delegated to
 * `JSON.parse` -- Python dict syntax with double-quoted keys happens to be
 * valid JSON, and this loop only needs to find the matching `}`), or a bare
 * token (number/boolean/None/word) handed to `parseLiteral`.
 */
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

// Coerce a bare (unquoted) token to its likely type -- covering both
// Python's spelling (`True`/`False`/`None`) and JSON's, since the model may
// mix conventions. Anything that isn't a recognized literal or number is
// returned as-is (a plain string).
function parseLiteral(token) {
  if (token === "True" || token === "true") return true;
  if (token === "False" || token === "false") return false;
  if (token === "None" || token === "null") return null;
  if (/^-?\d+$/.test(token)) return parseInt(token, 10);
  if (/^-?\d+\.\d+$/.test(token)) return parseFloat(token);
  return token;
}

/**
 * Heuristic check for a model that invented tool output instead of calling a
 * tool -- e.g. writing its own fake nmap report rather than emitting a call
 * `extractTextToolCall` could have recovered. Pair it with the grounding check
 * at the call site: text like this is a summary when the tool it describes
 * actually returned a result, and a fabrication when it did not.
 *
 * Looks for two shapes: a fenced code block, or a "Result:" label, either of
 * which is followed by text that reads like genuine scan output (an
 * `<port>/tcp` or `<port>/udp` token near "open"/"closed"/"filtered"). This
 * is deliberately narrow -- it is meant to catch confident fabrication, not
 * to flag every code block or every use of the word "result".
 */
function looksLikeFabricatedToolOutput(content) {
  if (!content) return false;

  // A port/proto token next to a port-state word is the signature of scan
  // output wherever it appears -- fenced, labelled, or loose in prose.
  const scanSignature = (text) =>
    /\d+\/(tcp|udp)\b/i.test(text) && /\b(open|closed|filtered)\b/i.test(text);

  // Fenced code block containing "Result:" or scan-like output.
  const fenced = content.match(/```[\s\S]*?```/g) || [];
  for (const block of fenced) {
    const inner = block.slice(3, -3).toLowerCase();
    if (
      inner.includes("result:") ||
      inner.includes("results:") ||
      scanSignature(inner)
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

  // Unfenced, unlabelled scan output. The live recon-chain fabrication took
  // exactly this shape -- an inline markdown list ("- 22/tcp (SSH)") under the
  // prose "the nmap scan revealed the following open ports", with no code fence
  // and no "Result:" label for the two checks above to catch. The call site
  // only blocks this when the tool it reads like never returned a result, so a
  // genuine scan summary stays untouched.
  if (scanSignature(content)) {
    return true;
  }

  return false;
}

/**
 * POST JSON and read the whole response body.
 *
 * Deliberately node:http rather than fetch. With `stream: false` Ollama sends
 * no response headers until the entire generation has finished, and undici —
 * which backs global fetch — gives up after a default headersTimeout of 300s
 * and throws a bare `fetch failed` with no indication a timeout occurred. A
 * single turn on a large model passes 300s easily: it killed two evaluation
 * runs here at ~329s, at the same step, on two different models. Going through
 * node:http lets the limit be set deliberately and reported for what it is.
 */
function postJson(url, body, timeoutMs, model) {
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
            reject(new Error(`Ollama returned ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Ollama returned unparseable JSON: ${err.message}`));
          }
        });
      }
    );

    // An inactivity timeout, which for a non-streaming generation is the whole
    // wait: nothing arrives on the socket until the model is done.
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          new Error(
            `Ollama request timed out after ${Math.round(timeoutMs / 1000)}s ` +
              `(model '${model}'). One turn on a large model can take longer ` +
              "than this; raise ollamaTimeoutMs if that is expected."
          )
        );
      });
    }

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
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
 * A step-level trace of the agent loop -- the WP_DEBUG analogue. Off unless
 * MSHIN_DEBUG (to stderr) or MSHIN_DEBUG_LOG (append to that file, and stderr)
 * is set. Each call is one line: an event name and a compact JSON payload. It
 * exists because the metrics alone hid a real bug -- a model emitting two
 * tool_calls in one turn while the loop silently kept only the first -- which
 * the `model.turn` event's `dropped` field makes visible at a glance.
 */
function makeDebugLogger() {
  const file = process.env.MSHIN_DEBUG_LOG || null;
  const enabled = !!process.env.MSHIN_DEBUG || !!file;
  if (!enabled) return () => {};
  return (event, data) => {
    const payload =
      data === undefined
        ? ""
        : " " + (typeof data === "string" ? data : JSON.stringify(data));
    const line = `[mshin:debug] ${event}${payload}`;
    process.stderr.write(line + "\n");
    if (file) {
      try {
        appendFileSync(file, line + "\n");
      } catch {
        // A broken log path must never take the run down with it.
      }
    }
  };
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
    ollamaTimeoutMs = DEFAULT_OLLAMA_TIMEOUT_MS,
    metrics = null,
    debug = null,
  }) {
    this.mcpClient = mcpClient;
    this.ollamaUrl = ollamaUrl;
    this.model = model;
    this.tools = tools;
    this.memory = memory;
    this.maxSteps = maxSteps;
    this.maxHistoryMessages = maxHistoryMessages;
    this.contextTokenBudget = contextTokenBudget;
    this.ollamaTimeoutMs = ollamaTimeoutMs;
    this.metrics = metrics || {
      toolCalls: 0,
      narratedToolCalls: 0,
      fabricatedOutputsBlocked: 0,
      continuationNudges: 0,
      approvalRequests: 0,
      approvalGranted: 0,
      approvalDenied: 0,
      contextHighWaterTokens: 0,
      nonRetryableToolErrors: 0,
      blockedToolRetries: 0,
      steps: 0,
      errors: 0,
    };
    // Injectable so tests can capture the trace; falls back to the env-gated
    // logger for real runs.
    this.debug = debug || makeDebugLogger();
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

    // Scoped to the run, not the Agent: if the operator fixes the sudoers
    // allowlist between prompts, the next run rediscovers the tool at the cost
    // of one call rather than staying wrong for the life of the session.
    const unavailableTools = new Map();

    messages.push({ role: "user", content: userGoal });
    this.debug("run.start", {
      model: this.model,
      maxSteps: this.maxSteps,
      goal: userGoal,
    });

    try {
      // Tools whose calls came back without isError. A failed call grounds
      // nothing: the run that exposed this had whois fail and nmap never run,
      // yet a bare "a tool executed" flag was enough to let an invented
      // "Nmap Scan Results" block through to the user.
      const succeededTools = new Set();
      for (let step = 0; step < this.maxSteps; step++) {
        this.metrics.steps++;
        this.debug("step", { n: step + 1, of: this.maxSteps });
        messages = this.compactContext(messages);

        const response = await this.queryOllama(messages);
        const assistantMessage = response.message;
        messages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls || [];
        this.debug("model.turn", {
          contentChars: (assistantMessage.content || "").length,
          toolCalls: toolCalls.map((c) => c.function?.name),
        });

        // No native call: before accepting this as the final answer, check
        // whether the model narrated a call instead of emitting one.
        const narrated =
          toolCalls.length === 0
            ? extractTextToolCall(assistantMessage.content, (n) => this.isValidTool(n))
            : null;

        if (toolCalls.length === 0 && !narrated) {
          const ungrounded = this.ungroundedToolsIn(
            assistantMessage.content,
            succeededTools
          );
          const looksFabricated = looksLikeFabricatedToolOutput(
            assistantMessage.content
          );
          this.debug("final.check", {
            succeeded: [...succeededTools],
            ungrounded,
            looksFabricated,
          });
          if (
            (succeededTools.size === 0 || ungrounded.length > 0) &&
            looksFabricated
          ) {
            // The model narrated tool output for a tool that never returned a
            // result. Drop the turn so the invented result cannot become
            // history, and count it however this resolves.
            this.metrics.fabricatedOutputsBlocked++;
            messages.pop();

            // Ungrounded tools the model could still actually run -- valid on
            // this Node and not already marked unavailable for the run.
            const runnable = ungrounded.filter(
              (t) => this.isValidTool(t) && !unavailableTools.has(t)
            );
            const budgetRemains = step < this.maxSteps - 1;

            if (runnable.length > 0 && budgetRemains) {
              // Premature termination, not a dead end: the model invented a
              // result for a tool it never called, but that tool is available
              // and there is budget left. This is the recon-chain continuation
              // bug -- a first tool succeeding (whois) left models satisfied
              // enough to fabricate the rest (nmap) instead of calling it.
              // Refuse the fabrication and direct it to run the real tool,
              // then take another turn rather than returning.
              this.metrics.continuationNudges++;
              this.debug("fabrication.nudge", { runnable });
              const nudge =
                `You have not run ${runnable.join(", ")} yet, so any output you wrote for ` +
                `${runnable.length > 1 ? "those tools" : "that tool"} is invented, not real. ` +
                `Call ${runnable.length > 1 ? "each of them" : runnable[0]} now with the right ` +
                "arguments to finish the task. Report only actual tool output, and do not " +
                "describe results from a tool you have not run.";
              messages.push({ role: "user", content: nudge });
              continue;
            }

            // Nothing left to run (the tool is unavailable, or the budget is
            // spent): refuse the fabrication as the final answer.
            this.debug("fabrication.block", { ungrounded });
            const warning = ungrounded.length
              ? `The model produced output that looks like a result from ${ungrounded.join(", ")}, but ${ungrounded.length > 1 ? "those tools" : "that tool"} never returned one. I will not show unverified results.`
              : "The model produced output that looks like a tool result, but no tool executed. I will not show unverified results.";
            this.memory.storeSession(sessionId, messages);
            if (onComplete) onComplete(warning);
            return warning;
          }
          this.debug("final.accept", {
            chars: (assistantMessage.content || "").length,
          });
          this.memory.storeSession(sessionId, messages);
          if (onComplete) onComplete(assistantMessage.content);
          return assistantMessage.content;
        }

        // Run every tool the model asked for, in the order it asked. The loop
        // used to keep only toolCalls[0] and drop the rest "to keep the loop
        // grounded" -- but a live recon-chain run showed a model emit whois +
        // nmap in one turn, whereupon nmap was discarded and never re-issued:
        // the "models abandon the rest of a multi-tool goal" bug. The model had
        // committed to those calls; honouring them is more faithful than
        // dropping them and hoping it asks again. The debug trace's model.turn
        // event is what surfaced it.
        let callsToRun;
        if (narrated) {
          // Drop the narrated turn from the transcript. Its prose typically
          // carries invented tool output, and leaving it in history would let
          // the model treat its own fabrication as an established finding.
          this.metrics.narratedToolCalls++;
          messages.pop();
          const call = {
            function: { name: narrated.name, arguments: narrated.args },
          };
          messages.push({ role: "assistant", content: "", tool_calls: [call] });
          if (onNarratedToolCall) onNarratedToolCall(narrated.name);
          callsToRun = [call];
        } else {
          callsToRun = toolCalls;
        }

        // Tools that went unavailable during this turn. Their "continue the
        // task" direction is one role:"user" message pushed after every tool
        // result -- never interleaved between the results of a single assistant
        // turn, which would break tool-call/result pairing.
        const unavailableThisTurn = [];

        for (const call of callsToRun) {
          const name = call.function?.name;
          const args = call.function?.arguments || {};

          if (!this.isValidTool(name)) {
            this.debug("tool.invalid", { name });
            messages.push({
              role: "tool",
              name,
              content: `Tool '${name}' is not available on this Node.`,
            });
            continue;
          }

          if (unavailableTools.has(name)) {
            // Answered from the transcript instead of re-running the tool: the
            // model has already been told, so repeat it verbatim and spend no
            // step budget on a call that cannot behave differently.
            this.metrics.blockedToolRetries++;
            this.debug("tool.unavailable-cached", { name });
            messages.push({
              role: "tool",
              name,
              content: unavailableTools.get(name),
            });
            continue;
          }

          this.metrics.toolCalls++;
          this.debug("tool.call", { name, args });
          if (onToolCall) onToolCall(name, args);

          if (this.isActiveTool(name)) {
            this.metrics.approvalRequests++;
            const approved = await onApproval(name, args);
            if (!approved) {
              this.metrics.approvalDenied++;
              messages.push({
                role: "tool",
                name,
                content: `User declined to run active tool '${name}'.`,
              });
              continue;
            }
            this.metrics.approvalGranted++;
          }

          const result = await this.mcpClient.callTool({ name, arguments: args });
          const text =
            result.content
              ?.map((c) => (c.type === "text" ? c.text : ""))
              .join("\n") || "(no output)";

          if (onToolResult) onToolResult(name, text);
          this.debug("tool.result", {
            name,
            isError: !!result.isError,
            chars: text.length,
          });

          if (result.isError && isNonRetryableToolError(text)) {
            this.metrics.nonRetryableToolErrors++;
            this.debug("tool.unavailable", { name });
            // Keep the tool result slot short and factual. A long imperative
            // block in a role:"tool" slot -- which the model expects to hold
            // tool output -- stopped live 7-8B models terminating on the next
            // turn. The direction to continue goes in the role:"user" message
            // below, after all results for the turn.
            const toolResult =
              `Tool '${name}' cannot run on this Node: ${text}\n` +
              "This tool is unavailable for this run; do not retry it.";
            unavailableTools.set(name, toolResult);
            messages.push({ role: "tool", name, content: toolResult });
            unavailableThisTurn.push(name);
            continue;
          }

          if (!result.isError) succeededTools.add(name);
          messages.push({ role: "tool", name, content: text });
        }

        if (unavailableThisTurn.length > 0) {
          const names = unavailableThisTurn.join(", ");
          messages.push({
            role: "user",
            content:
              `Tool(s) ${names} could not run and are unavailable for this run. ` +
              "Continue the rest of the task. If another tool is needed, call it now. " +
              "Do not describe output no tool returned, and do not ask whether to continue. " +
              "Report only actual results, and say plainly what could not be determined.",
          });
        }
      }
      this.debug("budget.exhausted", { steps: this.metrics.steps });

      const budgetMessage =
        "Step budget exhausted. Here is a summary of what was discovered:";
      messages.push({ role: "user", content: budgetMessage });
      const final = await this.queryOllama(messages);
      messages.push(final.message);
      this.memory.storeSession(sessionId, messages);
      if (onComplete) onComplete(final.message.content);
      return final.message.content;
    } catch (err) {
      this.metrics.errors++;
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

    return postJson(
      `${this.ollamaUrl}/api/chat`,
      body,
      this.ollamaTimeoutMs,
      this.model
    );
  }

  isValidTool(name) {
    return this.tools.some((t) => t.function.name === name);
  }

  isActiveTool(name) {
    return ACTIVE_TOOLS.has(name);
  }

  /**
   * Known tools the content talks about that never returned a result. This is
   * what separates a summary from a fabrication once some other tool has run:
   * a real whois result does not license an invented nmap report.
   */
  ungroundedToolsIn(content, succeededTools) {
    if (!content) return [];
    return this.tools
      .map((t) => t.function.name)
      .filter(
        (name) =>
          !succeededTools.has(name) &&
          new RegExp(`\\b${name}\\b`, "i").test(content)
      );
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

    if (tokens > this.metrics.contextHighWaterTokens) {
      this.metrics.contextHighWaterTokens = tokens;
    }

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
 * Read one line from stdin through a readline interface of our own.
 *
 * Only safe when nothing else is reading stdin. A caller that already owns a
 * readline interface must pass its own reader to `askYesNo` instead.
 */
function readLineFromStdin(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Ask the user a y/n question and return a boolean promise.
 *
 * `ask` reads one line and is supplied by callers that already own stdin. The
 * CLI does: it keeps one readline interface for the whole session, and a
 * second interface on the same stdin leaves two `data` listeners racing for
 * the answer -- the approval reply reaches both, so it is consumed as a new
 * prompt while the question it was meant for never resolves. Callers with no
 * interface of their own get the default reader.
 */
function askYesNo(question, ask = readLineFromStdin) {
  return Promise.resolve(ask(`${question} (y/n): `)).then((answer) =>
    String(answer).trim().toLowerCase().startsWith("y")
  );
}

export { Agent, AgentMemory, ACTIVE_TOOLS, askYesNo };
export default Agent;
