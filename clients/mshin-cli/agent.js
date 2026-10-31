#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import http from "node:http";
import https from "node:https";

import { SessionLogger } from "./session-logger.js";
import { FindingsMemory, summarizeToolOutput } from "./findings-memory.js";
import { extractTextToolCall } from "./tool-call-extract.js";
import {
  looksLikeFabricatedToolOutput,
  ungroundedToolsIn,
} from "./fabrication-detect.js";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_RESULT_LINES,
  DEFAULT_TOOL_RESULT_HEAD_LINES,
  DEFAULT_TOOL_RESULT_TAIL_LINES,
  FINDINGS_SUMMARY_MARKER,
  ACTIVE_TOOLS,
  NON_RETRYABLE_TOOL_ERROR_RE,
  DEFAULT_TOOL_RETRY_DELAY_MS,
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
} from "./config.js";

function isNonRetryableToolError(text) {
  return NON_RETRYABLE_TOOL_ERROR_RE.test(text || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract the text content of an MCP tool result. */
function toolResultText(result) {
  return (
    result.content
      ?.map((c) => (c.type === "text" ? c.text : ""))
      .join("\n") || "(no output)"
  );
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
 * Compress a long tool result so the LLM context stays usable without dropping
 * the entire message. The full output remains in AgentMemory; only the copy
 * sent to the model is slimmed.
 *
 * Two strategies, tried in order:
 * 1. Tool-aware: when the result carries a tool name and the findings-memory
 *    parsers can reduce it to structured signal (host/port/service/version for
 *    nmap, registrar/dates for whois, ...), and that signal is smaller than
 *    the head/tail window, use the signal — a 200-line nmap output reaches the
 *    model as ~10 lines of pure signal instead of 51 lines of mostly boilerplate.
 * 2. Head/tail window (the original behaviour) as the fallback, for tools with
 *    no parser or output whose signal is not smaller.
 */
function compressToolResult(text, {
  toolName = null,
  maxLines = DEFAULT_MAX_TOOL_RESULT_LINES,
  headLines = DEFAULT_TOOL_RESULT_HEAD_LINES,
  tailLines = DEFAULT_TOOL_RESULT_TAIL_LINES,
} = {}) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;

  if (toolName) {
    const signal = summarizeToolOutput(toolName, text, headLines + tailLines);
    if (signal) {
      // The head/tail fallback renders headLines + 1 + tailLines lines; only
      // prefer the signal when it is strictly smaller than that.
      if (signal.split("\n").length < headLines + tailLines + 1) {
        return `${signal}\n... (full ${lines.length}-line output kept in session memory) ...`;
      }
    }
  }

  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `... (${omitted} lines omitted) ...`,
    ...lines.slice(-tailLines),
  ].join("\n");
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
 * POST JSON and read a streaming (NDJSON) response, calling onToken for each
 * content delta. Returns the assembled final message.
 *
 * Ollama's /api/chat with stream:true sends newline-delimited JSON chunks.
 * Each chunk carries a `message` with incremental `content` and possibly
 * `tool_calls` (in the final chunk(s)). This function accumulates content
 * across chunks, fires onToken for each delta, and resolves with the full
 * assembled message so the rest of the loop is unchanged.
 *
 * Used instead of postJson so the operator sees the model generate in real
 * time rather than staring at a blank prompt for the whole turn.
 */
function postJsonStream(url, body, timeoutMs, model, onToken) {
  const payload = JSON.stringify({ ...body, stream: true });
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
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () =>
            reject(new Error(`Ollama returned ${res.statusCode}: ${data}`))
          );
          return;
        }

        let buffer = "";
        let fullContent = "";
        let toolCalls = null;
        let settled = false;

        function assembleAndResolve() {
          if (settled) return;
          settled = true;
          resolve({
            message: {
              role: "assistant",
              content: fullContent,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
          });
        }

        function processLine(line) {
          if (!line.trim()) return;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              fullContent += parsed.message.content;
              if (onToken) onToken(parsed.message.content);
            }
            if (parsed.message?.tool_calls) {
              toolCalls = parsed.message.tool_calls.map((tc) => ({
                ...tc,
                function: {
                  ...tc.function,
                  arguments:
                    typeof tc.function?.arguments === "string"
                      ? JSON.parse(tc.function.arguments)
                      : tc.function?.arguments || {},
                },
              }));
            }
            if (parsed.done) {
              assembleAndResolve();
            }
          } catch {
            // Skip malformed lines — a partial chunk at the buffer boundary
            // is normal and will be completed by the next data event.
          }
        }

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          // NDJSON: each line is a separate JSON object. The last line may be
          // incomplete (no trailing newline yet), so keep it in the buffer.
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            processLine(line);
          }
        });
        res.on("end", () => {
          // Process any remaining buffer — the last line may lack a trailing
          // newline (a single-chunk response has no newline at all).
          if (buffer.trim()) {
            processLine(buffer);
          }
          // Stream ended without a done:true chunk — resolve with whatever
          // accumulated. An empty result means the model produced nothing.
          assembleAndResolve();
        });
        res.on("error", reject);
      }
    );

    // An inactivity timeout: with streaming, data arrives continuously, so
    // this fires only if the model stalls mid-generation.
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
    // Fire-and-forget async write. The JSONL session log is the durable audit
    // trail; memory.json is a convenience cache that can lag without harm.
    // The previous writeFileSync blocked the event loop on every turn while
    // rewriting the full sessions file. The returned promise lets callers
    // (tests, shutdown) wait for the write to land.
    this._lastSave = writeFile(
      this.storePath,
      JSON.stringify(this.sessions, null, 2)
    ).catch(() => {});
    return this._lastSave;
  }

  /** Wait for any in-flight async save to complete. */
  async flushSave() {
    if (this._lastSave) await this._lastSave;
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
    sessionLogger = null,
    findingsMemory = null,
    maxSteps = DEFAULT_MAX_STEPS,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
    contextTokenBudget = DEFAULT_CONTEXT_TOKEN_BUDGET,
    ollamaTimeoutMs = DEFAULT_OLLAMA_TIMEOUT_MS,
    toolRetryDelayMs = DEFAULT_TOOL_RETRY_DELAY_MS,
    mcpRequestTimeoutMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    maxToolResultLines = DEFAULT_MAX_TOOL_RESULT_LINES,
    toolResultHeadLines = DEFAULT_TOOL_RESULT_HEAD_LINES,
    toolResultTailLines = DEFAULT_TOOL_RESULT_TAIL_LINES,
    findingsTokenBudget = 2000,
    metrics = null,
    debug = null,
  }) {
    this.mcpClient = mcpClient;
    this.ollamaUrl = ollamaUrl;
    this.model = model;
    this.tools = tools;
    this.memory = memory;
    this.sessionLogger = sessionLogger;
    this.findingsMemory = findingsMemory || new FindingsMemory();
    this.maxSteps = maxSteps;
    this.maxHistoryMessages = maxHistoryMessages;
    this.contextTokenBudget = contextTokenBudget;
    this.ollamaTimeoutMs = ollamaTimeoutMs;
    this.toolRetryDelayMs = toolRetryDelayMs;
    this.mcpRequestTimeoutMs = mcpRequestTimeoutMs;
    this.maxToolResultLines = maxToolResultLines;
    this.toolResultHeadLines = toolResultHeadLines;
    this.toolResultTailLines = toolResultTailLines;
    this.findingsTokenBudget = findingsTokenBudget;
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
      transientToolRetries: 0,
      steps: 0,
      errors: 0,
    };
    // Injectable so tests can capture the trace; falls back to the env-gated
    // logger for real runs.
    this.debug = debug || makeDebugLogger();
    // Per-run cache of successful tool results, keyed by tool name + sorted
    // args. Cleared at the start of each run. Prevents redundant scans when
    // context compaction drops a result and the model re-issues the same call.
    this.toolCache = new Map();
    // Whether the most recent run's final answer was streamed via onToken.
    // The CLI uses this to avoid reprinting a streamed answer in onComplete.
    this.lastAnswerStreamed = false;
  }

  /**
   * Execute the main agent loop: observe-decide-act with Ollama and MCP tools.
   *
   * Orchestrates the full conversation lifecycle: maintains message history,
   * queries the LLM for each turn, executes any requested tools via MCP,
   * handles tool result processing with findings extraction, detects and
   * blocks fabricated tool output, manages context compaction to stay within
   * token budgets, and enforces user approval for active (dangerous) tools.
   *
   * The loop continues until one of:
   * - The model produces a final answer (no tool calls and no fabrication detected)
   * - The step budget is exhausted, triggering a final summary
   * - An error occurs
   *
   * Option B (structured findings memory): findings are extracted from tool outputs
   * and maintained in a separate summary that survives context compaction,
   * ensuring critical facts remain addressable even as raw outputs are dropped.
   *
   * @param {Object} options - Run configuration
   * @param {string} options.sessionId - Unique identifier for this conversation session
   * @param {string} options.userGoal - The user's initial prompt/goal
   * @param {Function} [options.onToolCall] - Callback when a tool is about to be called: (name, args)
   * @param {Function} [options.onToolResult] - Callback when a tool returns: (name, text)
   * @param {Function} [options.onApproval] - Callback to request user approval for active tools: (name, args) => boolean
   * @param {Function} [options.onComplete] - Callback when the run finishes: (answer)
   * @param {Function} [options.onNarratedToolCall] - Callback when a text-form tool call is recovered: (name)
   * @param {Function} [options.onToken] - Callback for each streamed content delta: (text)
   * @returns {Promise<string>} The final answer content (or warning if fabrication blocked)
   * @throws {Error} On unrecoverable errors during execution
   */
  async run({ sessionId, userGoal, onToolCall, onToolResult, onApproval, onComplete, onNarratedToolCall, onToken }) {
    let messages = this.memory.getSession(sessionId).messages.slice();

    const systemPrompt =
      "You are Machin Shin, a careful cybersecurity assistant.\n\n" +
      "Rules:\n" +
      "- Call tools one at a time. After each tool result, decide the single " +
      "next best action or finish with a concise answer.\n" +
      "- Never assume results. Base every decision on actual tool output.\n" +
      "- Never describe results from a tool you have not called. If a tool " +
      "failed or is unavailable, say so plainly.\n" +
      "- When you emit multiple tool calls in one turn, they must be independent " +
      "(no call may depend on another's result).\n" +
      "- Summarise scan results as structured lists (host:port, service, version) " +
      "rather than prose.\n" +
      "- You are scanning authorized targets only. If a target is out of scope " +
      "or a tool refuses it, report the refusal and suggest alternatives.";

    if (messages.length === 0) {
      messages.push({ role: "system", content: systemPrompt });
    }

    // Scoped to the run, not the Agent: if the operator fixes the sudoers
    // allowlist between prompts, the next run rediscovers the tool at the cost
    // of one call rather than staying wrong for the life of the session.
    const unavailableTools = new Map();
    
    // Clear findings memory for this new run - Option B: structured findings memory
    // Each run gets its own findings summary that builds up as tools execute
    this.findingsMemory.clear();
    // Clear the per-run tool result cache
    this.toolCache.clear();
    this.lastAnswerStreamed = false;

    messages.push({ role: "user", content: userGoal });
    this.debug("run.start", {
      model: this.model,
      maxSteps: this.maxSteps,
      goal: userGoal,
    });
    this.sessionLogger?.write(sessionId, {
      type: "session.start",
      model: this.model,
      goal: userGoal,
      tools: this.tools.map((t) => t.function.name),
      maxSteps: this.maxSteps,
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

        const response = await this.queryOllama(messages, onToken);
        const assistantMessage = response.message;
        messages.push(assistantMessage);

        const toolCalls = assistantMessage.tool_calls || [];
        this.debug("model.turn", {
          contentChars: (assistantMessage.content || "").length,
          toolCalls: toolCalls.map((c) => c.function?.name),
        });
        this.sessionLogger?.write(sessionId, {
          type: "model.turn",
          step: step + 1,
          contentPreview: (assistantMessage.content || "").slice(0, 500),
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
              this.sessionLogger?.write(sessionId, {
                type: "fabrication.nudge",
                runnable,
              });
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
            this.sessionLogger?.write(sessionId, {
              type: "fabrication.block",
              ungrounded,
              looksFabricated,
            });
            const warning = ungrounded.length
              ? `The model produced output that looks like a result from ${ungrounded.join(", ")}, but ${ungrounded.length > 1 ? "those tools" : "that tool"} never returned one. I will not show unverified results.`
              : "The model produced output that looks like a tool result, but no tool executed. I will not show unverified results.";
            this.memory.storeSession(sessionId, messages);
            this.sessionLogger?.write(sessionId, {
              type: "session.end",
              answer: warning,
              metrics: { ...this.metrics },
            });
            this.lastAnswerStreamed = false;
            if (onComplete) onComplete(warning);
            return warning;
          }
          this.debug("final.accept", {
            chars: (assistantMessage.content || "").length,
          });
          this.memory.storeSession(sessionId, messages);
          this.sessionLogger?.write(sessionId, {
            type: "session.end",
            answer: assistantMessage.content,
            metrics: { ...this.metrics },
          });
          this.lastAnswerStreamed = true;
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
          this.sessionLogger?.write(sessionId, {
            type: "narrated.recovered",
            name: narrated.name,
            args: narrated.args,
          });
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

        // Partition calls into passive (parallel) and active (sequential).
        // Passive tools have no side effects and no inter-call data dependency,
        // so they run concurrently. Active tools mutate state and require
        // per-call user approval, so they run sequentially after the passive
        // batch. The per-call logic lives in _executeToolCall; this section
        // just decides the execution order.
        const ctx = {
          sessionId,
          messages,
          unavailableTools,
          succeededTools,
          unavailableThisTurn,
          onToolCall,
          onToolResult,
          onApproval,
        };

        const passiveCalls = callsToRun.filter(
          (c) => !this.isActiveTool(c.function?.name)
        );
        const activeCalls = callsToRun.filter(
          (c) => this.isActiveTool(c.function?.name)
        );

        // Run passive tools concurrently. Promise.allSettled ensures one
        // tool's failure does not abort the others. Each call's synchronous
        // sections are atomic in JS's single-threaded model, so shared-state
        // mutations (metrics, findings, caches) are safe under parallelism.
        if (passiveCalls.length > 0) {
          this.debug("tools.parallel", {
            count: passiveCalls.length,
            names: passiveCalls.map((c) => c.function?.name),
          });
          await Promise.allSettled(
            passiveCalls.map((call) => this._executeToolCall(call, ctx))
          );
        }

        // Run active tools sequentially — the approval gate fires per call,
        // and each result is visible to the user before the next starts.
        for (const call of activeCalls) {
          await this._executeToolCall(call, ctx);
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
      const final = await this.queryOllama(messages, onToken);
      messages.push(final.message);
      this.memory.storeSession(sessionId, messages);
      this.sessionLogger?.write(sessionId, {
        type: "session.end",
        answer: final.message.content,
        metrics: { ...this.metrics },
      });
      this.lastAnswerStreamed = true;
      if (onComplete) onComplete(final.message.content);
      return final.message.content;
    } catch (err) {
      this.metrics.errors++;
      this.memory.storeSession(sessionId, messages);
      this.sessionLogger?.write(sessionId, {
        type: "session.error",
        error: err.message,
        metrics: { ...this.metrics },
      });
      throw err;
    }
  }

  async queryOllama(messages, onToken) {
    const body = {
      model: this.model,
      messages,
      tools: this.tools,
      options: {
        temperature: 0,
        top_p: 0.9,
        top_k: 40,
      },
    };

    // Streaming (stream: true) is set inside postJsonStream. The response is
    // NDJSON; onToken fires for each content delta so the CLI can print the
    // model's output as it generates rather than after the full turn.
    return postJsonStream(
      `${this.ollamaUrl}/api/chat`,
      body,
      this.ollamaTimeoutMs,
      this.model,
      onToken
    );
  }

  isValidTool(name) {
    return this.tools.some((t) => t.function.name === name);
  }

  /**
   * Execute a single tool call end-to-end: validate the tool name, check the
   * unavailable-tools and result caches, run the approval gate for active
   * tools, call the MCP server, process the result through findings memory,
   * and push the result message(s) to the conversation history.
   *
   * Extracted from the run() loop so that passive (non-active) tool calls can
   * execute concurrently via Promise.allSettled. Each call's synchronous
   * sections are atomic in JS's single-threaded model, so shared-state
   * mutations (metrics, findings, caches, unavailableTools, succeededTools)
   * are safe under parallel execution. Only the MCP call itself is async.
   *
   * @param {Object} call - The tool call: { function: { name, arguments } }
   * @param {Object} ctx - Run-scoped context shared across calls in one turn
   * @param {string} ctx.sessionId
   * @param {Array} ctx.messages - Message history (modified in-place)
   * @param {Map} ctx.unavailableTools - Tools that failed non-retryably this run
   * @param {Set} ctx.succeededTools - Tools that returned without isError
   * @param {Array} ctx.unavailableThisTurn - Names of tools unavailable this turn
   * @param {Function} [ctx.onToolCall] - (name, args) => void
   * @param {Function} [ctx.onToolResult] - (name, text) => void
   * @param {Function} [ctx.onApproval] - (name, args) => Promise<boolean>
   */
  async _executeToolCall(call, ctx) {
    const {
      sessionId,
      messages,
      unavailableTools,
      succeededTools,
      unavailableThisTurn,
      onToolCall,
      onToolResult,
      onApproval,
    } = ctx;
    const name = call.function?.name;
    const args = call.function?.arguments || {};

    if (!this.isValidTool(name)) {
      this.debug("tool.invalid", { name });
      this.sessionLogger?.write(sessionId, { type: "tool.invalid", name });
      messages.push({
        role: "tool",
        name,
        content: `Tool '${name}' is not available on this Node.`,
      });
      return;
    }

    if (unavailableTools.has(name)) {
      // Answered from the transcript instead of re-running the tool: the
      // model has already been told, so repeat it verbatim and spend no
      // step budget on a call that cannot behave differently.
      this.metrics.blockedToolRetries++;
      this.debug("tool.unavailable-cached", { name });
      this.sessionLogger?.write(sessionId, {
        type: "tool.unavailable.cached",
        name,
      });
      messages.push({
        role: "tool",
        name,
        content: unavailableTools.get(name),
      });
      return;
    }

    // Result cache: if this exact call succeeded earlier in the run, return
    // the cached output instantly. Prevents redundant scans when context
    // compaction drops a result and the model re-issues the same call.
    const cacheKey = `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
    if (this.toolCache.has(cacheKey)) {
      const cached = this.toolCache.get(cacheKey);
      this.debug("tool.cache-hit", { name });
      this.sessionLogger?.write(sessionId, {
        type: "tool.cache-hit",
        name,
      });
      if (onToolResult) onToolResult(name, cached);
      messages.push({ role: "tool", name, content: cached });
      return;
    }

    this.metrics.toolCalls++;
    this.debug("tool.call", { name, args });
    this.sessionLogger?.write(sessionId, {
      type: "tool.call",
      name,
      args,
    });
    if (onToolCall) onToolCall(name, args);

    if (this.isActiveTool(name)) {
      this.metrics.approvalRequests++;
      this.sessionLogger?.write(sessionId, {
        type: "approval.request",
        name,
        args,
      });
      const approved = await onApproval(name, args);
      this.sessionLogger?.write(sessionId, {
        type: "approval.response",
        name,
        approved,
      });
      if (!approved) {
        this.metrics.approvalDenied++;
        messages.push({
          role: "tool",
          name,
          content: `User declined to run active tool '${name}'.`,
        });
        return;
      }
      this.metrics.approvalGranted++;
    }

    const result = await this._callToolWithRetry(name, args, sessionId);
    const text = toolResultText(result);

    // Cache successful results so a re-issued identical call returns instantly.
    if (!result.isError) {
      this.toolCache.set(cacheKey, text);
    }

    if (onToolResult) onToolResult(name, text);
    this.debug("tool.result", {
      name,
      isError: !!result.isError,
      chars: text.length,
    });
    this.sessionLogger?.write(sessionId, {
      type: "tool.result",
      name,
      isError: !!result.isError,
      text,
    });

    // Process tool result with FindingsMemory (Option B: structured findings memory)
    // This extracts key facts that will survive context compaction
    if (!result.isError) {
      this.findingsMemory.processToolResult(name, text, args);
      succeededTools.add(name);
    }

    if (result.isError && isNonRetryableToolError(text)) {
      this.metrics.nonRetryableToolErrors++;
      this.debug("tool.unavailable", { name });
      this.sessionLogger?.write(sessionId, {
        type: "tool.unavailable",
        name,
        reason: text,
      });
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
      return;
    }

    if (!result.isError) succeededTools.add(name);
    messages.push({ role: "tool", name, content: text });
  }

  isActiveTool(name) {
    return ACTIVE_TOOLS.has(name);
  }

  /**
   * Call the MCP server, retrying once after a short backoff when the failure
   * looks transient. Non-retryable errors (missing binary, sudoers gap, ...)
   * fail identically on a second call, so they are returned immediately for
   * the unavailable-tools path. Everything else — thrown transport errors and
   * retryable isError results such as timeouts or connection resets — gets a
   * single retry, which catches most network blips without making the operator
   * wait on failures that cannot heal.
   */
  async _callToolWithRetry(name, args, sessionId) {
    const maxAttempts = 2;
    for (let attempt = 1; ; attempt++) {
      let result;
      try {
        // Pass an explicit request timeout: the MCP SDK's default is 60s,
        // which would kill long scans (nmap -p- and friends) client-side
        // while the Node is still happily running them server-side.
        result = await this.mcpClient.callTool(
          { name, arguments: args },
          undefined,
          { timeout: this.mcpRequestTimeoutMs }
        );
      } catch (err) {
        if (attempt >= maxAttempts || isNonRetryableToolError(err?.message)) throw err;
        await this._noteRetry(name, attempt, String(err?.message || err), sessionId);
        continue;
      }
      if (result.isError && attempt < maxAttempts) {
        const text = toolResultText(result);
        if (!isNonRetryableToolError(text)) {
          await this._noteRetry(name, attempt, text, sessionId);
          continue;
        }
      }
      return result;
    }
  }

  async _noteRetry(name, attempt, reason, sessionId) {
    this.metrics.transientToolRetries++;
    const summary = reason.slice(0, 200);
    this.debug("tool.retry", { name, attempt, reason: summary });
    this.sessionLogger?.write(sessionId, {
      type: "tool.retry",
      name,
      attempt,
      reason: summary,
    });
    await sleep(this.toolRetryDelayMs);
  }

  /**
   * Known tools the content talks about that never returned a result. This is
   * what separates a summary from a fabrication once some other tool has run:
   * a real whois result does not license an invented nmap report. The logic
   * lives in fabrication-detect.js; this delegates with this Node's tool list.
   */
  ungroundedToolsIn(content, succeededTools) {
    return ungroundedToolsIn(
      content,
      this.tools.map((t) => t.function.name),
      succeededTools
    );
  }

  /**
   * Keep the context window healthy by compressing long tool results and, only
   * if necessary, dropping the oldest tool-result pairs. The system prompt and
   * the original user goal are always preserved.
   *
   * Compression is the first line of defence: a 500-line nmap output gets
   * truncated to its head and tail rather than evicting the entire result.
   * The full output remains in AgentMemory; only the LLM-facing copy is slimmed.
   *
   * Option B (structured findings memory): if there are findings, keep a single
   * findings summary message right after the system prompt, refreshed on every
   * pass. This ensures critical facts (hosts, ports, services, CVEs) remain
   * addressable, and current, even when raw tool outputs are compressed or
   * dropped.
   *
   * The algorithm:
   * 1. Compress each tool result message that exceeds maxToolResultLines
   * 2. Insert/update a findings summary message (if findings exist)
   * 3. Identify preserved messages (system, user goal, findings summary)
   * 4. While over budget (message count OR token count): drop oldest non-preserved message
   *
   * @param {Array<Object>} messages - The current message history to compact
   * @param {string} messages[].role - Message role: "system", "user", "assistant", "tool"
   * @param {string} messages[].content - Message content text
   * @param {string} [messages[].name] - Tool name for tool-role messages
   * @returns {Array<Object>} Compacted message history, with system prompt, user goal, and findings preserved
   */
  compactContext(messages) {
    // First pass: compress long tool results in place rather than dropping the
    // whole message. If this alone brings the budget under the limit, nothing
    // is lost from the transcript.
    let working = messages.map((m) => {
      if (m.role !== "tool" || !m.content) return m;
      const compressed = compressToolResult(m.content, {
        toolName: m.name,
        maxLines: this.maxToolResultLines,
        headLines: this.toolResultHeadLines,
        tailLines: this.toolResultTailLines,
      });
      if (compressed === m.content) return m;
      return { ...m, content: compressed };
    });

    // Option B: keep exactly one findings-summary message, refreshed with the
    // latest aggregated findings on every pass so it never goes stale, and
    // never duplicated across compaction passes. It's added as an assistant
    // message so it's part of the conversation history the model can
    // reference, but it's separate from the raw tool outputs that may be
    // compressed or dropped.
    if (this.findingsMemory.hasFindings()) {
      const systemIdx = working.findIndex((m) => m.role === "system");
      if (systemIdx !== -1) {
        const findingsSummary = this.findingsMemory.getSummary(this.findingsTokenBudget);
        const findingsContent = `${FINDINGS_SUMMARY_MARKER} - Do not edit this section, only reference it]\n${findingsSummary}`;
        const existingIdx = working.findIndex(
          (m) => m.role === "assistant" && m.content?.startsWith(FINDINGS_SUMMARY_MARKER)
        );

        if (existingIdx !== -1) {
          // Refresh in place -- same index, so nothing else shifts.
          working[existingIdx] = { ...working[existingIdx], content: findingsContent };
        } else {
          working.splice(systemIdx + 1, 0, { role: "assistant", content: findingsContent });
        }
      }
    }

    // Preserved indices are computed from the final shape of `working`, after
    // any findings-message insertion/refresh above, so they always point at
    // the system prompt, the original user goal, and the findings summary --
    // never at whatever happens to have shifted into their old slot.
    const preserved = [];
    const systemIdx = working.findIndex((m) => m.role === "system");
    const userGoalIdx = working.findIndex((m) => m.role === "user");
    const findingsIdx = working.findIndex(
      (m) => m.role === "assistant" && m.content?.startsWith(FINDINGS_SUMMARY_MARKER)
    );
    if (systemIdx !== -1) preserved.push(systemIdx);
    if (userGoalIdx !== -1) preserved.push(userGoalIdx);
    if (findingsIdx !== -1) preserved.push(findingsIdx);

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
async function askYesNo(question, ask = readLineFromStdin) {
  const answer = await ask(`${question} (y/n): `);
  return String(answer).trim().toLowerCase().startsWith("y");
}

export { Agent, AgentMemory, ACTIVE_TOOLS, askYesNo, compressToolResult };
export default Agent;
