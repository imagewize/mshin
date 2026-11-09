# Concurrent MCP Calls — Node Benchmark 2026-11-09

> *"Many threads can be woven at once on the same loom, if the weaver's hands do not wait for each to finish before starting the next."*

Since `feature/agent-performance`, mshin-cli fires a turn's passive tool calls
concurrently (`Promise.allSettled` in `clients/mshin-cli/agent.js`), with only
active tools kept sequential. The open question for `feature/concurrent-mcp-calls`:
does the **Node** actually execute concurrent `tools/call` requests in parallel —
both across separate sessions and within a single session? This run measures it
raw, with no client in the loop.

---

## Setup

- **Node:** the `mshin-node` Docker container on Docker Desktop (macOS), via
  `configs/compose.yaml` + `configs/compose.local.yaml`, published on
  `localhost:3001`, bearer-token auth, all 20 tools enabled, no
  `MSHIN_ALLOWED_TARGETS`. `/health` verified before the run.
- **Transport:** raw Streamable HTTP with `curl` — `initialize`,
  `notifications/initialized`, then `tools/call` over SSE
  (`protocolVersion: 2025-03-26`). No MCP SDK on the client side.
- **Target:** the project's own production domain (authorized). Placeholders
  `<TARGET_DOMAIN>` are used below; the run's real target is not recorded here.
- **Date:** 2026-11-09, Node up 3h at run time.

## Measurements

### Phase 1 — seven `tools/call` requests, each on its own session, fired simultaneously

| Tool | Arguments (summary) | Call wall time |
|------|--------------------|----------------|
| `nmap` | `<TARGET_DOMAIN>`, `-sV` on 12 ports | 22,160 ms |
| `dnsenum` | `<TARGET_DOMAIN>` | 62,458 ms |
| `ffuf` | `https://<TARGET_DOMAIN>/FUZZ`, 52-entry wordlist | 11,452 ms |
| `gobuster` | dns mode, `<TARGET_DOMAIN>`, 52-entry wordlist | 90 ms (failed — see Findings) |
| `nikto` | `https://<TARGET_DOMAIN>`, tuning 1,2,3,4,9 | 136,092 ms |
| `wpscan` | `https://<TARGET_DOMAIN>`, `vp,vt,u` | 960 ms (failed — see Findings) |
| `whois` | `<TARGET_DOMAIN>` | 1,219 ms |

- **Batch wall time: 136,250 ms**
- Sum of individual call walls: 234,539 ms
- Max individual call wall: 136,092 ms

Batch wall ≈ max, not sum: the seven calls ran **fully in parallel across
sessions**.

### Phase 2 — three `tools/call` requests on ONE shared session, fired concurrently

| Tool | Call wall time |
|------|----------------|
| `nmap` | 21,131 ms |
| `dnsenum` | 59,572 ms |
| `whois` | 1,233 ms |

- **Batch wall time: 59,623 ms**
- Sum of individual call walls: 81,936 ms
- Max individual call wall: 59,572 ms

Batch wall ≈ max again: concurrent requests **on a single session are also
multiplexed in parallel** (the transport correlates each SSE response stream by
JSON-RPC request id; nothing serializes them).

## Findings

1. **The Node needs no change for concurrent calls.** Handlers are async
   `execFile` calls, and Express + `StreamableHTTPServerTransport` dispatch each
   POST independently — measured wall time equals the slowest call, whether the
   calls arrive on seven sessions or one. The client's parallel passive batch
   is effective end to end; active tools stay sequential by design
   (`agent.js`).
2. **Pre-existing tool issues surfaced, unrelated to concurrency:** `gobuster`
   rejected `-d <domain>` with a flag parse error on the container's build, and
   `wpscan` returned `Command failed` with empty stderr — the handler reports
   `err.message` only, and `execFile` errors drop stderr. Worth a follow-up:
   tool errors should include the command's stderr so failures are diagnosable.

## Reproducing

```bash
# Node up: docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d
export MSHIN_NODE_TOKEN=$(sed -n 's/^MSHIN_NODE_TOKEN=//p' configs/mshin-node.env)
URL=http://localhost:3001/mcp
AUTH="Authorization: Bearer $MSHIN_NODE_TOKEN"
CT="Content-Type: application/json"
ACCEPT="Accept: application/json, text/event-stream"

curl -s -m 30 -D hdr.txt -X POST "$URL" -H "$AUTH" -H "$CT" -H "$ACCEPT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"bench","version":"0.1"}}}' -o /dev/null
SID=$(awk 'tolower($1)=="mcp-session-id:"{gsub("\r","");print $2}' hdr.txt)
curl -s -m 30 -X POST "$URL" -H "$AUTH" -H "$CT" -H "$ACCEPT" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' -o /dev/null

# fire N tools/call concurrently on that session; time each with date +%s%3N
# (or python3 -c 'import time;print(int(time.time()*1000))')
i=2
for spec in 'nmap:{"target":"<TARGET_DOMAIN>","flags":["-sV","-p","22,80,443"]}' \
            'whois:{"target":"<TARGET_DOMAIN>"}'; do
  name=${spec%%:*}; args=${spec#*:}
  ( S=$(python3 -c 'import time;print(int(time.time()*1000))'
    curl -s -m 960 -X POST "$URL" -H "$AUTH" -H "$CT" -H "$ACCEPT" -H "mcp-session-id: $SID" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" \
      -o "out-$name.sse"
    E=$(python3 -c 'import time;print(int(time.time()*1000))')
    echo "$((E-S))" > "out-$name.ms" ) &
  i=$((i+1))
done
wait
```

A fresh session per call works the same way — add the `initialize` step inside
each backgrounded subshell.

## Changelog

- **2026-11-09** — Benchmark created on `feature/concurrent-mcp-calls`: Node
  runs concurrent `tools/call` in parallel across sessions and within one
  session; no server-side serialization found.

---

## See Also

- [Agent Performance](AGENT-PERFORMANCE.md) — the client-side parallel tool execution this benchmark validates
- [Docker Local Dev](DOCKER-LOCAL-DEV.md) — the Node setup used here
- [Eval Run 2026-10-21](EVAL-RUN-2026-10-21.md) — the Docker Node eval suite

---

*"The loom holds many threads, and the Pattern is served all the faster for it."*
