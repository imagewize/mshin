# Developer Onboarding

> *"The way of the leaf is not always the easiest path, but it is the path of wisdom. So too with code: the path of understanding may be long, but it leads to mastery."*

A learning path for developers joining Machin Shin, and a map of how the JavaScript fits together. For proposed cleanups and the reasoning behind them, see [Refactoring Ideas](REFACTORING-IDEAS.md).

---

## Table of Contents

1. [Learning Path](#learning-path)
2. [JavaScript Architecture](#javascript-architecture)
3. [See Also](#see-also)

---

## Learning Path

### Phase 1: The Big Picture (Week 1)

**Goal:** Understand what Machin Shin is and how the two machines split the work.

**Read, in order:**
- `README.md` — project overview and quick start
- `CLAUDE.md` — canonical repo facts and conventions (the source of truth)
- `AGENTS.md` — working rules for anyone (human or agent) changing the code
- `docs/ARCHITECTURE.md` — system design, including "Why Ollama (and not raw llama.cpp)?"

**Key concepts:**
1. **Two-machine architecture:** Core (LLM inference + CLI) ↔ Node (Kali tools + MCP server, port 3000).
2. **Data flow:** User prompt → Core (LLM) → Machin Shin CLI → MCP client → MCP server (Node, :3000) → Kali tool → result back up the chain.
3. **Stack:** Node.js 20+, ESM modules, MCP over Streamable HTTP, Ollama, Express.
4. **The four-places rule (from `CLAUDE.md`):** when the tool set changes, four files must stay in sync — the `--tools` flag in `scripts/setup_mcp_server.sh`, the same flag in `configs/mcp-kali.service`, the `sudoers` allowlist for the `mshin` user, and the tool list in `servers/src/kali/tools.js`. Internalise this early; it constrains any refactor that touches tools.

### Phase 2: The JavaScript (Week 2)

#### Client (`clients/mshin-cli/`)

The CLI connects to Ollama for inference and to the MCP server for tools, then runs the agent loop (prompt → tool calls → results → final answer).

**Read in order:**

1. **`index.js`** (275 lines) — entry point. Arg parsing (including `--token` for Node authentication), MCP client setup, readline interface, session wiring.
2. **`agent.js`** (1157 lines) — the core. Start with the `Agent` class:
   - `run()` — the main loop.
   - `queryOllama()` — talks to Ollama over `node:http` directly (not `fetch`) for timeout control.
   - `compactContext()` — context-window management: compresses long tool results, preserves the system prompt / user goal / findings summary, drops the oldest messages when over budget.
   - `extractTextToolCall()` and helpers — recover tool calls when a model emits them as text instead of native `tool_calls`.
   - `looksLikeFabricatedToolOutput()` / `ungroundedToolsIn()` — detect and block invented tool output.
   - `AgentMemory` — JSON session storage under `~/.mshin/memory.json`.
3. **`findings-memory.js`** (920 lines) — structured findings memory. Exports `FindingsMemory` plus per-tool parsers (`parseNmapOutput`, `parseWhoisOutput`, `parseSearchsploitOutput`, `parseNiktoOutput`). Keeps critical facts alive across context compaction.
4. **`session-logger.js`** (127 lines) — structured session logs for debugging and audit (`SessionLogger`, `makeSessionLogger`).
5. **`eval-harness.js`** (580 lines) — the evaluation harness (`EvalHarness`, `behaviourVerdict`, `loadConfig`, `writeReport`). Regression testing for agent behaviour.
6. **`config.js`** (52 lines) — the loop's tunables: step/history/context budgets, Ollama timeout, tool-result compression limits, `FINDINGS_SUMMARY_MARKER`, `ACTIVE_TOOLS`, `NON_RETRYABLE_TOOL_ERROR_RE`. Imported by `agent.js`.

#### Server (`servers/src/kali/`)

1. **`index.js`** (184 lines) — Express + MCP server. `GET/POST/DELETE /mcp`, `GET /health`, per-session transports, `--tools` parsing, and the `requireAuth()` bearer-token middleware that runs when `MSHIN_NODE_TOKEN` is set.
2. **`tools.js`** (676 lines) — tool definitions and execution. `runTool()` (sudo handling, timeouts, buffer limits), `assertSafe()` / `assertSafeArray()` (shell-injection guards), `buildMsfScript()`. Defines the sixteen tools: nmap, searchsploit, nikto, whois, tshark, metasploit, hydra, sqlmap, gobuster, masscan, dirb, arping, dnsenum, enum4linux, ffuf, john.
3. **`config.js`** (213 lines) — server tunables and guards: `TOOL_PATHS`, `DEFAULT_TIMEOUT_MS`, the shell-metacharacter regexes, the `MSHIN_ALLOWED_TARGETS` scope allowlist (`isTargetAllowed`, `assertTargetInScope`), and the `MSHIN_NODE_TOKEN` bearer-token check (`AUTH_TOKEN`, `tokensMatch`, `isValidAuthToken`).

### Phase 3: Running and Testing (Week 3)

**Setup:**
```bash
cd clients/mshin-cli && npm install
cd ../../servers/src/kali && npm install
```

**Run the tests.** Both packages have a real test suite built on Node's built-in test runner (`node:test`) — no external framework required:
```bash
npm test    # runs node --check on every source file, then `node --test`
npm run check   # syntax pass only
```

The suites are substantial and are your safety net when refactoring (57 server cases, 102 client cases as of 0.16.0):
- `clients/mshin-cli/`: `agent.test.js` (1186 lines, ~57 cases), `eval-harness.test.js` (640), `findings-memory.test.js` (369)
- `servers/src/kali/`: `tools.test.js` (287), `scope.test.js` (129), `transport.test.js` (119), `auth.test.js` (149)

**Exercise:** add a case to `tools.test.js` for a new `assertSafe` rejection scenario. Run `npm test` and confirm it passes.

### Phase 4: Contributing (Week 4+)

Start small: doc typos, comments on dense functions, extra test cases. Then graduate to adding a tool (follow the four-places rule) or tightening error handling in one spot. Follow the commit rules in `CLAUDE.md` — one logical change per commit, conventional prefixes, and never credit an AI in a message.

---

## JavaScript Architecture

### Design philosophy (as it actually is)

1. **ESM everywhere** (`"type": "module"`).
2. **Near-zero runtime dependencies** — only `@modelcontextprotocol/sdk`. This is a deliberate constraint. Weigh any new dependency against it; the bar is high.
3. **Safety first** — extensive input validation before any binary runs.
4. **Resilience** — handles model quirks (fabrication, narration, text-form tool calls).
5. **Observability** — debug logging, session logging, eval harness.

### Client call tree

```
index.js (CLI)
├── parseArgs()
├── main() — verify Ollama, connect MCP, build Agent, start readline
└── MCP client (Client + StreamableHTTPClientTransport), tools → Ollama format

agent.js
├── Agent
│   ├── run() — main loop: system prompt, history, per-step queryOllama(),
│   │           tool-call handling (native or text-recovered), MCP execution,
│   │           context compaction, final answer
│   ├── queryOllama() — node:http, explicit timeouts
│   ├── compactContext() — compress + preserve + evict
│   ├── extractTextToolCall() → extractJsonToolCall(), extractFunctionSyntaxToolCall()
│   └── looksLikeFabricatedToolOutput(), ungroundedToolsIn()
├── AgentMemory — ~/.mshin/memory.json
└── config.js — the loop's tunables
    ├── DEFAULT_MAX_STEPS = 25
    ├── DEFAULT_MAX_HISTORY_MESSAGES = 40
    ├── DEFAULT_CONTEXT_TOKEN_BUDGET = 24_000
    ├── DEFAULT_OLLAMA_TIMEOUT_MS = 600_000
    ├── DEFAULT_MAX_TOOL_RESULT_LINES / HEAD / TAIL = 60 / 25 / 25
    ├── FINDINGS_SUMMARY_MARKER = "[Findings Summary"
    └── ACTIVE_TOOLS = Set(metasploit, hydra, sqlmap, john)
```

### Server call tree

```
index.js (MCP server)
├── parseEnabledTools() — from --tools
├── requireAuth() — bearer-token check on /mcp when MSHIN_NODE_TOKEN is set
├── createServer() — ListTools + CallTool handlers
├── Express: GET/POST/DELETE /mcp, GET /health
└── per-session transports Map

tools.js
├── assertSafe(), assertSafeArray()
├── runTool() — sudo -n when non-root, timeout, buffer caps, execFile (no shell)
├── buildMsfScript()
└── tools[] — each { name, description, inputSchema, handler }

config.js — TOOL_PATHS, DEFAULT_TIMEOUT_MS = 300_000, SHELL_META_RE
├── target scope allowlist (MSHIN_ALLOWED_TARGETS)
└── bearer-token check (MSHIN_NODE_TOKEN)
```

### Safety mechanisms (do not weaken these)

- Every string argument passes `assertSafe()`; shell metacharacters (`[;|&$()\<>]`) and null bytes are rejected.
- Binaries run via `execFile`, never `exec` or a shelled `spawn`.
- `runTool()` prefixes `sudo -n` when the process isn't root — which is why the `sudoers` allowlist is part of the four-places rule; a missing entry fails at call time, not startup.
- Fabrication detection blocks unverified "results" from reaching the user.
- `ACTIVE_TOOLS` (metasploit, hydra, sqlmap, john) require explicit user approval.
- When `MSHIN_NODE_TOKEN` is set on the server, every `/mcp` request must carry it as a bearer token; the CLI sends it via `--token` or `MSHIN_NODE_TOKEN`, and the eval harness via the `nodeToken` config field.

---

## See Also

- [Refactoring Ideas](REFACTORING-IDEAS.md) — proposed cleanups and the reasoning behind them
- [Architecture](ARCHITECTURE.md) — system design and components
- [CLAUDE.md](../CLAUDE.md) — repo facts, the four-places rule, commit conventions
- [AGENTS.md](../AGENTS.md) — working rules for contributors

---

*Last updated: 2026-10-20*
