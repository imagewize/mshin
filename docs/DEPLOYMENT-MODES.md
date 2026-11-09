# Deployment Modes

> *"The Wheel turns, and the shapes of deployment turn with it — the Pattern holds in every arrangement, if each thread keeps its place."*

## Overview

The Node code and its MCP surface are identical in every mode; what changes is
**who runs the agent** and **where inference happens**. The README shows the default
two-machine diagram; this page carries the full setup snippets and caveats:

| Mode | Agent | Inference | Node runs as | Private & offline |
| ---- | ----- | --------- | ------------ | ----------------- |
| Two-machine (default) | `mshin` CLI | Local Ollama (Mistral Small 3, 24B) | Kali mini PC / SFF on your LAN | Yes |
| Cloud inference hybrid | `mshin` CLI on any laptop | Cloud GPU VPS | Node on your LAN (Pi / mini PC) | No — prompts go to the cloud |
| Mistral Vibe + Docker Node | Mistral Vibe CLI | Mistral Pro subscription (cloud) | Docker container on one Mac | No — prompts go to Mistral |
| OpenCode + Docker Node | OpenCode CLI | Local Ollama | Docker container on one Mac | Yes |

## Prerequisites (common to all modes)

- A Machin Shin Node reachable at a URL (mini PC, Pi, VPS, Docker container,
  or Lima guest) — see [Setup](SETUP.md) for the bare-metal Node and
  [Docker Local Dev](DOCKER-LOCAL-DEV.md) for the container.
- `MSHIN_NODE_TOKEN` synchronized to the Node and the clients with
  `scripts/setup_mcp_auth.sh` (writes `configs/mshin-node.env`, `~/.vibe/.env`,
  and patches `~/.config/opencode/opencode.jsonc`).
- Targets you own or are authorized to test — see the README's Authorized use section.

## The two-machine setup (default)

The canonical deployment: a Core box (32GB+ RAM) running Ollama and the `mshin`
CLI, and a Kali Node on the same LAN running the MCP server. See
[Architecture](ARCHITECTURE.md) for components and sizing, and
[Setup](SETUP.md) for step-by-step installation.

## Cloud inference (hybrid)

The CLI is a plain Node.js script — it can run anywhere that reaches both Ollama
and the MCP server. Run the model on a cloud GPU, the CLI on your laptop, and
the tools on your LAN:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Cloud GPU VPS   │◄───►│ Your MacBook    │◄───►│ Raspberry Pi    │
│ (RunPod/Lambda) │     │ (macOS)         │     │ (Kali Linux)    │
│ - Ollama        │     │ - mshin CLI     │     │ - MCP Server    │
│ - gpt-oss-120b  │     │ - MCP client    │     │ - Kali tools    │
│ - Inference     │     │                 │     │ - nmap, nikto   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

The CLI sends prompts to Ollama on the VPS and tool calls to the MCP server on
your Pi. Offensive traffic originates from your LAN, not the cloud provider —
see [Cloud vs. Local](CYBERSECURITY-AGENT-ROADMAP.md#cloud-vs-local-deployment-options)
for provider guidance and sizing.

## Mistral Vibe CLI + Docker Node (no Ollama)

You can drop the Core entirely. Run **[Mistral Vibe](https://docs.mistral.ai/vibe/code/overview)**
as the agent on your Mac — inference through your **Mistral Pro** subscription —
and let the Node run as the **Docker container** on the same Mac. Vibe is itself an MCP
client, so it replaces both Ollama and `mshin-cli`; the Node needs no new code
either — Vibe speaks the same Streamable HTTP MCP the CLI does:

```
┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐
│ Mistral Platform  │◄───►│ macOS Host        │◄───►│ Docker Container  │
│ (Mistral Pro)     │     │ Mistral Vibe CLI  │     │ mshin-node        │
│ - Inference       │     │ - Agent loop      │     │ - MCP Server      │
│ - No local model  │     │ - MCP client      │     │ - 19 Kali tools   │
└───────────────────┘     └───────────────────┘     └───────────────────┘
```

Set it up like this:

```bash
# 1. Node: build and start the sandboxed container (see Docker Local Dev
#    for the full guide). The token file is required — compose fails
#    closed without it. Use the helper so the Node and clients share one
#    token instead of copying hex by hand.
scripts/setup_mcp_auth.sh
docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d
```

```toml
# 2. Host: register the Node as an MCP server in ~/.vibe/config.toml
# On macOS Docker Desktop we use :3001 so a running Lima mshin-node guest
# does not silently steal localhost:3000.
[[mcp_servers]]
name = "mshin"
transport = "streamable-http"
url = "http://localhost:3001/mcp"

[mcp_servers.auth]
type = "static"
api_key_env = "MSHIN_NODE_TOKEN"
api_key_header = "Authorization"
api_key_format = "Bearer {token}"
```

Vibe loads `MSHIN_NODE_TOKEN` from `~/.vibe/.env`; `setup_mcp_auth.sh` writes
it there for you. Restart Vibe so it re-reads the file.

Then ask Vibe, e.g. *"Run an Nmap scan on 127.0.0.1 and analyze the results."*

Caveats worth knowing:

- **Not private and offline.** Prompts and tool results go to Mistral's cloud —
  this mode trades the privacy of the local setups for managed inference.
- The Node runs with dropped capabilities and a read-only rootfs, but its
  server-side guards (`assertSafe` in `servers/src/kali/tools.js`) still apply;
  Vibe does not load the Ollama persona from `configs/ollama-modelfile`.
- If you want the production shape instead (systemd, Debian host, bridged LAN
  access), the Node can still run in a [Lima guest](LIMA-LOCAL-DEV.md) —
  point the URL at the guest's IP instead of `localhost`. That path is now in
  maintenance mode and kept for one purpose: bridged LAN access, as the
  fallback of last resort when no Linux box is on your LAN.

## OpenCode CLI + local Ollama + Docker Node

You can also keep inference **local** and still drop `mshin-cli`. Run **[OpenCode](https://opencode.ai)**
as the agent — it is an MCP client like Vibe, but it talks to your **local Ollama** instead of a
cloud API, so this mode stays private and offline. The Node still needs no new code — OpenCode
speaks the same Streamable HTTP MCP the CLI does:

```
┌──────────────────────────────┐         ┌───────────────────┐
│ macOS Host                   │         │ Docker Container  │
│ - Ollama (local inference)   │ ◄─────► │ mshin-node        │
│ - OpenCode (agent + MCP      │         │ - MCP Server      │
│   client, runs Mistral Small)│         │ - 19 Kali tools   │
└──────────────────────────────┘         └───────────────────┘
```

Set it up like this:

```bash
# 1. Node: the same container as the Vibe mode above — skip this if it
#    is already running. Use the helper so the Node and clients share one token.
scripts/setup_mcp_auth.sh
docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d
```

```bash
# 2. Host: register the Node as a remote MCP server
# On macOS Docker Desktop we use :3001 so a running Lima mshin-node guest
# does not silently steal localhost:3000.
opencode mcp add mshin --global --url http://localhost:3001/mcp
```

The Node requires a bearer token. OpenCode treats remote servers as OAuth by
default, so disable OAuth and add the static bearer header in
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "mshin": {
        "type": "remote",
        "url": "http://localhost:3001/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer <MSHIN_NODE_TOKEN>"
        }
      }
    }
  }
}
```

Replace `<MSHIN_NODE_TOKEN>` with the value from `configs/mshin-node.env`.
OpenCode's documented `{env:...}` interpolation in remote MCP headers is
currently broken (anomalyco/opencode#23664), so the token must be literal in
this file. `setup_mcp_auth.sh` patches the header automatically when it
synchronizes tokens; it also keeps a copy in `~/.config/opencode/.env` for
diagnosis. Restart OpenCode's background service after the config changes:

```bash
opencode service restart
```

OpenCode auto-discovers Ollama on `localhost:11434`, so any local model shows up as
`ollama/<tag>`. Declaring the provider explicitly (as in
[ollama-opencode-setup](https://github.com/imagewize/ollama-opencode-setup), with
`@ai-sdk/openai-compatible` pointed at `http://localhost:11434/v1`) gives you control
over which model variants are offered. Then run it, e.g.:

```bash
opencode run -m ollama/<MODEL_TAG> "Run an Nmap scan on 127.0.0.1 and analyze the results."
```

Caveats worth knowing — these come from a live run of this mode (opencode
v2.0.32, `ministral-3:8b-32k`, all 19 tools connected) and apply wherever the
Node runs — container, Lima guest, or physical:

- **Private and offline**, like the two-machine setup — but one host must fit both the
  model and the agent.
- Use a **tool-calling model** with roomy context. OpenCode asks for 64k+ context; bake
  `num_ctx` (and `temperature 0`) into a model variant, e.g. `ollama create` from a
  Modelfile, as `configs/ollama-modelfile` does for the Core. Small-context defaults
  drop the tool schemas and the model fabricates results.
- **The Machin Shin persona does not survive this mode.** A Modelfile's `SYSTEM` line
  applies only when the request carries no system message — and OpenCode always sends
  its own, which replaces it (verified against `mshin:latest`: driven with a neutral
  system prompt, the model answered as that prompt's assistant, not Machin Shin). What
  a baked variant still contributes is the sampling and context settings. To run the
  persona here, recreate it as an OpenCode custom agent's system prompt.
- Small local models often will not emit a direct call to a namespaced MCP tool
  (`tools.mshin.whois`). The reliable path is OpenCode's **execute tool**, where the
  model calls `await tools.mshin.whois({ target: '...' })` in code — a prompt that says
  "run this in the execute tool and report the raw output" produced real Node data,
  while an open-ended "run whois" produced fabricated answers.
- OpenCode keeps a background service. If a remote MCP server sticks in a failed state
  after the Node's address changes or a sleep/wake cycle, `opencode service restart`
  reconnects it.
- The Node's server-side guards (`assertSafe` in `servers/src/kali/tools.js`) still apply.
- The `--auto` flag auto-approves tool calls; omit it to approve each Kali tool run by hand.

### Scanning your LAN from a Docker Node

A Docker Desktop container on macOS (or Windows) is behind a NAT and cannot
do truthful host discovery: `nmap -sn` of your LAN returns every address as
"up" because Docker's VM answers the probes. The Node refuses to return that
fabricated list. This is not a Machin Shin bug — it is how Docker Desktop's
virtualised networking works on macOS and Windows.

The best vantage point for LAN discovery is the **host itself**. Use the
cross-platform helper to find live hosts, then scan those specific hosts
through the Node:

```bash
# macOS, Windows or Linux — runs on the host, not inside the container
scripts/lan_inventory.py

# Then ask Vibe/OpenCode: "Run an nmap -sV scan on targets <IP1> <IP2> ..."
```

`--json` gives machine-readable output; `--targets` prints a ready-to-use JSON
array. For the full explanation, see [Docker Local Dev](DOCKER-LOCAL-DEV.md).

> **Why not a full "macOS host Node"?** The MCP server is built around Linux
> paths and the Kali toolset (`/usr/bin/nmap`, `/usr/sbin/arp-scan`, etc.), so
> running it natively on macOS would require porting every tool path and
> dependency. Discovery is the one task the Mac does better than the container,
> which is why `lan_inventory.py` runs on the host and feeds targets to the
> Node. Vibe and OpenCode can also run `brew`-installed tools directly on the
> Mac — no Node in the loop — for discovery and light LAN scans; see
> [Host-direct tool use](DOCKER-LOCAL-DEV.md#host-direct-tool-use-vibe-or-opencode-with-tools-on-the-mac).

See [Docker Local Dev](DOCKER-LOCAL-DEV.md) for the Node container's
requirements and troubleshooting, and [Lima Local Dev](LIMA-LOCAL-DEV.md)
for the maintenance-mode Lima path and its one remaining live use, the
bridged LAN guest.

## When to use the full two-machine setup instead

- Production engagements, and anything needing truthful LAN/ARP discovery —
  a dedicated Linux Node on the segment sees what a NAT'd container cannot.
- You already own a 32GB+ box and want everything local and offline.
- The target LAN is not where your Mac sits.

## Troubleshooting

- Container build/start/health/token issues: [Docker Local Dev](DOCKER-LOCAL-DEV.md#troubleshooting).
- Bare-metal systemd/sudoers issues: [Setup](SETUP.md).
- Client connection issues (Vibe/OpenCode token, OAuth): [Docker Local Dev](DOCKER-LOCAL-DEV.md#usage).
- Fabricated LAN discovery through Docker: [Docker Local Dev](DOCKER-LOCAL-DEV.md#where-to-scan-from-three-truthful-positions).

## Changelog

- **2026-11-09** — Created; the cloud-hybrid, Vibe+Docker, OpenCode+Docker and
  LAN-discovery subsections moved here from `README.md`'s Architecture section
  (content moved, not rewritten).
