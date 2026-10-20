# Machin Shin Kali MCP Server

A small [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes a curated set of Kali Linux security tools.

## Included tools

- `nmap`
- `searchsploit`
- `nikto`
- `whois`
- `tshark`
- `metasploit` (constrained to `use <module>; set ...; run`)

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

## Test

```bash
curl http://localhost:3000/health
```

## Adding a tool

1. Add a new entry to `tools.js` with `name`, `description`, `inputSchema`, and `handler`.
2. Add the tool name to the `--tools` flag in the systemd service and setup script.
3. If the tool needs `sudo`, add its absolute path to `/etc/sudoers.d/mshin`.
4. Document it in `docs/SETUP.md` and `KALI-OPENLLM.md`. Do **not** add it to `configs/ollama-modelfile`: a hand-written tool list in the system prompt trains small models to emit tool calls as text instead of native `tool_calls`.
