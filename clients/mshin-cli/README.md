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

- **Only the first tool call per turn is executed.** Ollama's API lets a
  response carry multiple `tool_calls`, but the agent's contract is one
  decision at a time -- the rest of that turn's calls are dropped so every
  decision is grounded in a real result before the next one is made.
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

See the doc comments in `agent.js` for the parsing details (the
Python-like-argument and balanced-brace-JSON extraction the narrated-call
recovery relies on) and `agent.test.js` for the behavior these rules are
pinned against.
