# Machin Shin CLI Client

An interactive terminal harness that connects a local Ollama instance to the Machin Shin Kali MCP server.

## Features

- Discovers tools from the MCP server.
- Sends the user prompt to Ollama with [native tool support](https://docs.ollama.com/capabilities/tool-calling).
- Executes tool calls on the Machin Shin Node and feeds results back to the model.
- Runs a simple observe-decide-act loop until the model produces a final answer.

## Install

```bash
cd /opt/mshin/clients/mshin-cli
npm install
```

## Usage

```bash
# Connect to the default Node IP:
mshin 192.168.1.100

# Or run the client directly:
./index.js --node http://192.168.1.100:3000 --model mshin

# Use a different model:
mshin --model llama3.3:70b 192.168.1.100
```

## Requirements

- Node.js 20+
- Ollama running locally with the requested model pulled.
- The `mshin` model created from `configs/ollama-modelfile`.

## How the agent loop works

`index.js` is the CLI shell (arg parsing, MCP connection, the readline
prompt); `agent.js` is where the observe-decide-act loop actually lives, in
`Agent.run()`. Each turn: send the message history plus the MCP `tools`
array to Ollama's [`/api/chat`](https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion),
look at what comes back, act on it, repeat --
up to `DEFAULT_MAX_STEPS` (25) turns before the loop gives up and asks the
model to summarize what it found so far.

A few things about that loop aren't obvious from skimming it:

- **Every tool call in a turn is executed, in order.** Ollama's API lets a
  response carry multiple `tool_calls`; the loop runs all of them rather than
  keeping only the first. A live `recon-chain` run showed models emitting
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
- **History is compacted, not just capped.** `compactContext` estimates
  token usage (~4 chars/token) and drops the oldest non-preserved messages
  once either `DEFAULT_MAX_HISTORY_MESSAGES` (40) or
  `DEFAULT_CONTEXT_TOKEN_BUDGET` (24,000 tokens) is exceeded, always keeping
  the system prompt and the original user goal.
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

## Model evaluation harness

`eval-harness.js` runs a scripted set of prompts against one or more models and
records measurable agent behaviour. Use it to compare `mistral-small`,
`qwen3:32b`, `llama3.3:70b`, or any other Ollama model before deciding on
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
  "ollamaUrl": "http://localhost:11434",
  "nodeUrl": "http://192.168.1.100:3000",
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
connects to the same Node and Ollama URLs as the interactive CLI and
auto-approves active tools when `approveActiveTools` is true. An unknown
`--format` is rejected before the first model runs, so a typo cannot discard a
finished suite.

### expectedTools and the exit code

`expectedTools` is optional. When a case declares it, the report records
`expectedToolsMet` and the `missingTools` the model never called, and the run
prints a summary of the misses.

This does **not** change the exit code, which stays non-zero only when a case
throws. A model that skips a tool it should have reached is the measurement the
suite exists to take — the number you compare between models — not a broken
run. Keeping the two apart means a clean comparison of a weak model still exits
zero, and a non-zero exit always means the harness itself hit trouble.
