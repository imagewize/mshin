#!/bin/bash
#
# Machin Shin Node MCP Probe
#
# Description: Minimal MCP client that verifies the Node's streamable-http
# transport end to end from the host: /health, initialize, and optionally one
# tools/call. Use it from the Mac or the Core after network changes or a
# socket_vmnet restart — see "The Node goes dark" in docs/LIMA-LOCAL-DEV.md.
# Everything it does must run on the host: the same checks from inside the
# guest all pass even when the Node is unreachable from outside.
#
# Usage: MSHIN_NODE_TOKEN=<token> probe_mcp_server.sh <node_ip> ['<tools/call JSON>']
# Examples:
#   MSHIN_NODE_TOKEN=<token> probe_mcp_server.sh 192.168.105.5
#   MSHIN_NODE_TOKEN=<token> probe_mcp_server.sh 192.168.105.5 \
#     '{"name":"nmap","arguments":{"target":"127.0.0.1","flags":["-sn"]}}'
#
# Exit codes: 0 — Node healthy (and the tool call, if any, succeeded)
#            1 — unhealthy: /health, transport or session failed
#            2 — transport healthy but the tool call returned an error

set -euo pipefail

NODE_IP="${1:?usage: $0 <node_ip> ['<tools/call JSON>']}"
TOOL_JSON="${2:-}"

if [ -z "${MSHIN_NODE_TOKEN:-}" ]; then
  echo "MSHIN_NODE_TOKEN is not set" >&2
  exit 1
fi

MCP="http://${NODE_IP}:3000/mcp"
CT='Content-Type: application/json'
AC='Accept: application/json, text/event-stream'
AUTH="Authorization: Bearer ${MSHIN_NODE_TOKEN}"

fail() {
  echo "$1" >&2
  exit 1
}

# 1. The server process answers.
curl -fsS -m 10 "http://${NODE_IP}:3000/health" >/dev/null ||
  fail "unhealthy: http://${NODE_IP}:3000/health did not answer. If curl hangs here, see 'The Node goes dark' in docs/LIMA-LOCAL-DEV.md"
echo "health: ok"

# 2. The MCP transport answers and grants a session.
HDRS=$(curl -sS -m 10 -D - -o /dev/null -X POST "$MCP" -H "$AUTH" -H "$CT" -H "$AC" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"mshin-probe","version":"1.0"}}}') ||
  fail "unhealthy: initialize failed at $MCP"
SID=$(printf '%s' "$HDRS" | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
[ -n "$SID" ] || fail "unhealthy: no mcp-session-id header — transport answered but no session"
echo "transport: ok (session ${SID})"

curl -fsS -m 10 -X POST "$MCP" -H "$AUTH" -H "$CT" -H "$AC" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

# 3. Optional: one tools/call, answered as a single SSE data line.
if [ -n "$TOOL_JSON" ]; then
  RESP=$(curl -sS -m 55 -X POST "$MCP" -H "$AUTH" -H "$CT" -H "$AC" -H "mcp-session-id: $SID" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":${TOOL_JSON}}") ||
    fail "tool call failed: curl error"
  TEXT=$(printf '%s' "$RESP" | sed -n 's/^data: //p')
  [ -n "$TEXT" ] || TEXT="$RESP"
  if printf '%s' "$TEXT" | grep -q '"isError":true\|"error":{"'; then
    printf '%s\n' "$TEXT"
    exit 2
  fi
  printf '%s\n' "$TEXT"
fi

echo "probe: healthy"
