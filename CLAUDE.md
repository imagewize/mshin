# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Avendesora is a self-hosted, Wheel of Time-themed cybersecurity AI system. It pairs a local LLM (Ollama) with Kali Linux security tools over the Model Context Protocol (MCP). The repo contains:

- Markdown guides (`docs/`, `KALI-OPENLLM.md`).
- Bash provisioning scripts (`scripts/`).
- Linux config files (`configs/`).
- A runnable **custom Kali MCP server** (`servers/src/kali`).
- A runnable **Ollama + MCP CLI client** (`clients/avendesora-cli`).

Everything is meant to be deployed onto two separate Linux machines. The macOS working directory is for authoring only.

## The two-machine architecture

Everything here describes splitting LLM inference from security-tool execution across two LAN-connected hosts:

- **Avendesora Core** — runs **Ollama** (Mistral Small 3 / Llama 3.3 70B) for inference plus the **Avendesora CLI client**. Provisioned by `scripts/setup_ollama.sh`. The script installs a wrapper at `/usr/local/bin/avendesora` that launches `/opt/avendesora/clients/avendesora-cli/index.js` pointed at the Node's IP. Ollama (not raw llama.cpp) is a deliberate choice — Ollama runs on llama.cpp anyway, and the Modelfile/daemon/model-management ergonomics matter more here than the marginal wrapper overhead. The full rationale lives in `docs/architecture.md` ("Why Ollama (and not raw llama.cpp)?").
- **Avendesora Node** — runs **Kali Linux** and the **custom Kali MCP server** (`servers/src/kali`) exposing tools (`nmap`, `metasploit`, `searchsploit`, `nikto`, `whois`, `tshark`) on port **3000**. Provisioned by `scripts/setup_mcp_server.sh`, kept alive by the `avendesora-node` systemd service (`configs/mcp-kali.service`).

Data flow: `User prompt → Core (LLM) → Avendesora CLI → MCP client → MCP server (Node, :3000) → Kali tool → result back up the chain`. The LLM's persona and tool list are defined in `configs/ollama-modelfile` (an Ollama Modelfile: `ollama create avendesora -f <file>`).

When changing the tool set, five places must stay in sync:
1. The `--tools` flag in `scripts/setup_mcp_server.sh` (and the apt package list there).
2. The same flag in `configs/mcp-kali.service`.
3. The `sudoers` allowlist for the `avendesora` user in the setup script.
4. The tool list in `servers/src/kali/tools.js` (and any tool metadata there).
5. The Modelfile's documented tool list in `configs/ollama-modelfile`.

The sudoers entry is the easiest to miss: `servers/src/kali/tools.js` runs each binary as `sudo -n` whenever the process is not root, so a tool absent from the allowlist fails at call time, not at startup.

`AGENTS.md` carries the working rules for AI agents (how to verify changes, git and shell conventions, communication style). This file stays the source of truth for repo facts; where the two disagree, this file wins.

## Where things live

The layout matches what `README.md` and `CONTRIBUTING.md` describe:

- `docs/` holds the split guides: `architecture.md`, `setup.md`, `workflows.md`, `cybersecurity-agent-roadmap.md`, `lima-local-dev.md`.
- `scripts/` holds both provisioning scripts: `setup_mcp_server.sh` (Node) and `setup_ollama.sh` (Core).
- `configs/` holds `mcp-kali.service` (systemd unit) and `ollama-modelfile` (Ollama Modelfile).
- `lima/` holds the two Lima templates for the macOS local-dev path: `avendesora-kali.yaml` (Node guest) and `avendesora-core.yaml` (Core guest). They provision the same things the scripts do, scoped to what Debian/Ubuntu cloud images can install — no metasploit or searchsploit, and the persona built on a 7B model rather than the Modelfile's `mistral-small`.
- `servers/src/kali/` holds the custom Kali MCP server (`index.js`, `tools.js`, `package.json`).
- `clients/avendesora-cli/` holds the Ollama + MCP CLI harness (`index.js`, `package.json`).
- `KALI-OPENLLM.md` at the repo root is the most complete single-file master guide, superseding the split docs.

If you add or move files, keep `README.md`'s Documentation links and `CONTRIBUTING.md`'s "Project Structure" section in sync.

## Conventions

- Shell/Python: 4-space indent. YAML/JSON: 2-space indent (per `CONTRIBUTING.md`).
- All instructions assume Linux targets (Kali on the Node, Ubuntu/Debian on the Core). Commands here are not meant to run on the macOS working host — they are authored for deployment.
- Heavy Wheel of Time theming (epigraphs, ASCII tree logo in `assets/logo.txt`) is intentional house style; preserve the tone when editing docs.
- Default network assumptions in examples: Node `192.168.1.100`, Core `192.168.1.200`, gateway `192.168.1.1`, MCP on `:3000`.
