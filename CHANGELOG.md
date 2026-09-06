# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-09-06

Documentation release. Adds a single-machine Lima development path for macOS
and a working-rules file for AI agents, then corrects both. Every `limactl`
command in the new guide is verified against the installed `limactl` 2.2.0
rather than written from memory.

### Added

- **`docs/lima-local-dev.md`** — run Core and Node as two Lima VMs (or one
  all-in-one VM) on a Mac, as a learning and testing alternative to the
  two-machine setup. Covers the shared vmnet prerequisite, the MCP server
  under systemd, model choices that fit a guest, troubleshooting, and a
  validated custom Lima template. The two-machine setup remains the
  recommended path, and the guide says so.
- **`AGENTS.md`** — working rules for AI agents: read-before-edit, minimal
  change, evidence before claiming something works, git and shell
  conventions, and the repo invariants that break silently.

### Changed

- **`AGENTS.md` defers to `CLAUDE.md`.** The file duplicated `CLAUDE.md` and
  contradicted it on example IPs while omitting the repo's most important
  invariant. It now covers only *how to work*, leads with the tool-list sync
  rule, and separates infrastructure addresses (the fixed `192.168.1.x`
  convention) from scan targets (`127.0.0.1` or RFC 5737). Testing guidance
  is stated accurately: there is no suite, `npm test` is `node --check`.
- **The tool-list sync rule is five locations, not four.**
  `scripts/setup_mcp_server.sh` needs both the `--tools` flag *and* the apt
  package list, and `configs/ollama-modelfile` was a footnote. `CLAUDE.md`
  now also records why the `sudoers` allowlist is the one that gets missed:
  it fails at call time, not at startup.
- Sync the documentation cross-references that `CLAUDE.md` requires —
  `README.md`'s Documentation list and `CONTRIBUTING.md`'s Project Structure
  tree had drifted, missing `lima-local-dev.md`, `AGENTS.md`, and the agent
  roadmap. Replaced two `github.com/your-repo/avendesora` placeholders in
  `CONTRIBUTING.md` with the real remote.

### Fixed

Corrections to `docs/lima-local-dev.md`, in the order a reader would hit them:

- **`limactl create` flags.** `--os` and `--ip` do not exist, so every VM
  creation command in the guide failed at the flag parser. Templates are
  positional (`template:debian-13`); shared addressing is
  `--network=lima:shared`. `--memory` and `--disk` take plain GiB numbers —
  `--memory=8GiB` fails to parse.
- **VM-to-VM networking.** The guide claimed Lima creates a shared network
  automatically. It does not: the default is user-mode (SLIRP), every
  instance gets `192.168.5.15`, and instances cannot reach each other. The
  two-VM path now documents `socket_vmnet` and `limactl sudoers`, and reads
  the DHCP-assigned `192.168.105.0/24` addresses instead of asserting an
  invented `192.168.100.0/24`.
- **Lima guests run systemd**, not "containerd init" — containerd is a
  container runtime, not an init system. The guide now installs the
  `configs/mcp-kali.service` unit this repo already ships, instead of a
  `.bashrc` + `nohup` hack the wrong premise had justified.
- **Missing `sudoers` allowlist.** `servers/src/kali/tools.js` runs every
  binary as `sudo -n` when the process is not root, so without a `NOPASSWD`
  entry *every* tool call fails with `sudo: a password is required`. Both
  setup paths now install one, scoped to the tools available on the base.
- **Unavailable packages.** `searchsploit` ships in the `exploitdb` package
  and `metasploit-framework` is a Kali-repo package; neither installs on the
  Debian base, and grafting Kali's repo onto Debian is unsupported. Both are
  left out of the guide's `--tools` list, with a pointer to the real Kali
  Node. (Same class of error as the 0.1.0 provisioning fix.)
- **`ollama run avendesora` was presented as a smoke test.** Ollama is not
  an MCP client and reads no Node URL from the environment, so that session
  never executes a tool — it only describes one. Replaced with a `/health`
  check plus an explanation.
- **Custom Lima template.** Used `~/.lima/` as a template directory (it holds
  instances), a `--template=` flag that does not take a bare name, and a
  `network:` block with invented `gateway`/`cidr` keys. It now inherits
  `template:_images/debian-13` rather than hardcoding a cloud image URL, uses
  `networks:` (plural), and passes `limactl template validate`.
- **ASCII architecture diagram.** Line widths ran 62 to 68 characters, so no
  two box edges lined up, and one closing fragment matched nothing. Realigned
  to a uniform 66 columns. The SSE link also ran from the Ollama box; it now
  runs from the Avendesora CLI, which is the actual MCP client.
- Miscellaneous: wrong clone URL (`jasperfrumau` → `imagewize`, in three
  places, two of which also needed `sudo` to write under `/opt`), `lima
  --version` (that runs a command *inside* a guest; the CLI is `limactl`),
  the nonexistent `ministral-3:8b` tag, `qwen2:7b` → `qwen2.5:7b`, and
  "Mistral 8B / ~5GB" where the guide elsewhere correctly said 7B / ~4GB.

> **Status:** command syntax is verified against `limactl` 2.2.0 and
> `ollama` 0.33.2, and the custom template passes `limactl template
> validate`. No VM was booted and `socket_vmnet` was not installed end to
> end, so the full runtime path remains unvalidated.

## [0.2.0] - 2026-09-05

Agent-harness release. Introduces the first `observe-decide-act` loop in the
CLI client, persistent session memory, an approval gate for destructive tools,
and context compaction for long-running security workflows. Also includes the
README lead-in fix that was pending in `Unreleased`.

### Added

- **`clients/avendesora-cli/agent.js`** — a new `Agent` class that implements
  the ReAct-style loop described in `docs/cybersecurity-agent-roadmap.md`:
  one tool decision per turn, native Ollama tool-calling, a hard step budget,
  and structured callbacks for UI updates.
- **Persistent session memory** (`AgentMemory`) stored as JSON under
  `~/.avendesora/memory.json`. Keeps a running transcript of each session so
  the agent can refer back to previous tool results without relying solely on
  the LLM context window. Swappable for SQLite/Redis if multi-user support is
  needed later.
- **Active-tool approval gate**. Destructive tools such as `metasploit` now
  require explicit user confirmation before each invocation. Passive
  reconnaissance tools run automatically.
- **Context compaction** to keep long tool-output streams within a token
  budget. Oldest non-essential messages are dropped while preserving the
  system prompt and the original user goal.

### Changed

- Refactored `clients/avendesora-cli/index.js` to delegate the LLM/MCP loop
  to the new `Agent` class. The CLI now prints tool-call previews and
  approval prompts instead of handling the loop inline.
- Expanded the CLI test script to syntax-check both `index.js` and
  `agent.js`.

### Fixed

- README's opening line still led with `Mistral Small 3 / Llama 3.3 70B`, a
  leftover from the pre-0.1.1 framing in which the 70B was the headline model.
  It now reads "Mistral Small 3 by default, larger models if your hardware
  allows", matching the sizing guidance in `docs/architecture.md`.
- Shellcheck warnings in provisioning scripts:
  - `read -p` without `-r` in `scripts/setup_mcp_server.sh` and
    `scripts/setup_ollama.sh` could mangle backslashes in user input.
  - Removed unused `DEFAULT_NODE_IP` from `scripts/setup_ollama.sh`.

## [0.1.1] - 2026-09-05

Documentation-only release. Reframes the hardware guidance so Avendesora is
documented as something you start on hardware you already own, with the 128GB
unified-memory box as an optional upgrade tier rather than a prerequisite.

### Changed

- **Reframe the hardware guidance around starting small.** The docs presented
  the GMKtec EVO-X3 (128GB) as *the* Avendesora Core; it is now documented as
  an optional upgrade tier, with "a 32GB machine you already own" as the
  default starting point across `README.md`, `KALI-OPENLLM.md`,
  `CONTRIBUTING.md`, `docs/setup.md`, and the roadmap's deployment options
  (new Option A: existing hardware; the APU build becomes Option A′).
- **Add a "Sizing the Core" section** to `docs/architecture.md` explaining
  that Core RAM buys model *capacity*, not throughput, with weight and
  KV-cache budgets per model and a three-tier hardware ladder. Documents why
  the 128GB pool pays off on MoE models (`gpt-oss-120b`, ~5B active params)
  rather than on a bandwidth-starved dense 70B.
- De-brand the ASCII architecture diagrams so the Core is described by its
  requirements rather than by one specific product.

### Fixed

- **Correct the inference throughput claims.** `docs/architecture.md` and
  `KALI-OPENLLM.md` claimed 10–20 tok/s for a Q4 Llama 3.3 70B on the EVO-X3.
  A ~40GB dense model on a ~256 GB/s memory bus has an arithmetic ceiling near
  6 tok/s. The performance table now derives ceilings from bandwidth ÷
  bytes-per-token, separates inference from tool-execution latency, and is
  explicitly labelled as unmeasured on Avendesora hardware.
- Correct the Wheel of Time lore in the README, master guide, and Ollama
  modelfile: Avendesora was not "unbroken"/"unbreakable" through the Breaking
  of the World — it is the only chora tree to survive, preserved as a cutting
  the Aiel carried to safety and replanted in Rhuidean. Also replaced the
  inaccurate "source of ter'angreal" line (its trefoil leaf is the shape of
  the Waygate key).
- Replace the garbled block-letter banner in `KALI-OPENLLM.md` with the
  canonical tree logo from `assets/logo.txt`.

## [0.1.0] - 2026-09-05

First tagged release. Avendesora is a self-hosted, Wheel of Time-themed
cybersecurity AI system that pairs a local LLM (Ollama) with Kali Linux
tools over the Model Context Protocol (MCP), split across two LAN-connected
hosts (Core for inference, Node for tool execution).

> **Status:** the components build, `node --check` passes, and the MCP
> server responds to `GET /health`. End-to-end tool execution still needs
> validation on real Kali / Core hardware.

### Added

- **Custom Kali MCP server** (`servers/src/kali/`) built on the official MCP
  SDK with an SSE transport on port `3000`, exposing `nmap`, `metasploit`,
  `searchsploit`, `nikto`, `whois`, and `tshark`. Each client connection gets
  its own server instance and session-keyed transport, with cleanup on
  disconnect. Arguments run through `execFile` (no shell) with validation
  against shell metacharacters and null bytes.
- **Avendesora CLI client** (`clients/avendesora-cli/`) driving Ollama native
  tool-calling against the Node over MCP, with a `GET /health` reachability
  check and a `--node` / `--ollama` / `--model` interface.
- **Provisioning scripts** for both hosts: `scripts/setup_mcp_server.sh` (Node)
  and `scripts/setup_ollama.sh` (Core) — installing Node.js 20+, cloning the
  repo under `/opt/avendesora`, wiring the systemd service and CLI wrapper, and
  configuring a scoped `sudoers` allowlist.
- **Configs**: `configs/mcp-kali.service` (hardened systemd unit) and
  `configs/ollama-modelfile` (Avendesora persona and tool list).
- **Documentation**: `README.md`, `KALI-OPENLLM.md` master guide, and the
  `docs/` split guides (architecture, setup, workflows, agent roadmap).

### Fixed

- Install the `exploitdb` apt package (which ships the `searchsploit` binary)
  instead of the nonexistent `searchsploit` package, which aborted provisioning
  under `set -e`.
- Make the CLI entrypoint executable so the Core wrapper's direct `exec`
  launches it.
- Correct the netplan config heredoc in `setup_ollama.sh` (dropped a stray
  `cat |` that left a dangling process reading stdin) and use the
  non-deprecated `routes:` syntax in both provisioning scripts.
- Align the ASCII architecture diagrams across `README.md`, `KALI-OPENLLM.md`,
  `docs/architecture.md`, and `docs/cybersecurity-agent-roadmap.md` so borders
  line up in a monospace font.

[Unreleased]: https://github.com/imagewize/avendesora/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/imagewize/avendesora/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/imagewize/avendesora/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/imagewize/avendesora/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imagewize/avendesora/releases/tag/v0.1.0
