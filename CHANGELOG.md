# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-06

The release that booted `lima/avendesora-core.yaml`. It had never been started;
doing so — hands-off from a clean `limactl create` on an Ubuntu 26.04 guest —
surfaced two provisioning defects that aborted every boot, and then a third
defect in the persona itself that silently broke the agent loop. All three are
fixed and the end-to-end path is now verified against a real model: an Ollama
persona driving `agent.js`, through MCP, into a real `whois`, with the result
fed back and summarised correctly.

### Fixed

- **The Core never finished provisioning: Ollama's daemon was not running.**
  `lima/avendesora-core.yaml` assumed `ollama.com/install.sh` starts the systemd
  unit. On the Ubuntu 26.04 cloud image the installer leaves it
  `disabled`/`inactive`, so the template's 120s API-wait timed out and
  `set -eux` aborted the whole boot before any model was pulled. The provision
  script now runs `systemctl enable --now ollama` before waiting.
- **`ollama pull` crashed with `panic: $HOME is not defined`.** cloud-init runs
  provision scripts as root with no `HOME`, and the Ollama CLI panics resolving
  its models path. (This is why a manual `ollama pull` over `limactl shell` — which
  sets `HOME` — worked while the identical provision step did not.) The script
  now `export HOME=/root` before any `ollama` call.
- **The `avendesora` persona broke native tool calling.** `configs/ollama-modelfile`'s
  system prompt hand-enumerated the tools with shell-command examples ("Available
  Tools: - nmap … (e.g., `nmap -sV <target>`)" plus an example workflow). On a 7B
  model this trains the model to emit the tool call as **text in its reply**
  instead of Ollama's structured `tool_calls`, so the agent loop never fires the
  tool and the model hallucinates a result. Verified on the Core guest: base
  `mistral` tool-called correctly (`whois example.com` → real registrar), while
  the persona built on it did not, inventing a wrong registrar and date.
  Removed the textual roster; the system prompt now directs the model to use the
  function-calling interface, and the tool list reaches it via the MCP `tools`
  array the CLI already passes. Rebuilding the persona without the list restored
  correct tool calling.

### Changed

- **`docs/lima-local-dev.md`** — `socket_vmnet` must be **root-owned** at
  `/opt/socket_vmnet` (a Homebrew-only install fails Lima v1.0+'s ownership
  check, with the exact error and a reuse-the-brew-binary shortcut);
  `systemctl enable --now ollama` after the installer in both setup paths; four
  new troubleshooting rows (inactive Ollama unit / pull timeout, `limactl start`
  "did not receive an event with the running status" while the guest is still
  provisioning, the host-side `:11434` port-forward conflict, and the 16GB-Mac
  two-guest RAM reality); corrected the "8GB+8GB split" resource advice.
- **`configs/ollama-modelfile`** — see the persona fix above, with a comment
  recording why the tool list must not come back.
- **`CLAUDE.md`** — the tool-set sync rule is now four locations, not five: the
  Modelfile is explicitly **off** the list, since enumerating tools there breaks
  the loop.

### Verified

Run against the Core guest, not asserted:

- `lima/avendesora-core.yaml` boots and provisions **hands-off** from a clean
  `limactl create` (Ubuntu 26.04): Node.js 20, Ollama auto-started, `mistral`
  pulled, the `avendesora` persona built (`ollama show` reports `num_ctx 16384`),
  the CLI symlinked to `/usr/local/bin/avendesora`, and a `lima0` shared-vmnet
  address (`192.168.105.2/24`).
- **The agent loop works against a real LLM.** Driving `agent.js` with the live
  Ollama persona and a real MCP server returned a genuine `tool_calls` for
  `whois`, ran it, fed the output back, and produced an accurate answer — the
  tool-call formatting between Ollama and `agent.js` that 0.4.0 could only
  mock-test.
- The shared-vmnet setup on Apple Silicon: `socket_vmnet` root-owned at
  `/opt/socket_vmnet`, `/etc/sudoers.d/lima` in sync, the daemon starting under
  `limactl start`.

### Still not verified

- The two-machine path on real hardware. The real-LLM loop above ran with the
  MCP server on the **Core guest itself** over localhost (a 16GB Mac cannot run
  both guests plus CPU inference at once), so the Core→Node hop across the shared
  network between two guests is still unexercised.
- Real execution of `metasploit`, `searchsploit`, `nikto`, `tshark` — the loop
  test exercised `whois` (and thus the full `runTool` path); the others were not
  each run, and `metasploit`/`searchsploit` remain Kali-only.
- A clean `nikto` install on the Ubuntu guest (component confirmed as
  `multiverse`; the Core test installed `nmap`/`whois`, not `nikto`).

## [0.4.0] - 2026-09-06

First release with an actual test suite. 0.3.0 shipped `npm test` as
`node --check` and listed the agent loop and the tool set as untested; this
release replaces that with 28 `node --test` cases across both packages, closing
the parts of that list a macOS host can close without a Kali Node or a live LLM.
The two-machine path, real tool execution, a real-LLM loop, and a booted Core
template remain unverified — see below.

### Added

- **A real test suite replaces `npm test`'s syntax check.** Both packages now
  run `node --test` after `node --check` (the old check is kept as `npm run
  check`).
  - `clients/avendesora-cli/agent.test.js` — 14 tests driving the agent loop
    against a mock Ollama HTTP server and a mock MCP client. This exercises the
    tool-call formatting the 0.3.0 notes flagged as untested: the `/api/chat`
    request body (model, tools, `stream:false`, message order), `tool_calls`
    parsing and argument extraction, MCP text-content joining, the
    one-decision-at-a-time rule, unknown-tool rejection, the `metasploit`
    approval gate (approve and decline), step-budget exhaustion, session
    persistence, and context compaction. The *agent's* side of the contract is
    now covered; a **real LLM** is still not in the loop (see Not verified).
  - `servers/src/kali/tools.test.js` — 14 tests over the tool contract and the
    shell-injection guard for all six tools (`metasploit` and `searchsploit`
    included), plus dispatch: well-formed input clears validation and stops only
    at the missing-binary check. No Kali binary is required to run them.

### Fixed

- **`nikto` is in `multiverse` on Ubuntu, not `universe`.** The single-VM guide
  claimed `universe`; verified against `packages.ubuntu.com` for jammy (22.04)
  and noble (24.04): `nikto 1:2.1.5-3.1 [multiverse]`. The note now names the
  right component and gives the `add-apt-repository multiverse` fallback.

### Changed

- **`docs/lima-local-dev.md`** — the model-recommendations box now states that
  the agent loop needs a tool-calling model (several small models are read-only)
  and links the companion repo `imagewize/ollama-opencode-setup`, which carries
  tool-calling results measured on the target Macs (M1 16GB, M4 Pro 24GB).

### Still not verified

Carried forward from 0.3.0, narrowed by the tests above:

- The two-machine path on real hardware; real execution of `metasploit` and
  `searchsploit` (their input validation is now tested, their execution is not).
- The agent loop against a **real LLM** — the mock covers the agent's side of
  the tool-call contract, not whether a given Ollama model emits well-formed
  `tool_calls`.
- `lima/avendesora-core.yaml` has never been booted.
- A clean `nikto` install on the Lima `template:ubuntu` guest (the component is
  now correct; the install itself is unbooted).

## [0.3.0] - 2026-09-06

First release whose claims were checked by running them. A Debian guest was
provisioned from the new templates and driven end to end — `tools/list` and a
real `nmap` call from the macOS host, through Lima's port forwarding, into the
MCP server, out through `sudo -n`. That exercise found four defects that had
been shipped since 0.1.0, three of them on the **production** two-machine path
rather than the new local one.

### Fixed

- **Every tool call failed under systemd.** `configs/mcp-kali.service` set
  `NoNewPrivileges=true`, while `servers/src/kali/tools.js` runs each binary as
  `sudo -n <bin>` whenever the server is not root. Those cannot both hold: the
  flag blocks the privilege transition sudo needs, so every call died with
  `sudo: The "no new privileges" flag is set`. This affected any host
  provisioned by `scripts/setup_mcp_server.sh`, not just Lima guests. The flag
  is removed, with a comment recording why it must not come back; the sudoers
  allowlist remains the constraint on the service.
- **A failed clone destroyed the existing install.** Both setup scripts ran
  `rm -rf "${AVENDESORA_DIR}"` *before* `git clone`, so any clone failure left
  the machine with no checkout at all and `set -e` aborted the run. They now
  clone into a staging directory and swap it into place only on success.
- **Provisioning could not fetch the code.** Every path cloned
  `https://github.com/imagewize/avendesora.git` anonymously, but the repository
  is private until v1.0 — git prompted for credentials against a non-tty and
  failed with the opaque `could not read Username for 'https://github.com'`.
  Both scripts now honour an `AVENDESORA_REPO` override (SSH URL or local
  path), set `GIT_TERMINAL_PROMPT=0` so the failure is immediate rather than a
  hang, and print what to do about it. The Lima templates prefer a host mount
  and fall back to the clone.
- **The persona ran in a 4096-token context.** `configs/ollama-modelfile` set
  `temperature`, `top_p` and `top_k` but no `num_ctx`, so Ollama's default
  applied. Measured against it, the agent loop spends ~900 tokens every turn
  before the conversation starts — ~510 for the six MCP tool schemas and ~380
  for the system prompt — and a single nmap or nikto result is another 1-3k, so
  history began falling off after about one substantial scan. Now
  `PARAMETER num_ctx 16384`, verified via `ollama ps` (`CONTEXT 16384`). It
  costs KV cache: the same 4B model grew from 3.2GB to 5.1GB.

### Added

- **`lima/avendesora-kali.yaml` and `lima/avendesora-core.yaml`** — Lima
  templates for the macOS local-dev path, carrying resources, networking and a
  `provision:` block that runs what `docs/lima-local-dev.md` previously asked
  the reader to type by hand. `probes:` make `limactl start` block until
  `:3000/health` answers. Neither sets `arch`, so one file serves Intel and
  Apple Silicon natively. Both pass `limactl template validate`.

### Changed

- **`docs/lima-local-dev.md`** — Setup offers two paths per guest: the template
  file, or the original `limactl` flags with provisioning typed by hand. The
  flag path is kept in full as the explanation of what the templates do.
  "Advanced: Custom Lima Templates" becomes "Advanced: Editing the Templates".
- **`configs/mcp-kali.service`** — see the `NoNewPrivileges` fix above.
- **`scripts/setup_mcp_server.sh`, `scripts/setup_ollama.sh`** — staged clone,
  `AVENDESORA_REPO` override, actionable failure output.

### Fixed (Lima guide)

- **`nikto` is not in Debian `main`.** The guide's `apt install -y nmap nikto
  whois tshark` failed with `E: Unable to locate package nikto` on a Debian 13
  cloud image, and under `set -e` took Node.js, the checkout and the systemd
  unit down with it. `nikto` lives in `non-free`, which the cloud image does not
  enable; the templates and the guide now enable it. Debian's build is
  **1:2.1.5** against Kali's 2.5.x, so its plugin database is years older —
  noted in the guide.
- **`ReadWritePaths` named a nonexistent directory.** Lima's guest home is
  `/home/<user>.linux`, not `/home/<user>`. The guide uses `$HOME`; the
  templates use `{{.Home}}`.
- **The persona pulled a 24B model.** The guide had the reader `ollama pull
  mistral` then build from `configs/ollama-modelfile`, which is
  `FROM mistral-small` — silently fetching a second ~15GB model no guest can
  hold. Every path now renders a copy with `FROM` rewritten.
- **Editing a template appeared to do nothing.** `limactl create` snapshots the
  template into `~/.lima/<name>/lima.yaml`; the repo file is not consulted
  again. Documented, with the recovery.

### Verified

Run against a real guest, not asserted:

- Provisioning completes from a clean `limactl create`; `/health` reports
  `{"status":"ok","tools":["nmap","nikto","whois","tshark"]}`.
- `sudo -n` succeeds for all four tools under the allowlist.
- `curl http://127.0.0.1:3000/health` **from the macOS host** reaches the
  guest — Lima forwards guest ports to loopback with no `socket_vmnet` and no
  shared network.
- An MCP `tools/list` and an `nmap` call from the host returned real scan
  output through `sudo -n`.

### Not verified

- The two-machine path on real hardware. `metasploit` and `searchsploit` exist
  in neither Debian nor this test, so two of the six tools remain unexercised.
- The agent loop itself. These tests drove the MCP server directly; no LLM was
  in the loop, so tool-call formatting between Ollama and `agent.js` is still
  untested.
- `lima/avendesora-core.yaml` has never been booted.
- Ubuntu's `universe` claim for `nikto` in the single-VM section.
- `npm test` remains `node --check` — a syntax check, not a test suite.

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

[Unreleased]: https://github.com/imagewize/avendesora/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/imagewize/avendesora/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/imagewize/avendesora/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/imagewize/avendesora/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/imagewize/avendesora/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/imagewize/avendesora/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/imagewize/avendesora/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imagewize/avendesora/releases/tag/v0.1.0
