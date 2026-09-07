# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.1] - 2026-09-07

Agent-loop patch. Running the 0.10.0 harness against live inference for the first time found a real defect: a tool that cannot run in the current environment was retried until the step budget ran out. This release stops that, reports it, and adds a case set hard enough to tell models apart.

### Fixed

- **A tool that cannot run is no longer retried** (`clients/mshin-cli/agent.js`). Tool failures whose text is environmental — `sudo: a password is required`, a missing binary, `no new privileges` — fail identically on every attempt, but the loop fed the raw error back and let the model try again. It now marks the tool unavailable for the rest of the run, tells the model the failure is not a bad argument, and answers any further call to it from the transcript instead of re-executing. Ordinary failures (host down, no results) stay retryable, and a successful call is never classified this way however its output reads. The record is scoped to the run, not the `Agent`, so fixing a sudoers allowlist between prompts costs one rediscovery call rather than staying wrong for the session.

- **The fabricated-output backstop is grounded in real results** (`clients/mshin-cli/agent.js`). It only fired when no tool had executed for the whole run, and the flag it read was set by any call that returned — including a failed one. A single failed call therefore disarmed it, and anything invented afterwards reached the user unchallenged. Seen live: `whois` failed under `sudo`, `nmap` was never called, and both models printed a placeholder `Nmap Scan Results for 127.0.0.1` block while `fabricatedOutputsBlocked` stayed 0. The loop now records which tools returned without `isError` and blocks output that reads like a report from a tool that never returned one. A real `whois` result does not license an invented `nmap` report, an honest error is not a result, and summarising output a tool genuinely returned is untouched.

### Added

- **Non-retryable failure metrics.** `nonRetryableToolErrors` and `blockedToolRetries` are tracked by the agent and carried into all three report formats, separating a model that respects an unavailable tool from one that keeps hammering it.
- **A multi-tool evaluation case set** (`clients/mshin-cli/eval-config.multi-tool.example.json`). Two tools in one goal, a tool chosen conditionally on an earlier result, and a case that only passes if the model reports honestly when a tool cannot run.

### Changed

- **`clients/mshin-cli/README.md`**: documents the unavailable-tool rule in the agent-loop section, the two new metrics, and the harder case set.

### Verified

- `npm test` in `clients/mshin-cli/` passes 60/60 cases; `servers/src/kali/` passes 20/20. Every new agent case was checked against the unfixed loop by reverting `agent.js` alone: the five non-retry cases fail without that fix, and three of the four backstop cases fail without theirs — the fourth guards the summary path and must pass either way.
- **The defect was measured, not theorised.** On a Node whose sudoers allowlist did not cover `whois`, both the `mshin` persona and `qwen3:8b` spent their entire 3-step budget re-issuing the identical failing call. Neither invented registrar data — the honesty of the final answers was not the problem; the wasted budget was.
- **The fix changes live behaviour.** With the same models against the same unrunnable `whois`, the call executes once instead of twice and the case ends in 2 steps rather than 3. The suppression comes from the guidance message itself — `blockedToolRetries` stayed 0, so neither model even attempted the retry the short-circuit exists to catch.
- **The first wording of that guidance caused a regression, caught before merge.** Told only "do not retry it", both models abandoned the rest of a two-tool goal: on `recon-chain` they announced `nmap`, printed a placeholder for its output, and stopped without ever calling it. The guidance now names the remaining work explicitly and forbids describing output no tool returned.

### Still not verified

- The two-machine path on real hardware, across a physical LAN.
- A full model-comparison matrix on the multi-tool case set. It has been run once against `mshin` and `qwen3:8b` — which it does separate, on `recon-chain` — and not against anything larger than 8B.
- The reworded unavailable-tool guidance against live inference. The wording change is pinned by tests; whether it actually recovers the second tool on a two-tool goal is a live-model question, and that re-run had not finished when this was written. No tool has yet executed successfully through live inference on the macOS authoring host: the server runs every binary except `tshark` under `sudo -n`, which needs the Linux Node's allowlist. What the local runs exercise is tool *calling* and failure handling, not tool *output*.

## [0.10.0] - 2026-09-07

Agent-evaluation and transport-modernization release. Adds a model-evaluation harness to collect the measurements the roadmap calls for, and migrates both client and server from the deprecated SSE MCP transport to Streamable HTTP.

### Added

- **Model evaluation harness** (`clients/mshin-cli/eval-harness.js`). Runs a scripted set of prompts against one or more Ollama models and records duration, steps, tool-call success, narrated calls, fabricated outputs blocked, active-tool approvals, and context-window high-water mark. Output formats: JSON, Markdown, CSV.
- **Agent metrics collection** (`clients/mshin-cli/agent.js`). The `Agent` constructor accepts an optional `metrics` object and now tracks the same counters the harness reports.
- **Example evaluation config** (`clients/mshin-cli/eval-config.example.json`).
- **Expected-tool scoring in the evaluation harness.** A case may declare `expectedTools`; the report then carries `expectedToolsMet` and the `missingTools` the model never called, and the run prints the misses. The exit code is unchanged by this — non-zero still means a case threw, not that a model underperformed.
- **Transport lifecycle tests** (`servers/src/kali/transport.test.js`). Boots the server as a child process and drives it with a real MCP client: initialize, `listTools`, explicit session termination, and rejection of unknown session ids.

### Changed

- **MCP transport migrated from SSE to Streamable HTTP.** Both `clients/mshin-cli/index.js` and `clients/mshin-cli/eval-harness.js` now use `StreamableHTTPClientTransport` against `/mcp`. `servers/src/kali/index.js` now uses `StreamableHTTPServerTransport` with stateful sessions on `/mcp`, serving GET for the server-to-client stream, POST for requests, and DELETE for session termination; the old `/sse` and `/messages` endpoints are removed. DELETE is the only request that fires `onsessionclosed`, so without its route the server would hold every session it ever opened.
- **`docs/cybersecurity-agent-roadmap.md`**: noted the planned Mac Mini + Raspberry Pi deployment and the new model-evaluation harness under Phase 2.
- **`clients/mshin-cli/README.md`**: documented the evaluation harness and config format.
- **`CONTRIBUTING.md`** and **`CLAUDE.md`**: updated project-structure listings for `clients/mshin-cli/`.

### Fixed

- **`--format` is validated before the suite runs.** It was only checked inside `writeReport`, so a typo discarded every result after a full multi-model run. Client and writer now share one alias table (`json`, `md`/`markdown`, `csv`).
- **CSV cells are quoted per RFC 4180.** Only `error` was quoted, so a comma in a model or case name shifted every column after it.

### Verified

- `npm test` in `clients/mshin-cli/` passes 51/51 cases.
- `npm test` in `servers/src/kali/` passes 20/20 cases.
- **Streamable HTTP transport handshake works end to end.** Started `servers/src/kali/index.js` with `--tools nmap,whois` and connected a real MCP `Client` using `StreamableHTTPClientTransport` against `/mcp`. `client.connect()` completed initialize, `client.listTools()` returned the two enabled tool schemas, and `transport.terminateSession()` released the session server-side — confirmed by a follow-up DELETE for the same id answering 404. (An earlier draft of this entry credited `client.close()` with the cleanup; it does not contact the server at all.)

### Still not verified

- The two-machine path on real hardware, across a physical LAN.
- The new transport path through the full CLI + Ollama agent loop on a live Node.
- The harness against a real Ollama model; its CLI paths (format rejection, report writing, expected-tool scoring) are exercised, but no case has run end to end through live inference.

## [0.9.0] - 2026-09-07

Tool expansion release. Adds seven new Kali tools to the MCP server (hydra, sqlmap, gobuster, masscan, dirb, arping, dnsenum), bringing the total to thirteen. All tool-list locations (tools.js, setup scripts, service config, docs) are updated in sync per the repo invariant. Not yet verified on real hardware.

### Added

- **Seven new MCP tools**: `hydra` (password cracking), `sqlmap` (SQL injection), `gobuster` (directory/DNS brute forcing), `masscan` (fast port scanning), `dirb` (directory brute forcing), `arping` (ARP discovery), and `dnsenum` (DNS enumeration). Each includes full input schema validation and shell-injection guards.
- **Updated Lima Node template** (`lima/mshin-node.yaml`): provisions all thirteen tools from Debian repos plus metasploit/searchsploit from upstream vendors.

### Changed

- **All tool-list references updated**: `TOOL_PATHS` in `tools.js`, `--tools` flag and apt list in `setup_mcp_server.sh`, sudoers allowlist in both setup scripts and docs, `ExecStart` in `mcp-kali.service`, and all documentation examples now enumerate all thirteen tools.
- **`docs/cybersecurity-agent-roadmap.md`**: marked Phase 1 as complete, updated Current State table and overview.

### Verified

- `npm test` in `servers/src/kali/` passes 16/16 cases (contract test updated for 13 tools, injection guards added for all new tools).
- `npm test` in `clients/mshin-cli/` passes 32/32 cases.

## [0.8.0] - 2026-09-06

Full-toolset release for the Lima Node. The Debian dev guest now provisions all
six MCP tools — the last two, `metasploit` and `searchsploit`, from their
upstream vendors rather than Kali's repo — and both are verified executing for
real through the server's own handlers. Verifying `metasploit` surfaced a
handler bug that made it unusable, now fixed. The guest is renamed `mshin-kali`
→ `mshin-node`, since it is Debian, not Kali.

### Fixed

- **The `metasploit` tool hung instead of returning its result.**
  `servers/src/kali/tools.js` built the msfconsole `-x` resource script as
  `use …; set …; run` with no terminating `exit`. `runTool` invokes the binary
  through `execFile`, which has no TTY, so after the module ran msfconsole
  dropped to its interactive prompt, never received input, and hung until the
  600s timeout — then exited non-zero, so the handler rejected even though the
  module had executed. The script now ends with `exit`. Verified on the Lima
  Node: without it the call hangs; with it a portscan of `127.0.0.1` returns in
  ~2s with the real `TCP OPEN` result and `isError: false`. The script builder
  is extracted as `buildMsfScript` and unit-tested.

### Added

- **The Lima Node guest provisions all six tools.** `lima/mshin-node.yaml` adds
  `searchsploit` (cloned from exploit-db's GitLab repo — the clone is the
  install, arch-independent) and `metasploit` (from Rapid7's apt repo, which
  publishes `arm64`, so it works on Apple Silicon). Neither needs Kali's repo
  grafted onto Debian, which stays unsupported. A provisioning step warms
  metasploit's one-time Initial Setup as root — the account `sudo -n` tool calls
  use — so the first real call is fast rather than colliding with setup. The
  `sudoers` allowlist and the unit's `--tools` flag now carry all six.
- **The manual Path B in `docs/lima-local-dev.md` mirrors the template**, with
  the same upstream install steps, warm-up, sudoers and six-tool `--tools` flag.

### Changed

- **The Lima Node guest is renamed `mshin-kali` → `mshin-node`.** Naming it for
  the OS was wrong the moment the OS did not match: it is Debian, not Kali, and
  now it installs the offensive tools from upstream rather than from Kali. It is
  now named for its architectural role, pairing with `mshin-core`. The
  production Node still runs real Kali; `servers/src/kali/` and the
  `mshin-kali-mcp-server` package keep their names. `lima/mshin-kali.yaml` →
  `lima/mshin-node.yaml`, with all references updated across
  `docs/lima-local-dev.md`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` and
  `lima/mshin-core.yaml`, and the `<KALI_IP>` placeholder is now `<NODE_IP>`.
  A running guest created as `mshin-kali` keeps that instance name (Lima cannot
  rename one); recreate it from the renamed template to pick up the new name.

### Verified

- `npm test` in `servers/src/kali/` passes 16/16 cases (two new for
  `buildMsfScript`); `clients/mshin-cli/` still passes 32/32.
- **`searchsploit` and `metasploit` execute for real through the server
  handlers** on the Lima Node (`aarch64`, Debian 13, metasploit 6.5.3):
  `searchsploit` on `apache 2.4` returned live exploit-db rows, and the
  `metasploit` handler ran `auxiliary/scanner/portscan/tcp` against `127.0.0.1`
  and returned `TCP OPEN` in ~2s with `isError: false`. This closes the
  long-standing "real execution of metasploit and searchsploit" gap on the
  local-dev path.
- **The guest-to-guest Core → Node hop runs end to end on Lima's shared
  network.** Both guests on the `lima: shared` vmnet — Core `192.168.105.4`,
  Node `192.168.105.3`. `curl …:3000/health` from the Core reaches the Node, and
  a piped whois on `example.com` drove the whole chain — Core LLM → CLI → MCP
  client → Node → tool → answer — naming IANA as the registrar from real
  registry output. This leaves only the physical-LAN case open.
- **The 0.7.3 readline fixes hold in a live run, not only in tests.** The piped
  `exit` arrived mid-run, the busy guard refused it, and close waited for the
  answer instead of exiting early.
- **The narrated-tool-call fallback is model-dependent.** The `mistral` (7B)
  Core wrote the call as text where 0.7.3's `qwen3:8b` emitted a native
  `tool_calls`; the 0.7.2 recovery path ran the tool anyway, so smaller models
  still show the 0.5.0 behaviour the hardening was written for.

## [0.7.3] - 2026-09-06

CLI readline lifecycle release. Closes three defects that left stdin with two
owners, allowed concurrent agent runs, and killed in-flight work on EOF.

### Fixed

- **The CLI session now has a single owner of stdin.**
  `clients/mshin-cli/agent.js`'s `askYesNo` opened a second readline
  interface on the same stdin while `index.js`'s main interface was still
  live, leaving two `data` listeners racing for the reply: the approval
  answer reached both, so it was consumed as a new prompt while the question
  it was meant for never resolved. `askYesNo` now takes a reader from the
  caller. Only `metasploit` is in `ACTIVE_TOOLS` and the Lima node does not
  expose it, so this was latent rather than firing -- but it sat on the
  tool-approval gate.
- **A prompt typed mid-scan no longer starts a second concurrent run.**
  readline does not await an async `line` handler, so the CLI began another
  `agent.run()` against the same `Agent` and session memory. A busy guard
  now refuses input until the run finishes.
- **Closing stdin no longer kills an in-flight run.** `rl.on("close")`
  called `process.exit(0)` outright, which fires on every piped prompt since
  stdin ends as soon as it is read -- `printf 'prompt\nexit\n' | mshin`
  exited before answering. Close now waits for the run, and denies a pending
  approval first so EOF cannot hang the exit and no answer is never read as
  a yes.

### Verified

- `npm test` in `clients/mshin-cli/` passes 32/32 cases.
- `npm test` in `servers/src/kali/` passes 14/14 cases.
- Verified against host Ollama and the `mshin-kali` guest: piped `whois` now
  runs the tool and prints the answer, with the busy guard catching typed-ahead
  `exit`. Approval routing checked separately -- reply resolves the question
  and starts no second run, stdin holds one listener throughout, EOF
  mid-approval denies.
- **The host-Ollama path works end to end.** 0.7.1 documented it but had not run
  it: Ollama native on macOS, only the 4GiB Node guest booted, and the CLI
  pointed at both with `--node http://192.168.105.3:3000 --ollama
  http://localhost:11434`. The persona was built on `qwen3:8b` rather than the
  Modelfile's `mistral-small`, per the guide's `sed` on the `FROM` line. Asked
  for a whois on `example.com`, the model emitted a native `tool_calls` for
  `whois` — not the narrated shell command that 0.5.0 found smaller models fall
  back to — the Node ran it under `sudo -n`, and the answer correctly named IANA
  as the registrar from the real registry output.

  This settles the architectural claim the 0.7.1 docs made: **the Core does not
  have to be a VM.** The CLI is the MCP client and needs only an Ollama
  endpoint, so a 16GB Mac can run the whole system without the Core guest, with
  inference on the Mac's GPU instead of an emulated CPU.
- Both guests boot and provision cleanly at the 0.7.1 memory defaults
  (Core 10GiB, Node 4GiB) on a 16GB M-series Mac.
- **Re-checked on the merged 0.7.2 agent loop**, with the persona rebuilt
  from the current modelfile on `qwen3:8b` (the installed `mshin` predated
  it). Same whois on `example.com` through the CLI against host Ollama and
  the `mshin-kali` guest: a native `tool_calls`, no narration recovery, real
  registry output, IANA named correctly.

## [0.7.2] - 2026-09-06

Agent-loop hardening release. The prior `0.7.1` modelfile fix set `PARAMETER
 temperature 0`, but the CLI was still overriding it with `temperature: 0.7` in
the `/api/chat` request. This release fixes that override and adds recovery for
text-emitted tool calls plus a backstop that keeps invented tool reports from
reaching the user.

### Fixed

- **`clients/mshin-cli/agent.js` no longer overrides the modelfile temperature.**
  The API request hard-coded `options.temperature: 0.7`, which overrode the
  `PARAMETER temperature 0` set in `configs/ollama-modelfile`. It now sends
  `temperature: 0`, matching the persona configuration that keeps native tool
  calling reliable.
- **Narrated tool-call recovery handles `functions.name(args)` syntax.**
  `extractTextToolCall` previously matched only JSON payloads; some models emit
  calls as text like `functions.nmap(target="127.0.0.1", flags=["-sS"])`. The
  extractor now parses both JSON and function-syntax calls, then runs the real
  tool and strips the invented output from the transcript.
- **Backstop blocks fabricated tool output when no tool ran.** If a turn ends
  with no tool ever executed and the assistant content looks like a tool report
  (fenced `Result:` or port-style output), the loop drops the fabricated turn
  and returns a plain warning instead of printing the hallucination as an answer.

### Changed

- **`configs/ollama-modelfile`** — removed the pinned Mistral `TEMPLATE` and set
  `PARAMETER temperature 0`, with comments explaining both decisions.

### Verified

- `npm test` in `clients/mshin-cli/` passes 30/30 cases.
- `npm test` in `servers/src/kali/` passes 14/14 cases.

## [0.7.1] - 2026-09-06

Post-rename cleanup release. Fallout from 0.7.0, caught while rebuilding the two
Lima guests under their new `mshin-*` names. Neither bug was in the renamed code
itself — one was the box-drawing art the rename knocked out of alignment, the
other a guest sizing that only became impossible once both guests had to
coexist.

### Fixed

- **Lima guests no longer ask for more RAM than the host has.** The Core
  template requested 16GiB and the Node 8GiB — 24GiB against the 16GB Mac
  `docs/lima-local-dev.md` sets as its minimum. Lima accepts it and the guest
  boots, but the host swaps from the first byte and the second guest cannot
  start at all, so an end-to-end test across the pair was impossible on a
  machine the docs call supported. Core is now **10GiB**, which holds the
  default 7B model with headroom, and the Node **4GiB** — it runs a Node.js
  process and short-lived CLI tools, with no model and no inference. The manual
  `limactl create` commands and the all-in-one VM are sized to match.
- **ASCII diagrams squared up.** `avendesora` → `mshin` changed label lengths
  inside the box-drawing figures without repadding them, so borders ran ragged
  in the rendered Markdown across `README.md`, `KALI-OPENLLM.md`,
  `docs/architecture.md`, and `docs/lima-local-dev.md`. `docs/architecture.md`
  had also been left with bare `MSHIN SYSTEM` / `MSHIN CORE` / `MSHIN NODE`
  labels; they read **MACHIN SHIN** again, matching the prose headings in the
  same file, since `mshin` is the binary name and not the system's.
- **`clients/mshin-cli/package-lock.json` synced to `0.2.0`.** It had been left
  at `0.1.1` while `package.json` moved on at the rename.

### Changed

- **`docs/lima-local-dev.md` documents a lighter path for 16GB Macs.** Run
  Ollama natively and start only the Node guest, pointing the CLI at the host
  with `--ollama`. Nothing in the architecture requires the Core to be a VM —
  the CLI is the MCP client and only needs an Ollama endpoint — and host
  inference uses the Mac's GPU rather than an emulated CPU, so it is also the
  fastest option. Resource Allocation now states the template defaults instead
  of a range and warns against handing a guest all of the host's RAM.
- **New troubleshooting row for `bind: address already in use` on 11434.**
  Starting the Core guest while Ollama.app holds that port on the Mac leaves
  Lima unable to forward the guest's Ollama. Harmless — the in-guest CLI uses
  the guest's own `localhost` — but it looks alarming in the start log.

### Verified

Both guests deleted and rebuilt from these templates on a 16GB M-series Mac,
with the host clone mounted at `/opt/mshin`:

- **Node**, provisioned in 2m40s: `:3000/health` returns
  `{"status":"ok","tools":["nmap","nikto","whois","tshark"]}`, `mshin-node` is
  active, `sudo -n` is allowed for `nmap`/`nikto`/`whois` while `tshark` runs
  unprivileged as `tools.js` intends, and `searchsploit`/`msfconsole` are absent
  as documented for the Debian base.
- **Core**: `ollama create` built the persona on `mistral` 7.2B Q4_K_M.
  `ollama show mshin` reports `num_ctx 16384` and a `tools` capability, so
  native tool calling survives; the system prompt names no tools; and
  `/usr/local/bin/mshin` resolves into the mounted clone.
- Diagram alignment checked by comparing line widths within each box-drawing
  block — every block is uniform except the roadmap's Workstation figure, where
  the right-hand box deliberately closes a line early.

### Note

- `limactl start mshin-core` can exit 1 with `did not receive an event with the
  running status` while the guest is perfectly healthy: Lima's 900s probe
  expires if the 4.4GB model pull is slow, and provisioning finishes on its own.
  Already documented in `docs/lima-local-dev.md`; called out here because the
  rebuild hit it.

## [0.7.0] - 2026-09-06

Rename release. The project is now **Machin Shin** — named for the Black Wind
that hunts the Ways in the *Wheel of Time*, a truer fit than the enduring
Avendesora tree for a system that ranges the dark corners of a network and
surfaces what hides there. It is `mshin` everywhere an identifier is needed and
**Machin Shin** in prose. This is a breaking change for any deployed host: the
binary, install path, systemd unit, Unix user, and package names all change.

### Changed

- **Every identifier `avendesora` → `mshin`.** The CLI binary
  (`/usr/local/bin/mshin`), the install root (`/opt/mshin`), the systemd unit
  (`mshin-node`), the service `User=` and `ReadWritePaths`, the `sudoers`
  entries, the npm package names (`mshin-cli`, `mshin-kali-mcp-server`), and the
  agent memory path (`~/.mshin/`) all follow. Directories renamed:
  `clients/avendesora-cli/` → `clients/mshin-cli/`, and
  `lima/avendesora-{core,kali}.yaml` → `lima/mshin-{core,kali}.yaml`.
- **The persona is now the Black Wind.** `configs/ollama-modelfile`'s system
  prompt reframes Machin Shin as a tireless hunter that ranges the dark and
  misses nothing — "turned always to the service of the one who commands it," so
  the malevolent namesake does not undercut the safety directives. The
  tool-calling `TEMPLATE` and `num_ctx` are unchanged.
- **All Wheel of Time lore reworked from tree to Wind.** The epigraphs and the
  "named after" sections in `README.md`, `KALI-OPENLLM.md`,
  `docs/architecture.md` (the symbolism table), `docs/cybersecurity-agent-roadmap.md`,
  and `docs/lima-local-dev.md` no longer describe a rooted, enduring tree. The
  one surviving mention of Avendesora is deliberate: its trefoil leaf is
  canonically the shape of the Waygate key, and the Wind waits beyond that
  threshold.
- **New logo.** `assets/logo.svg` and `assets/logo-dark.svg` are now the *wind*
  icon from [Feather Icons](https://feathericons.com/) (MIT), replacing the
  Entypo leaf; the README credit changes to match. The ASCII logo in
  `assets/logo.txt` and `KALI-OPENLLM.md` is redrawn as wind gusts with a
  `M A C H I N   S H I N` wordmark.

### Added

- **Unofficial-project disclaimer** in `README.md`, naming the Bandersnatch
  Group as the rights-holder of *The Wheel of Time* and its lore.

### Verified

- `npm test` in `clients/mshin-cli` passes all 14 cases after the rename.
- `bash -n` on both `scripts/setup_mcp_server.sh` and `scripts/setup_ollama.sh`.
- Both logo SVGs parse as well-formed XML.

### Note

- The GitHub repository slug is renamed `avendesora` → `mshin` with this release;
  GitHub redirects the old URL, so existing clones and links keep working. Prior
  releases genuinely shipped as `avendesora`; their entries below are left as
  historical record, while the compare links now point at the new slug.

## [0.6.0] - 2026-09-06

Lima-local verification release. Running the agent loop against `nikto` and
`tshark` on the Ubuntu Core guest surfaced two real bugs — one in the persona
that prevented native tool calling for these tools, and one in how `tshark` was
invoked — and verified the fixes end to end. The single-VM path now enables
Ubuntu `multiverse` up front so `nikto` installs cleanly. The Kali-only tools
(`metasploit`, `searchsploit`) and the two-machine Core→Node hop remain for
dedicated hardware.

### Fixed

- **The `avendesora` persona did not reliably tool-call `nikto` and `tshark`.**
  `configs/ollama-modelfile` relied on a system prompt alone to steer the 7B
  model. On the Lima Core guest the model emitted the tool invocation as text
  (or hallucinated results) instead of Ollama's structured `tool_calls`. Adding
  the tool-calling `TEMPLATE` from the base Mistral model — plus a concise
  instruction to call tools through the function-calling interface — restored
  correct native tool calling for both tools.
- **`tshark` failed to read user-owned PCAP files.** `servers/src/kali/tools.js`
  ran every binary as `sudo -n` when the server was not root. `tshark` enforces
  a file-owner check that rejects root-owned or foreign-owned capture files, so
  the tool call returned a permission error. `tshark` now runs without `sudo`;
  it does not need privileges to analyze existing captures. The sudoers
  allowlists in `scripts/setup_mcp_server.sh`, `docs/setup.md`,
  `KALI-OPENLLM.md`, `lima/avendesora-kali.yaml`, and `docs/lima-local-dev.md`
  were updated to drop `/usr/bin/tshark`.

### Changed

- **`docs/lima-local-dev.md`** — the single-VM Ubuntu instructions now run
  `sudo add-apt-repository -y multiverse` before `apt install`, eliminating the
  `E: Unable to locate package nikto` failure. Added a **Verifying the tools**
  subsection with a loopback-PCAP capture (including `chown` so `tshark` can
  read it) and example CLI prompts for `nikto` and `tshark`.
- **`docs/setup.md`** — added **Step 1.9: Verify the Node Tools** with example
  CLI prompts for all six tools on a real Kali Node.
- **`KALI-OPENLLM.md`** — added a **Verify Every MCP Tool** subsection with the
  same six prompts and notes on the `metasploit` approval gate and `tshark`
  PCAP ownership.
- **`configs/ollama-modelfile`** — added the Mistral tool-calling `TEMPLATE` and
  tightened the system prompt so the model uses Ollama's native function calls
  rather than narrating commands.
- **`servers/src/kali/tools.js`** — `runTool` now accepts a `useSudo` option;
  `tshark` uses `{ useSudo: false }`.
- **`configs/mcp-kali.service`** — updated the security comment to note that
  `tshark` is the one tool that does not run under `sudo`.

### Verified

Run against the Lima Core guest (`avendesora-core`), not asserted:

- Clean `nikto` install on the Ubuntu 26.04 guest after enabling `multiverse`.
- Agent loop with the rebuilt `avendesora` persona drives a real `nikto` scan
  against `http://127.0.0.1` via MCP, receives the actual scan output, and
  summarises it correctly.
- Agent loop drives `tshark` against a user-owned `/tmp/localhost.pcap`,
  receives the real packet summary, and summarises it correctly.

### Still not verified

- Real execution of `metasploit` and `searchsploit` on a dedicated Kali Node.
  Verification prompts are now documented in `docs/setup.md` and
  `KALI-OPENLLM.md`; the actual agent-loop runs still need a real Kali Node.
- The two-machine path on real hardware (Core → Node across the shared network).

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

[Unreleased]: https://github.com/imagewize/mshin/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/imagewize/mshin/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/imagewize/mshin/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/imagewize/mshin/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/imagewize/mshin/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/imagewize/mshin/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/imagewize/mshin/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/imagewize/mshin/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/imagewize/mshin/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/imagewize/mshin/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/imagewize/mshin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/imagewize/mshin/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/imagewize/mshin/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/imagewize/mshin/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/imagewize/mshin/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/imagewize/mshin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imagewize/mshin/releases/tag/v0.1.0
