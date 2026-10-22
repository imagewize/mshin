# Machin Shin CLI Clients

This package contains two Node-based clients for the Machin Shin Node:

- **`mshin`** — interactive terminal harness that connects an LLM to the Machin Shin Kali MCP server. Supports Ollama (local) and OpenAI-compatible providers such as OpenAI, Mistral, and Kimi (Moonshot).
- **`mshin-call`** — single-tool MCP caller. No LLM, no prompt; just call one tool and print the result.

## Install

```bash
cd /opt/mshin/clients/mshin-cli
npm install
```

## `mshin` — interactive agent loop

### Features

- Discovers tools from the MCP server.
- Sends the user prompt to an LLM with native tool support.
- Executes tool calls on the Machin Shin Node and feeds results back to the model.
- Runs a simple observe-decide-act loop until the model produces a final answer.
- Swappable LLM backend: Ollama for fully-local operation, or an OpenAI-compatible API for cloud models.

### Usage

```bash
# Local Ollama (default backend)
mshin 192.168.1.100
./index.js --node http://192.168.1.100:3000 --model mshin

# Use a different Ollama model:
mshin --model llama3.3:70b 192.168.1.100

# OpenAI-compatible provider (Kimi, Mistral, OpenAI, OpenRouter, etc.)
export MSHIN_LLM_API_KEY=<key>
mshin --backend kimi --model kimi-k2.7 --node http://192.168.1.100:3000
mshin --backend mistral --model mistral-small-latest --node http://192.168.1.100:3000

# Override the provider base URL
mshin --backend openai --api-base https://api.openai.com/v1 --model gpt-4o

# Authenticate to a Node that has MSHIN_NODE_TOKEN set:
mshin --token <token> 192.168.1.100
# or export MSHIN_NODE_TOKEN=<token> once and run mshin as usual
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MSHIN_NODE_URL` | Default `--node` value |
| `MSHIN_NODE_TOKEN` | Default `--token` value |
| `MSHIN_LLM_BACKEND` | Default `--backend` (`ollama`) |
| `MSHIN_LLM_API_BASE` | Default `--api-base` |
| `MSHIN_LLM_API_KEY` | Default `--api-key` |
| `MSHIN_LLM_TIMEOUT_MS` | Per-turn timeout in milliseconds (default 600000) |
| `OPENAI_API_KEY` | Fallback API key for `--backend openai` |
| `MISTRAL_API_KEY` | Fallback API key for `--backend mistral` |
| `MOONSHOT_API_KEY` | Fallback API key for `--backend kimi` |

### Requirements

- Node.js 20+
- A reachable Machin Shin Node.
- For the Ollama backend: Ollama running locally with the requested model pulled, and the `mshin` model created from `configs/ollama-modelfile`.
- For cloud backends: an API key exported in the environment or passed with `--api-key`.

## `mshin-call` — single-tool caller

Use this when you already know which tool you want and just need the raw output.

### Usage

```bash
# List tools exposed by the Node
mshin-call --list --node http://192.168.1.100:3000 --token <token>

# Call one tool with JSON arguments
mshin-call --node http://192.168.1.100:3000 --token <token> \
  nmap '{"target":"127.0.0.1","flags":["-sV"]}'

# Defaults and token can come from the environment
export MSHIN_NODE_URL=http://192.168.1.100:3000
export MSHIN_NODE_TOKEN=<token>
mshin-call whois '{"target":"example.com"}'
```

### Requirements

- Node.js 20+
- A reachable Machin Shin Node.
- The Node's bearer token if `MSHIN_NODE_TOKEN` is configured on the server.

## How the agent loop works

`index.js` is the CLI shell (arg parsing, MCP connection, backend selection,
the readline prompt); `agent.js` is where the observe-decide-act loop actually
lives, in `Agent.run()`. Each turn: send the message history plus the MCP
`tools` array to the configured LLM backend, look at what comes back, act on
it, repeat -- up to `DEFAULT_MAX_STEPS` (25) turns before the loop gives up and
asks the model to summarize what it found so far.

The backend abstraction lives in `llm-client.js`. It normalizes tool-call
responses and message history between Ollama's `/api/chat` and the
OpenAI-compatible `/v1/chat/completions` shape, so `agent.js` stays
provider-agnostic.

A few things about that loop aren't obvious from skimming it:

- **Every tool call in a turn is executed, in order.** The LLM response may
  carry multiple `tool_calls`; the loop runs all of them rather than keeping
  only the first. A live `recon-chain` run showed models emitting
  `whois` and `nmap` in one turn, and dropping the second call made the model
  believe the scan had already run. Honouring every call the model emits keeps
  the transcript faithful to what actually happened.
- **A narrated tool call is recovered, not trusted as a final answer.**
  Smaller models (this is tuned for Mistral Small 3 / 7B-class models, not
  frontier ones) sometimes write out `nmap(target="...")` or a JSON blob as
  plain text instead of emitting a native `tool_calls` entry -- and often
  invent a plausible-looking result to go with it. `extractTextToolCall`
  recognizes that shape and converts it into a real tool call; the narrated
  turn itself is dropped from history so the model's own fabrication can't
  later be read back as an established finding. `looksLikeFabricatedToolOutput`
  is the fallback for the case where no call, real or narrated, can be
  recovered at all -- it refuses to hand a scan-shaped answer to the operator
  when no scan actually ran.
- **`metasploit` requires explicit per-call approval.** Any tool name in
  `ACTIVE_TOOLS` triggers `onApproval` before it runs; declining is fed back
  to the model as a tool result (`User declined to run active tool ...`) so
  it can adjust rather than silently retry.
- **History is compacted, not just capped.** `compactContext` first
  compresses long tool results to a head/tail window (default 60 lines, keeping
  25 head and 25 tail) rather than dropping whole messages. If the budget is
  still exceeded, it drops the oldest non-preserved messages. The system prompt
  and original user goal are always preserved.
- **Sessions persist to disk.** `AgentMemory` stores each session's message
  history as JSON under `~/.mshin/memory.json`, keyed by session ID, so a
  conversation survives a CLI restart.
- **A tool that cannot run is not retried.** When a call comes back as an
  error whose text is environmental — `sudo: a password is required`, a missing
  binary, `no new privileges` — the loop marks that tool unavailable for the
  rest of the run, tells the model the failure is not a bad argument, and
  answers any further call to it from the transcript instead of re-running it.
  Ordinary tool errors (host down, no results) stay retryable. This is measured
  behaviour, not a guess: on a Node whose sudoers allowlist did not cover
  `whois`, both a mistral- and a qwen-class 8B model spent their entire step
  budget re-issuing the identical failing call.

See the doc comments in `agent.js` for the parsing details (the
Python-like-argument and balanced-brace-JSON extraction the narrated-call
recovery relies on) and `agent.test.js` for the behavior these rules are
pinned against.

## Session logs

Every agent run is recorded as an append-only JSONL event log under
`~/.mshin/sessions/<sessionId>.jsonl`. This is separate from the conversation
transcript stored in `~/.mshin/memory.json`: the JSONL file is an immutable
audit trail built for reporting and replay, while `memory.json` is the model's
working context.

Each line is a JSON object with `type`, `timestamp`, `sessionId`, and a
payload. Key event types:

- `session.start` — model, user goal, available tools, and step budget.
- `model.turn` — each assistant turn, including any tool calls requested.
- `tool.call` / `tool.result` — tool name, arguments, and the full text output.
- `approval.request` / `approval.response` — active-tool approval decisions.
- `fabrication.block` / `fabrication.nudge` — when invented tool output is caught.
- `session.end` — final answer and the run's metrics.
- `session.error` — error message and metrics if the run threw.

To disable session logging, set `MSHIN_NO_SESSION_LOG=1` before running the
CLI. The files are ordinary JSONL: they can be grepped, streamed, or converted
into a report with standard tools.

Session files are pruned on CLI startup to keep disk usage bounded. The default
keeps the 100 most recent sessions and deletes anything older than 30 days.
Override with `MSHIN_MAX_SESSIONS` and `MSHIN_MAX_SESSION_AGE_DAYS`.

To store logs outside the default `~/.mshin` directory — for example on a
host-mounted volume inside a Lima guest, or on a shared path on the Core — set
`MSHIN_DATA_DIR` before starting the CLI. Both `memory.json` and the
`sessions/` directory will live under that path.

## Model evaluation harness

`eval-harness.js` runs a scripted set of prompts against one or more models and
records measurable agent behaviour. Use it to compare `mistral-small`,
`qwen3:32b`, `llama3.3:70b`, `mistral-small-latest`, `kimi-k2.7`, or any other
model supported by the configured backend before deciding on
hardware.

### Measured metrics

- Wall-clock duration
- Steps taken and step budget
- Tool-call count and narrated-call count
- Fabricated outputs blocked by the backstop
- Active-tool approval requests (granted / denied)
- Context-window high-water mark in tokens
- Whether the case called every tool it declared in `expectedTools`
- Non-retryable tool failures, and how many retries of them the loop refused
- Final answer and any error

### Config format

Create a JSON file like `eval-config.json`:

```json
{
  "models": ["mshin", "mistral-small"],
  "backend": "ollama",
  "apiBase": "http://localhost:11434",
  "nodeUrl": "http://192.168.1.100:3000",
  "nodeToken": "<token>",
  "cases": [
    {
      "name": "nmap-localhost",
      "prompt": "Scan 127.0.0.1 with nmap and list open ports.",
      "expectedTools": ["nmap"],
      "maxSteps": 5,
      "approveActiveTools": true
    },
    {
      "name": "searchsploit-openssh",
      "prompt": "Use searchsploit to look up OpenSSH 8.9 exploits.",
      "expectedTools": ["searchsploit"],
      "maxSteps": 5
    }
  ]
}
```

When the Node requires authentication (`MSHIN_NODE_TOKEN` set on the server), add `nodeToken` to the config as above, or export `MSHIN_NODE_TOKEN` in the environment — the config file wins when both are present. The harness sends the token as `Authorization: Bearer <token>` on every MCP request.

### A harder case set

`eval-config.multi-tool.example.json` carries cases that need more than one
tool, a tool chosen conditionally on an earlier result, and a case that only
passes if the model reports honestly when a tool cannot run. Use it once a
model clears the single-tool set — that is where models start to separate.

### Run the harness

```bash
# JSON report (default)
node eval-harness.js eval-config.json

# Markdown summary
node eval-harness.js -f md eval-config.json

# CSV for spreadsheet analysis
node eval-harness.js -f csv -o ./eval-results eval-config.json
```

Reports are written to `--output-dir` (default `./eval-results`). The harness
connects to the same Node URL as the interactive CLI, uses the same backend
selection (`backend`, `apiBase`, `apiKey`), and auto-approves active tools when
`approveActiveTools` is true. An unknown `--format` is rejected before the first
model runs, so a typo cannot discard a finished suite.

### expectedTools and the exit code

`expectedTools` is optional. When a case declares it, the report records
`expectedToolsMet` and the `missingTools` the model never called, and the run
prints a summary of the misses.

This does **not** change the exit code, which stays non-zero only when a case
throws. A model that skips a tool it should have reached is the measurement the
suite exists to take — the number you compare between models — not a broken
run. Keeping the two apart means a clean comparison of a weak model still exits
zero, and a non-zero exit always means the harness itself hit trouble.
