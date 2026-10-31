# Agent Performance: Making mshin-cli Faster

> *"The Black Wind does not tire, and it does not turn back. But a wind that circles the same stone forever has gone nowhere at all."*

A performance analysis of the **mshin-cli agent loop** (`clients/mshin-cli/agent.js`)
and a prioritized plan to make it faster. Written after reading the full agent
loop, the MCP server, the findings memory, and the eval harness end to end.

---

## Overview

The agent loop is functionally solid — context compaction, structured findings
memory, fabrication detection, non-retryable error caching, and active-tool
approval gating all work. But the loop is **sequential by design**: one LLM turn,
then one tool call, then the next LLM turn. On a multi-tool recon chain the user
waits for each step to complete before the next begins, and the LLM generates
with `stream: false`, so the terminal sits blank for 30–300 seconds per turn.

This document identifies ten changes that make the loop measurably faster
without touching the tool set or the server. All ten (P0–P3) are implemented
on the `feature/agent-performance` branch.

---

## Where the Time Goes

A typical multi-tool turn in the current loop:

```
User prompt
  → LLM turn 1 (stream: false, 10–60s)     ← user sees nothing
    → Tool call 1 (nmap, 5–30s)             ← sequential
    → Tool call 2 (whois, 2–10s)            ← sequential, even if independent
  → LLM turn 2 (stream: false, 10–60s)     ← user sees nothing
    → Final answer
```

Three bottlenecks, in order of impact:

1. **No streaming.** `stream: false` means the user stares at a blank prompt for
   the entire generation. Perceived latency equals actual latency, which feels
   worse than it is.
2. **Sequential tool execution.** The loop runs every tool call in a turn one
   after another. Independent calls (whois + nmap, or nmap + searchsploit) could
   run concurrently.
3. **No result caching.** After context compaction drops a tool result, the model
   often re-issues the same call. Each re-scan costs 5–60 seconds of real time.

Two smaller costs:

4. **Synchronous memory writes.** `AgentMemory.save()` calls `writeFileSync()`
   on every turn, blocking the event loop while rewriting the entire
   `memory.json`.
5. **Minimal system prompt.** Three sentences. A richer prompt reduces wasted
   turns (the model calling the wrong tool, or fabricating output), which is
   the most expensive kind of slow.

---

## Recommendations

### P0 — Do First

| # | Change | Effort | Impact | Files |
|---|--------|--------|--------|-------|
| 1 | **Parallel tool execution** | Low (~30 lines) | 2–3x on multi-tool turns | `agent.js` |
| 2 | **Stream LLM output** | Medium (~80 lines) | High perceived speed | `agent.js`, `index.js` |

### P1 — Do Next

| # | Change | Effort | Impact | Files |
|---|--------|--------|--------|-------|
| 3 | **Tool result caching** | Low (~20 lines) | Eliminates redundant scans | `agent.js` |
| 4 | **Async memory writes** | Low (~10 lines) | Removes event-loop blocking | `agent.js` |
| 5 | **Richer system prompt** | Low (~10 lines) | Fewer wasted turns | `agent.js` |

### P2 — Later

| # | Change | Effort | Impact | Files |
|---|--------|--------|--------|-------|
| 6 | **Tool-aware context compression** | Medium | Smaller context = faster turns | `findings-memory.js`, `agent.js` |
| 7 | **Transient error retry** | Low | Catches network blips | `agent.js` |
| 8 | **Pre-warm model on connect** | Low | Faster first turn | `index.js` |

### P3 — Maintainability

| # | Change | Effort | Impact | Files |
|---|--------|--------|--------|-------|
| 9 | **Extract tool-call parser + fabrication detector** | Low | Testability, smaller agent.js | New files + `agent.js` |
| 10 | **Eval timing breakdown** | Low | Observability | `eval-harness.js` |

---

## Implemented: P0–P3

The following ten changes are implemented on this branch. Each is described
below with the design decision behind it.

### 1. Parallel Tool Execution (P0)

**What changed:** When a model turn contains multiple tool calls, passive/recon
tools now run concurrently via `Promise.allSettled()`. Active tools (metasploit,
hydra, sqlmap, john) still run sequentially after the passive batch, because they
mutate state and the user should see each result before the next fires.

**Why:** The loop already collects every call in a turn (`callsToRun`). Running
them sequentially was a deliberate early choice to "keep the loop grounded," but
the grounding comes from the tool results themselves, not from the order they
arrive in. Independent calls have no data dependency — whois on a domain does
not need nmap's output.

**Design:**
- Passive tools (everything not in `ACTIVE_TOOLS`) run in parallel.
- Active tools run sequentially, after the passive batch completes.
- Approval prompts for active tools still fire one at a time, in order.
- Results are pushed to the message history in the original call order, so the
  transcript stays readable and tool-call/result pairing is preserved.
- `Promise.allSettled()` ensures one tool's failure does not abort the others.

**Expected speedup:** 2–3x on turns with 2+ independent passive tool calls.

### 2. Stream LLM Output (P0)

**What changed:** `queryOllama()` now uses `stream: true` and reads the response
as newline-delimited JSON chunks. An `onToken` callback fires for each content
delta, and the CLI prints tokens as they arrive.

**Why:** With `stream: false`, Ollama buffers the entire generation and sends it
as one response. The user sees nothing for 10–300 seconds. With streaming, the
first token arrives in ~1 second and the user watches the model think.

**Design:**
- `postJsonStream()` is a new function alongside `postJson()`. It reads the
  response body chunk by chunk, parses each line as JSON, and calls `onToken`
  for `message.content` deltas.
- The final assembled message (content + tool_calls) is returned as before, so
  the rest of the loop is unchanged.
- The `onToken` callback is optional. When absent (tests, eval harness), the
  function behaves like the old `postJson` — collects everything, returns the
  full message.
- Tool calls arrive in the final chunk(s); the loop processes them after the
  stream ends, same as before.

**Expected speedup:** Perceived latency drops from "full generation time" to
"time to first token" (~1s). Actual throughput is unchanged.

### 3. Tool Result Caching (P1)

**What changed:** A per-run cache keyed by `toolName + canonical JSON of args`.
On a cache hit, the previous result is returned instantly without an MCP call.

**Why:** Context compaction drops old tool results from the LLM's view, but the
model often re-issues the same call (e.g., re-scanning the same host after the
previous result was compressed away). Each re-scan costs 5–60 seconds.

**Design:**
- Cache lives on the `Agent` instance, scoped to a single `run()` call (cleared
  at the start of each run).
- Key is `toolName + JSON.stringify(args)` with sorted keys, so argument order
  doesn't matter.
- Only successful results (`!result.isError`) are cached. Failures are not — a
  transient network error should be retried, not replayed.
- Cache is checked **after** the unavailable-tools check and **before** the
  approval gate, so a cached result still respects the approval flow on first
  call but skips re-approval on repeat.
- TTL is not implemented yet — the cache lives for one run. A TTL would help
  across runs but adds complexity (stale data risk).

**Expected speedup:** Eliminates redundant scans. On a 5-step recon chain where
the model re-scans once, saves 5–60 seconds.

### 4. Async Memory Writes (P1)

**What changed:** `AgentMemory.save()` now uses `writeFile()` (async) instead
of `writeFileSync()`. The method returns a promise that callers can await or
fire-and-forget.

**Why:** `writeFileSync()` blocks the Node.js event loop while writing the entire
`memory.json` (which grows with session history). On a large session this is a
measurable pause on every turn.

**Design:**
- `save()` is now async. It still writes the full JSON, just without blocking.
- Callers that need the write to complete before proceeding (e.g., before
  process exit) can `await` it. The agent loop fire-and-forgets — the JSONL
  session log is the durable audit trail; `memory.json` is a convenience cache.
- A debounced save (write at most once per second) is a possible follow-up but
  not implemented — the async write alone removes the event-loop block.

### 5. Richer System Prompt (P1)

**What changed:** The system prompt grew from 3 sentences to a structured prompt
with explicit rules for tool usage, output grounding, and scope awareness.

**Old prompt:**
```
You are Machin Shin, a careful cybersecurity assistant.
Use the provided tools one at a time. After each tool result,
decide the single next best action or finish with a concise answer.
Never assume results; base every decision on actual tool output.
```

**New prompt:**
```
You are Machin Shin, a careful cybersecurity assistant.

Rules:
- Call tools one at a time. After each tool result, decide the single
  next best action or finish with a concise answer.
- Never assume results. Base every decision on actual tool output.
- Never describe results from a tool you have not called. If a tool
  failed or is unavailable, say so plainly.
- When you emit multiple tool calls in one turn, they must be independent
  (no call may depend on another's result).
- Summarise scan results as structured lists (host:port, service, version)
  rather than prose.
- You are scanning authorized targets only. If a target is out of scope
  or a tool refuses it, report the refusal and suggest alternatives.
```

**Why:** A minimal prompt works for large models but leaves small models (7–8B)
room to misbehave — calling the wrong tool, fabricating output, or stopping
early. Explicit rules reduce wasted turns, which is the most expensive kind of
slow (a full LLM turn costs 10–60s).

### 6. Tool-Aware Context Compression (P2)

**What changed:** `compressToolResult()` takes an optional `toolName`, and
`compactContext()` passes each tool message's `name`. When the output exceeds
the line cap, the parsers in `findings-memory.js` first render it as compact
structured signal via a new exported `summarizeToolOutput()` — hosts and open
ports with service/version for nmap, registrar/dates/name servers for whois,
exploit path + EDB-id + CVEs for searchsploit, findings for nikto, and a generic
IP/port/CVE entity extraction for everything else. The signal is used only when
it is strictly smaller than the head/tail window; otherwise the original
head/tail fallback runs. The full output always stays in session memory.

**Why:** A 200-line nmap output used to reach the model as 51 lines of
head/tail (mostly boilerplate). As signal it is ~3–10 lines of pure facts.
Smaller context means faster LLM turns.

**Side fix:** the nmap text parser's port-line regex (`\s*($|.*)`) swallowed
the rest of the line, so the version was always null in text mode. It now
captures the remainder, which improves the findings summary too.

### 7. Transient Error Retry (P2)

**What changed:** `_executeToolCall()` now calls `_callToolWithRetry()`, which
makes up to two attempts. Both thrown transport errors (connection resets) and
`isError` results are retried once, after `toolRetryDelayMs` (default 2s,
configurable for tests) — unless the error matches `NON_RETRYABLE_TOOL_ERROR_RE`,
which fails identically on a second call and goes straight to the
unavailable-tools path. Retries are counted in `metrics.transientToolRetries`
and traced as `tool.retry` debug/session events.

**Why:** MCP connection resets and tool timeouts were one-shot failures; a
single retry catches most network blips without making the operator wait on
failures that cannot heal.

### 8. Pre-Warm Model on Connect (P2)

**What changed:** `index.js` fires a tiny warm-up request
(`"Hi"`, `num_predict: 1`, `stream: false`, 120s abort) at Ollama in the
background right after the reachability check, before the MCP connect and the
first prompt.

**Why:** The first turn of every session pays the cold start (10–30s for a
24B) while Ollama loads the model into memory. Best-effort: if the warm-up
fails, the first real turn simply pays the cold start as before.

### 9. Extract Tool-Call Parser + Fabrication Detector (P3)

**What changed:** Tool-call extraction (`extractTextToolCall` and its helpers)
moved to `clients/mshin-cli/tool-call-extract.js`; fabrication detection
(`looksLikeFabricatedToolOutput`, plus `ungroundedToolsIn` as a pure function
taking the tool list) moved to `clients/mshin-cli/fabrication-detect.js`.
`agent.js` imports both — no re-export shim, per `docs/REFACTORING-IDEAS.md` —
and `Agent.ungroundedToolsIn()` delegates to the pure function with this
Node's tool list. `agent.js` shrank from ~1,420 to ~1,180 lines.

### 10. Eval Timing Breakdown (P3)

**What changed:** `EvalHarness.runCase()` wraps the agent's `debug` trace with
a timer and reads the loop's existing events — `step`/`model.turn` bound each
LLM turn, `tool.call`/`tool.result` bound each tool execution (merged as wall
intervals so parallel tools are not double-counted), `approval.request`/
`approval.response` bound approval waits — plus an `onToken` hook for time to
first token. Every result row now carries `timing: { llmMs, toolMs,
approvalMs, firstTokenMs, overheadMs }` and `transientToolRetries`, and the
markdown/CSV reports render them.

**Why:** Wall-clock alone could not say whether to optimize LLM turns
(streaming, smaller context) or tool execution (caching, parallelism). The
breakdown makes it obvious at a glance.

---

## Not Implemented (Queued)

Nothing queued — all ten items above are implemented as of 2026-10-31.

---

## Success Metrics

How to measure whether these changes worked:

| Metric | Before | Target | How to measure |
|--------|--------|--------|----------------|
| Multi-tool turn wall time | Sum of all tool durations | Max of parallel tool durations | `eval-harness.js` `durationMs` vs. `timing.toolMs` |
| Time to first token | Full generation time | ~1s | `timing.firstTokenMs` in the eval report |
| LLM vs. tool share of a run | Unknown | Visible per case | `timing.llmMs` / `timing.toolMs` / `timing.overheadMs` |
| Redundant tool calls | Model re-calls after compaction | 0 | `metrics.toolCalls` vs. unique calls, `tool.cache-hit` events |
| Transient failures recovered | 0 (one-shot failure) | Most, with one retry | `metrics.transientToolRetries` |
| Context size of a long scan | 51 head/tail lines | ~signal lines | `compressToolResult` output, `contextHighWaterTokens` |
| Event-loop block time | `writeFileSync` on every turn | ~0 | Node.js `--trace-event-loop` |
| Wasted turns (fabrication, wrong tool) | Measured per model | Reduced | `metrics.fabricatedOutputsBlocked`, `metrics.errors` |

---

## Changelog

- **2026-10-31** — P2 and P3 implemented on `feature/agent-performance`:
  tool-aware context compression (`summarizeToolOutput` + `toolName` in
  `compressToolResult`, including the nmap text-parser version fix), transient
  error retry (one retry, 2s backoff, `toolRetryDelayMs`), model pre-warm on
  connect in `index.js`, extraction of the tool-call parser and fabrication
  detector into `tool-call-extract.js` / `fabrication-detect.js`, and the
  per-phase eval timing breakdown (`timing` in every eval result row).
- **2026-10-22** — Document created. P0 (parallel tool execution, stream LLM
  output) and P1 (tool result caching, async memory writes, richer system
  prompt) implemented on `feature/agent-performance`.

---

## See Also

- [Agent-Loop Investigations](AGENT-LOOP-INVESTIGATIONS.md) — defects found by running the eval harness
- [Refactoring Ideas](REFACTORING-IDEAS.md) — cleanups worth doing, and the ones deliberately avoided
- [Cybersecurity Agent Roadmap](CYBERSECURITY-AGENT-ROADMAP.md) — where the agent loop is headed
- [Developer Onboarding](DEVELOPER-ONBOARDING.md) — learning path and architecture
- [CLAUDE.md](../CLAUDE.md) — repo facts and conventions

---

*"The Wheel weaves as the Wheel wills, and the Black Wind ranges without rest. So too does a faster agent serve the Pattern."*
