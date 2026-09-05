# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- README's opening line still led with `Mistral Small 3 / Llama 3.3 70B`, a
  leftover from the pre-0.1.1 framing in which the 70B was the headline model.
  It now reads "Mistral Small 3 by default, larger models if your hardware
  allows", matching the sizing guidance in `docs/architecture.md`.

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

[Unreleased]: https://github.com/imagewize/avendesora/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/imagewize/avendesora/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imagewize/avendesora/releases/tag/v0.1.0
