<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Machin Shin logo" width="120" height="120">
  </picture>
</p>

<div align="center">
<h1>Machin Shin</h1>
</div>

> *"In the black corridors of the Ways, nothing moves that Machin Shin does not find. It hunts the dark without rest and lets nothing hide from it. So too does this system range the dark corners of your network, and bring back what waits there."*

**Machin Shin** is a **Wheel of Time-inspired cybersecurity AI system** that combines a **local LLM** (Mistral Small 3 by default, larger models if your hardware allows) with **Kali Linux tools** via **Model Context Protocol (MCP)**. It enables **real-time, AI-augmented penetration testing, threat analysis, and incident response**—all while keeping your data **private and offline**.

## Authorized use only

Machin Shin orchestrates offensive-security tools. **Use it only against systems you own or have explicit written authorization to test.** Unauthorized scanning, exploitation, or data access is illegal in most jurisdictions and violates the terms of service of most networks. The maintainers assume no liability for misuse.

---

## Features

- **Private & Offline**: No cloud dependencies—your data stays yours.
- **Real-Time Tool Access**: LLM directly executes Kali Linux tools (Nmap, Metasploit, etc.) via MCP.
- **Structured Tool Results**: nmap scans return parsed JSON (`structuredContent`: hosts, ports, services, versions) alongside the raw text, and MCP clients carry an explicit request timeout (`MSHIN_MCP_TIMEOUT_MS`, default 960s) so long scans like `nmap -p-` no longer die at the SDK's 60s default.
- **Scalable Architecture**: Two-machine setup for optimal performance.
- **Wheel of Time Themed**: Named for the Black Wind of the Ways—the relentless hunter that finds what hides in the dark.

---

## Architecture

```
┌──────────────────────┐          ┌─────────────────────┐
│ Machin Shin Core     │          │ Kali Node (mini PC) │
│ (32GB+ RAM, any box) │          │ (Kali Linux + MCP)  │
│ - Ollama + CLI       │ <──────> │ - Machin Shin Node  │
│ - Runs Mistral Small │          │ - Runs Kali tools   │
│   24B (or larger)    │          │ - MCP Server        │
└──────────────────────┘          └─────────────────────┘
```


| Component           | Role                    | Hardware                                              |
| ------------------- | ----------------------- | ----------------------------------------------------- |
| **Machin Shin Core** | LLM Inference Server    | Any Linux/macOS box with 32GB+ RAM — start with one you own |
| **Machin Shin Node** | Kali Linux + MCP Server | Any x86_64 mini PC / SFF ($150–350)                   |

The Core is deliberately undemanding: 32GB runs the default 24B model and everything
in this repo today. Bigger boxes buy *bigger models*, not more speed — see
[Sizing the Core](docs/ARCHITECTURE.md#sizing-the-core) before spending anything.

### Cloud inference (hybrid)

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
see [Cloud vs. Local](docs/CYBERSECURITY-AGENT-ROADMAP.md#cloud-vs-local-deployment-options)
for provider guidance and sizing.

### Mistral Vibe CLI + Docker Node (no Ollama)

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
  access), the Node can still run in a [Lima guest](docs/LIMA-LOCAL-DEV.md) —
  point the URL at the guest's IP instead of `localhost`. That path is now in
  maintenance mode and kept for one purpose: bridged LAN access, as the
  fallback of last resort when no Linux box is on your LAN.

### OpenCode CLI + local Ollama + Docker Node

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

#### Scanning your LAN from a Docker Node

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
array. For the full explanation, see [Docker Local Dev](docs/DOCKER-LOCAL-DEV.md).

> **Why not a full "macOS host Node"?** The MCP server is built around Linux
> paths and the Kali toolset (`/usr/bin/nmap`, `/usr/sbin/arp-scan`, etc.), so
> running it natively on macOS would require porting every tool path and
> dependency. Discovery is the one task the Mac does better than the container,
> which is why `lan_inventory.py` runs on the host and feeds targets to the
> Node. Vibe and OpenCode can also run `brew`-installed tools directly on the
> Mac — no Node in the loop — for discovery and light LAN scans; see
> [Host-direct tool use](docs/DOCKER-LOCAL-DEV.md#host-direct-tool-use-vibe-or-opencode-with-tools-on-the-mac).

See [Docker Local Dev](docs/DOCKER-LOCAL-DEV.md) for the Node container's
requirements and troubleshooting, and [Lima Local Dev](docs/LIMA-LOCAL-DEV.md)
for the maintenance-mode Lima path and its one remaining live use, the
bridged LAN guest.

---

## Quick Start

### Prerequisites

- **Machin Shin Core**: any Linux or macOS machine with **32GB+ RAM** (an existing desktop or Mac is fine)
- **Machin Shin Node**: Any x86_64 mini PC or SFF running Kali Linux
- **Network**: Both devices on the same LAN

### Setup

1. **Set up Machin Shin Node (Kali + MCP):**
  ```bash
   # Follow the guide in docs/SETUP.md
  ```
2. **Set up Machin Shin Core (LLM Inference):**
  ```bash
   # Follow the guide in docs/SETUP.md
  ```
3. **Connect and Test:**
  ```bash
   # On Machin Shin Core, run:
   mshin <MSHIN_NODE_IP>
  ```
4. **Try a Command:**
  ```
   "Machin Shin, run an Nmap scan on 192.168.1.1 and analyze the results."
  ```
5. **One tool, no model:** call the Node directly with `mshin-call`:
  ```bash
   mshin-call --node http://<MSHIN_NODE_IP>:3000 nmap '{"target":"127.0.0.1","flags":["-sV"]}'
   # See clients/mshin-cli/README.md
  ```

---

## Documentation

- [Master Guide](KALI-OPENLLM.md) – Complete single-file walkthrough (most comprehensive)
- [Architecture](docs/ARCHITECTURE.md) – System design and components
- [Setup Guide](docs/SETUP.md) – Step-by-step installation
- [Workflows](docs/WORKFLOWS.md) – Example cybersecurity tasks
- [Docker Local Dev](docs/DOCKER-LOCAL-DEV.md) – Node in a Docker container; the default local path on macOS, with the Lima-vs-Docker measurements, the three-positions table, and host-direct tool use from Vibe/OpenCode
- [Lima Local Dev](docs/LIMA-LOCAL-DEV.md) – Maintenance-mode Lima setup on macOS; its one live use is the bridged guest for ARP LAN discovery — Lima templates: [`lima/mshin-node.yaml`](lima/mshin-node.yaml), [`lima/mshin-core.yaml`](lima/mshin-core.yaml)
- [Developer Onboarding](docs/DEVELOPER-ONBOARDING.md) – Learning path and architecture for new contributors
- [Refactoring Ideas](docs/REFACTORING-IDEAS.md) – Cleanups worth doing, and the ones deliberately avoided
- [Agent Roadmap](docs/CYBERSECURITY-AGENT-ROADMAP.md) – Where the agent loop is headed
- [Agent-Loop Investigations](docs/AGENT-LOOP-INVESTIGATIONS.md) – Defects found by running the evaluation harness, and what is still open
- [Agent Performance](docs/AGENT-PERFORMANCE.md) – Making mshin-cli faster: streaming, parallel tools, caching, and a richer system prompt
- [Eval Run 2026-10-20](docs/EVAL-RUN-2026-10-20.md) – First model-comparison measurements: 7–8B pass, 4B fabricates, 32B unrunnable on 16GB
- [Eval Run 2026-10-21](docs/EVAL-RUN-2026-10-21.md) – The same suite against the sandboxed Docker Node: 8B tier unchanged, sandbox is a drop-in Node
- [Concurrent MCP Calls Benchmark 2026-11-09](docs/EVAL-RUN-2026-11-09-CONCURRENT-MCP-CALLS.md) – Raw measurement: the Node executes concurrent `tools/call` in parallel, across sessions and within one session
- [Raspberry Pi Node](docs/RASPBERRY-PI-NODE.md) – Running the Node on a Raspberry Pi
- [VPS Node](docs/VPS-NODE.md) – Running the Node on a VPS: faithful for internet targets, blind to your home LAN (Layer-2 truth)
- [Mac Mini M4 Pro Core](docs/MAC-MINI-M4-CORE.md) – Running Core on Mac Mini M4 Pro 24GB with Raspberry Pi Node
- [Agent Guidelines](AGENTS.md) – Rules for AI agents contributing to this repo
- [Security Policy](SECURITY.md) – How to report a vulnerability privately
- [Vibe project config](.vibe/config.toml) – Loads the shared `/code-review` skill from the [mistral-agents](https://github.com/imagewize/mistral-agents) repo

---

## Wheel of Time Inspiration

**Machin Shin**—the Black Wind—is the terror that haunts the Ways in the *Wheel of Time* series:

- **Relentless**: It ranges the black corridors of the Ways without rest, and nothing that enters escapes its notice
- **Blind to Nothing in the Dark**: It knows every twist of the unlit paths—much as this system ranges the dark corners of a network and surfaces what hides there
- **Beyond the Leaf-Key**: The trefoil leaf of Avendesora is the very shape of the keys that open the Waygates—and beyond those thresholds waits the Wind this project takes for its name and its mark

> *"Nothing hides from the Black Wind in the dark of the Ways. So too does Machin Shin range the dark of your networks, and let nothing hide from you."*

---

## Contributing

Contributions are welcome! Please read our [Contribution Guidelines](CONTRIBUTING.md).

Release history is tracked in the [Changelog](CHANGELOG.md).

---

## License

This project is licensed under the **MIT License** – see the [LICENSE](LICENSE) file for details.

The project logo uses the *wind* icon from [Feather Icons](https://feathericons.com/) by Cole Bemis, licensed under the [MIT License](https://github.com/feathericons/feather/blob/master/LICENSE).

This is an unofficial, non-commercial fan project. *The Wheel of Time*, "Machin Shin," and all related names and lore are the property of the Bandersnatch Group, Inc. This project is not affiliated with, endorsed by, or sponsored by the rights-holders.

---

## Acknowledgments

- Inspired by the *Wheel of Time* series by Robert Jordan
- Built with [Ollama](https://ollama.com), [MCP](https://github.com/modelcontextprotocol), and [Kali Linux](https://www.kali.org/)
- Powered by [Mistral AI](https://mistral.ai/)

---

*"The Wheel weaves as the Wheel wills. With Machin Shin, you weave with it."*