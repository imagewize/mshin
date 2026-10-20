# Machin Shin Kali MCP Server

A small [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes a curated set of Kali Linux security tools.

## Included tools

- `nmap`
- `searchsploit`
- `nikto`
- `whois`
- `tshark`
- `metasploit` (constrained to `use <module>; set ...; run`)
- `hydra`
- `sqlmap`
- `gobuster`
- `masscan`
- `dirb`
- `arping`
- `dnsenum`
- `enum4linux`
- `ffuf`
- `john`

## Install

```bash
cd /opt/mshin/servers/src/kali
npm install
```

## Run

```bash
node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum,enum4linux,ffuf,john
```

The server listens on port `3000` by default (override with `MSHIN_NODE_PORT`).

## Authentication

The server listens on `0.0.0.0`, so without further configuration any host on the LAN can drive the tools. Set `MSHIN_NODE_TOKEN` to require `Authorization: Bearer <token>` on every `/mcp` request:

```bash
export MSHIN_NODE_TOKEN="$(openssl rand -hex 32)"
```

`/health` stays open so the documented health check keeps working. Leave the variable unset to keep the legacy open behavior (not recommended on a shared LAN). Clients pass the token via `--token` / `MSHIN_NODE_TOKEN` (the `mshin` CLI) or the `nodeToken` config field (the eval harness). See `docs/SETUP.md` for the full walkthrough.

## Test

```bash
curl http://localhost:3000/health
```

## Adding a tool

1. Add a new entry to `tools.js` with `name`, `description`, `inputSchema`, and `handler`.
2. Add the tool name to the `--tools` flag in the systemd service and setup script.
3. If the tool needs `sudo`, add its absolute path to `/etc/sudoers.d/mshin`.
4. Document it in `docs/SETUP.md` and `KALI-OPENLLM.md`. Do **not** add it to `configs/ollama-modelfile`: a hand-written tool list in the system prompt trains small models to emit tool calls as text instead of native `tool_calls`.
