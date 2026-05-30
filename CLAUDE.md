# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Avendesora is **documentation and deployment configuration** for a self-hosted, Wheel of Time-themed cybersecurity AI system — *not* a runnable application. There is no source tree to build, no package manifest, and no test suite. The deliverables are Markdown guides, Bash provisioning scripts, and Linux config files (systemd unit, Ollama Modelfile) that are meant to be deployed onto two separate Linux machines. The primary working directory is itself not a git repository.

## The two-machine architecture

Everything here describes splitting LLM inference from security-tool execution across two LAN-connected hosts:

- **Avendesora Core** — runs **Ollama** (Mistral 13B/70B) for inference plus the **MCP client**. Provisioned by `scripts/setup_ollama.sh`. The script installs a wrapper at `/usr/local/bin/avendesora` that launches `mcp-client` pointed at the Node's IP.
- **Avendesora Node** — runs **Kali Linux** and an **MCP server** (from `github.com/modelcontextprotocol/servers`, `src/kali`) exposing tools (`nmap`, `metasploit`, `searchsploit`, `nikto`, `whois`, `tshark`) on port **3000**. Provisioned by `scripts/setup_mcp_server.sh`, kept alive by the `avendesora-node` systemd service (`configs/mcp-kali.service`).

Data flow: `User prompt → Core (LLM) → MCP client → MCP server (Node, :3000) → Kali tool → result back up the chain`. The LLM's persona and tool list are defined in `configs/ollama-modelfile` (an Ollama Modelfile: `ollama create avendesora -f <file>`).

When changing the tool set, three places must stay in sync: the `--tools` flag in `scripts/setup_mcp_server.sh`, the same flag in `configs/mcp-kali.service`, *and* the `sudoers` allowlist for the `avendesora` user in the setup script. The Modelfile's documented tool list should match too.

## Where things live

The layout matches what `README.md` and `CONTRIBUTING.md` describe:

- `docs/` holds the split guides: `architecture.md`, `setup.md`, `workflows.md`.
- `scripts/` holds both provisioning scripts: `setup_mcp_server.sh` (Node) and `setup_ollama.sh` (Core).
- `configs/` holds `mcp-kali.service` (systemd unit) and `ollama-modelfile` (Ollama Modelfile).
- `KALI-OPENLLM.md` at the repo root is the most complete single-file master guide, superseding the split docs.

If you add or move files, keep `README.md`'s Documentation links and `CONTRIBUTING.md`'s "Project Structure" section in sync.

## Important: the Bash scripts are currently not executable as-is

`scripts/setup_mcp_server.sh` and `scripts/setup_ollama.sh` have lost their formatting in two systematic ways — fix these before treating any script as runnable:

1. **Comment lines lost their `#` prefix** — section headers like `--- Install Dependencies ---` and descriptions like `Avendesora Node Setup Script` are bare text that the shell will try to execute.
2. **Multi-line commands lost their `\` continuations** — e.g. `apt-get install -y` followed by package names on separate unindented lines, and `mcp-client` / `cat <<EOF` blocks. These need line continuations or to be joined onto one line.

The intended commands are correct; only the comment markers and continuations are missing. The same corruption affects the embedded heredocs (the wrapper script in `setup_ollama.sh`).

## Conventions

- Shell/Python: 4-space indent. YAML/JSON: 2-space indent (per `CONTRIBUTING.md`).
- All instructions assume Linux targets (Kali on the Node, Ubuntu/Debian on the Core). Commands here are not meant to run on the macOS working host — they are authored for deployment.
- Heavy Wheel of Time theming (epigraphs, ASCII tree logo in `assets/logo.txt`) is intentional house style; preserve the tone when editing docs.
- Default network assumptions in examples: Node `192.168.1.100`, Core `192.168.1.200`, gateway `192.168.1.1`, MCP on `:3000`.
