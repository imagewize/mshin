# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Machin Shin is a self-hosted, Wheel of Time-themed cybersecurity AI system. It pairs a local LLM (Ollama) with Kali Linux security tools over the Model Context Protocol (MCP). The repo contains:

- Markdown guides (`docs/`, `KALI-OPENLLM.md`).
- Bash provisioning scripts (`scripts/`).
- Linux config files (`configs/`).
- A runnable **custom Kali MCP server** (`servers/src/kali`).
- A runnable **Ollama + MCP CLI client** (`clients/mshin-cli`).

Everything is meant to be deployed onto two separate Linux machines. The macOS working directory is for authoring only.

## The two-machine architecture

Everything here describes splitting LLM inference from security-tool execution across two LAN-connected hosts:

- **Machin Shin Core** — runs **Ollama** (Mistral Small 3 / Llama 3.3 70B) for inference plus the **Machin Shin CLI client**. Provisioned by `scripts/setup_ollama.sh`. The script installs a wrapper at `/usr/local/bin/mshin` that launches `/opt/mshin/clients/mshin-cli/index.js` pointed at the Node's IP. Ollama (not raw llama.cpp) is a deliberate choice — Ollama runs on llama.cpp anyway, and the Modelfile/daemon/model-management ergonomics matter more here than the marginal wrapper overhead. The full rationale lives in `docs/ARCHITECTURE.md` ("Why Ollama (and not raw llama.cpp)?").
- **Machin Shin Node** — runs **Kali Linux** and the **custom Kali MCP server** (`servers/src/kali`) exposing tools (`nmap`, `metasploit`, `searchsploit`, `nikto`, `whois`, `tshark`) on port **3000**. Provisioned by `scripts/setup_mcp_server.sh`, kept alive by the `mshin-node` systemd service (`configs/mcp-kali.service`).

Data flow: `User prompt → Core (LLM) → Machin Shin CLI → MCP client → MCP server (Node, :3000) → Kali tool → result back up the chain`. The LLM's persona is defined in `configs/ollama-modelfile` (an Ollama Modelfile: `ollama create mshin -f <file>`); the tool list reaches the model at runtime as the MCP `tools` array the CLI passes to Ollama, **not** from the Modelfile.

When changing the tool set, four places must stay in sync:
1. The `--tools` flag in `scripts/setup_mcp_server.sh` (and the apt package list there).
2. The same flag in `configs/mcp-kali.service`.
3. The `sudoers` allowlist for the `mshin` user in the setup script.
4. The tool list in `servers/src/kali/tools.js` (and any tool metadata there).

Under the Docker deployment (`configs/Dockerfile`), the apt list and the sudoers allowlist both collapse into the image's `KALI_TOOLS` build arg — the container runs tools as root inside the jail and needs no sudo — and the `--tools` list appears once more in the Dockerfile's `CMD`.

`configs/ollama-modelfile` is deliberately **not** on that list: its system prompt must not enumerate the tools. A hand-written tool list with shell-command examples trains smaller models to emit tool calls as text instead of native `tool_calls`, which breaks the agent loop (verified on a Lima Core guest — see `CHANGELOG.md`).

The sudoers entry is the easiest to miss: `servers/src/kali/tools.js` runs each binary as `sudo -n` whenever the process is not root, so a tool absent from the allowlist fails at call time, not at startup.

`AGENTS.md` carries the working rules for AI agents (how to verify changes, git and shell conventions, communication style). This file stays the source of truth for repo facts; where the two disagree, this file wins.

## Where things live

The layout matches what `README.md` and `CONTRIBUTING.md` describe:

- `docs/` holds the split guides: `ARCHITECTURE.md`, `SETUP.md`, `WORKFLOWS.md`, `CYBERSECURITY-AGENT-ROADMAP.md`, `DOCKER-LOCAL-DEV.md` (the default local path), `LIMA-LOCAL-DEV.md` (production-shape emulation), `VPS-NODE.md` (the cloud Node and its Layer-2 limits).
- `scripts/` holds the provisioning and host-side helper scripts: `setup_mcp_server.sh` (Node), `setup_ollama.sh` (Core), `probe_mcp_server.sh` (Node health/tool probe), `setup_mcp_auth.sh` (one-shot token sync for Docker/Vibe/OpenCode), `lan_inventory.py` (cross-platform LAN inventory), `lan_inventory.sh` (legacy macOS LAN inventory), `setup_bridged_node.sh` (bridged Lima Node).
- `configs/` holds `mcp-kali.service` (systemd unit), `ollama-modelfile` (Ollama Modelfile), and the Dockerized Node: `Dockerfile` (Kali + all tools, no sudo), `compose.yaml` (production shape: host networking, dropped capabilities, read-only rootfs), `compose.local.yaml` (macOS override: bridge network, published :3000).
- `lima/` holds the two Lima templates for the macOS local-dev path: `mshin-node.yaml` (Node guest) and `mshin-core.yaml` (Core guest). The Node guest is named **mshin-node**, not mshin-kali: it is Debian, not Kali Linux, so it is named for its architectural role (pairing with mshin-core) rather than the OS (the production Node still runs real Kali). It now provisions the full six-tool set — nmap, whois, tshark and nikto from Debian, metasploit and searchsploit from their upstream vendors (Rapid7's apt repo and exploit-db's git repo, not Kali's repo). The persona is built on a 7B model rather than the Modelfile's `mistral-small`.
- `servers/src/kali/` holds the custom Kali MCP server (`index.js`, `tools.js`, `package.json`).
- `clients/mshin-cli/` holds the Ollama + MCP CLI harness (`index.js`, `agent.js`, `session-logger.js`, `eval-harness.js`, `package.json`).
- `KALI-OPENLLM.md` at the repo root is the most complete single-file master guide, superseding the split docs.

If you add or move files, keep `README.md`'s Documentation links and `CONTRIBUTING.md`'s "Project Structure" section in sync.

## Commits

- **One logical change per commit**, scoped to a file or a tight group of files
  that change for the same reason. `configs/mcp-kali.service` and
  `configs/ollama-modelfile` are separate commits even in the same session; the
  two `scripts/setup_*.sh` share one when the same bug touches both. Do not
  bundle a fix, a feature, and a docs pass into one commit.
- Order them so the history reads: fixes, then features, then the docs that
  describe them, then `CHANGELOG.md` last.
- Imperative mood, first line 50 characters or less, conventional prefix
  (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`). The body says what and why,
  and names the evidence when a claim was verified by running something.
- **Never credit an AI in a commit message, a PR description, or a code
  comment.** No `Co-Authored-By` trailer for Claude, Mistral, Vibe, Copilot or
  any other model or tool; no "generated by", "written with", or equivalent
  phrasing anywhere in the message. The commit is authored by the human whose
  name is on it. `AGENTS.md` states the same rule for agents.

## Conventions

- Shell/Python: 4-space indent. YAML/JSON: 2-space indent (per `CONTRIBUTING.md`).
- All instructions assume Linux targets (Kali on the Node, Ubuntu/Debian on the Core). Commands here are not meant to run on the macOS working host — they are authored for deployment.
- Heavy Wheel of Time theming (epigraphs, ASCII wind logo in `assets/logo.txt`) is intentional house style; preserve the tone when editing docs.
- Default network assumptions in examples: Node `192.168.1.100`, Core `192.168.1.200`, gateway `192.168.1.1`, MCP on `:3000`.
- The sandboxed Docker Node on Docker Desktop has **no truthful LAN position**: host discovery from inside the container is fabricated (Docker's NAT answers probes for every address, so `nmap -sn <LAN>/24` reports all 256 hosts "up"). The Node **refuses** such results rather than returning a fake host list. Discover LAN hosts from the host itself — `scripts/lan_inventory.py` works on macOS, Windows and Linux, or `scripts/lan_inventory.sh` on macOS — and use the Node only for targeted scans of hosts already known live. For Node-side ARP discovery on a Mac, the bridged Lima Node (`scripts/setup_bridged_node.sh`) is the only local path; a VPS Node never sees a LAN it is not physically on. The measurements live in `docs/DOCKER-LOCAL-DEV.md` (Troubleshooting); `AGENTS.md` ("Local LAN work on macOS") carries the working procedure.
