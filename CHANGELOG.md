# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`wpscan` tool on the Node.** WordPress enumeration from the outside: WordPress version, themes, plugins, users and backups, plus known-vulnerability flagging. Same shape as the other network tools — `url` (target-scoped), optional `enumerate` (e.g. `u,vp,vt`) and `options`, all behind the `assertSafe` guards. Full vulnerability data needs `WPSCAN_API_TOKEN` in the Node's environment; without it the scan still enumerates and reports fewer vulnerabilities. On the bare-metal Node it runs as the service user (like `tshark`, `dirb`, `ffuf`): it is a plain network scanner, and sudo's `HOME=/root` would break its `$HOME/.wpscan` cache — so it has no sudoers entry. Docker: `wpscan` joined `KALI_TOOLS` and the `CMD` tool list. Debian (Lima) has no `wpscan` package, so the Lima unit's `--tools` flag deliberately leaves it out — the tool list invariant is otherwise updated in full (tools.js, setup script, systemd unit, Dockerfile, server README, and the example `--tools` lists in `docs/SETUP.md`/`KALI-OPENLLM.md`, which also regained the previously missing `arp-scan`).

## [0.24.1] - 2026-10-22

Compose-project naming patch, born from a live Docker Desktop session: the Containers view grouped the Node under the compose file's directory name ("configs"), which read like a config dump rather than the Node. One top-level line pins the project name; the running stack was moved over and re-verified end to end.

### Fixed

- **`configs/compose.yaml` names the compose project `mshin`.** Docker Desktop's Containers view and `docker compose ls` show the compose project name, which defaults to the directory containing the compose file — `configs` here. A top-level `name: mshin` pins it, so the project reads as the Node it is. The container name (`mshin-node`) and the published port (`3001:3000` on macOS) are unchanged, so Vibe and OpenCode configs are unaffected.

### Changed

- **Package versions aligned** to `0.24.1` in `servers/src/kali/package.json` and `clients/mshin-cli/package.json`, both `package-lock.json` files resynced.

### Verified

- `docker compose -f configs/compose.yaml -f configs/compose.local.yaml config` shows `name: mshin`.
- The running stack moved from the old `configs` project to `mshin`: `docker compose ls` shows `mshin  running(1)` and the old project is gone; the container is healthy on `0.0.0.0:3001->3000`; `GET /health` answers 200; an authenticated MCP `initialize` against `http://localhost:3001/mcp` succeeds.
- `npm test` in `servers/src/kali/` and `clients/mshin-cli/` (pre-commit check; no code under either package changed).

## [0.24.0] - 2026-10-22

Positions release, documentation-led. The convergence the repo has been driving at is now its organizing story: **three truthful scan positions** — the Mac host (Vibe or OpenCode driving `brew`-installed tools directly, no Node in the loop) for LAN discovery and light scans, the Docker Node (locally or on a VPS) for internet-facing targets, and a Linux box on the LAN for real ARP work. Host-direct tool use is documented for the first time, with its caveats stated plainly: none of the Node's server-side guards apply, macOS is not Kali, and the MCP server cannot run on the host. Lima moves to maintenance mode — Docker ties it on measured tool performance, and the bridged guest's one irreplaceable trick, ARP discovery when the Mac is the only machine, is now named the fallback of last resort behind a Raspberry Pi or any Linux box on the LAN. The script fixes pending in Unreleased ship in the same version.

### Changed

- **Package versions aligned** to `0.24.0` in `servers/src/kali/package.json` and `clients/mshin-cli/package.json`, both `package-lock.json` files resynced.

### Fixed

- **`scripts/setup_mcp_auth.sh --check` no longer prints full tokens.** The diagnostic reported token values verbatim, so a shared terminal or a pasted log leaked the credential. Tokens now render masked (`604b...4df4` — first four and last four characters; `****` for anything shorter), while the match/mismatch verdicts are unchanged. Verified live against the configured deployment: all four sources report the same masked token and `[OK]`.
- **`scripts/setup_mcp_auth.sh` no longer hardcodes `http://localhost:3001/mcp` in the OpenCode patch.** A `--url` flag (or `MSHIN_NODE_URL`) now sets the Node URL written into `~/.config/opencode/opencode.jsonc` and the printed snippet, defaulting to the previous `localhost:3001` so local setups are unchanged. This makes the helper usable against a VPS Node: `setup_mcp_auth.sh --url http://<VPS_IP>:3000/mcp`. Verified against a realistic JSONC in an isolated `HOME`: the patch preserved an unrelated server entry and comments and wrote the custom URL. `docs/VPS-NODE.md`'s client-scan section documents the flag.
- **`scripts/setup_bridged_node.sh` keeps the bridged Node's internet egress.** The bridged interface's DHCP lease installs its own default route (metric 100), which outranks Lima's NAT default (metric 200) — and a home router will not usually forward the guest's off-LAN traffic, so every internet-bound probe from the Node died and `nmap` reported `Host seems down` for targets that answered from the Mac. The script now deletes the `lima1` default route, guarded and idempotent: `lima1` keeps the on-link LAN route, the NAT interface carries the internet. Measured live on `mshin-node-bridged`: before the fix every guest-side scan of a public VPS failed; after it, `nmap -sV` through the Node's `tools/call` returned the real banners (OpenSSH, nginx) at the real ~0.37 s RTT.

### Documented

- **The three truthful scan positions, and host-direct tool use.** `docs/DOCKER-LOCAL-DEV.md` now opens with a table comparing the Mac host (agent drives `brew`-installed tools directly, no Node), the Docker Node (local or VPS), and a Linux box on the LAN — and documents the host-direct workflow for Vibe/OpenCode: `lan_inventory.py` for discovery, `nmap`/`arp-scan` for light targeted scans, Docker Node for internet-facing targets. The caveats are explicit: host-direct bypasses every server-side guard (`assertSafe`, `MSHIN_ALLOWED_TARGETS`, the fabricated-discovery refusal), macOS is not Kali, and the MCP server cannot run on the host. Lima is repositioned as maintenance mode in `docs/LIMA-LOCAL-DEV.md` — the two-VM dev environment is reference-only, and the bridged guest is the fallback of last resort for ARP discovery, superseded by any Linux box on the LAN. Cross-references updated in `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, and `docs/VPS-NODE.md`.
- **Lima's user-mode NAT answers ICMP on behalf of any address.** From inside the bridged guest, `ping` against a public VPS ~400 ms away returned sub-millisecond replies; TCP forwards faithfully, so internet hosts must be judged by TCP or pinged from the Mac. Recorded in `docs/DOCKER-LOCAL-DEV.md` Troubleshooting, alongside the Docker Desktop fabrication truth it mirrors, with both measured caveats noted in the bridged-guest hybrid section.

## [0.23.0] - 2026-10-22

Authentication-and-discovery UX release. The recurring "MCP authentication keeps failing" reports for OpenCode and Vibe turned out to be two separate setup bugs: OpenCode needs `oauth: false` for a static bearer server, and every client (Docker, Vibe, OpenCode, shell) was getting a different token copied by hand. The LAN-discovery pain on Docker Desktop is not a bug in the Node — the container is behind a NAT and cannot do truthful Layer-2 discovery — so this release ships a cross-platform host-side helper and makes the workflow explicit: discover from the host, scan through the Node.

### Added

- **`scripts/setup_mcp_auth.sh`** — one-command token synchronization. Generates a 64-hex-char `MSHIN_NODE_TOKEN`, writes it to `configs/mshin-node.env` (Docker Node), `~/.vibe/.env` (Mistral Vibe), and `~/.config/opencode/.env` (OpenCode), patches `~/.config/opencode/opencode.jsonc` with the correct `mshin` server block, then prints the restart command. `setup_mcp_auth.sh --check` reads all visible token sources and reports mismatches without changing anything, so "why is auth failing again?" becomes a one-line diagnosis.
- **`scripts/lan_inventory.py`** — cross-platform LAN inventory (macOS, Windows, Linux). Detects the physical LAN interface and subnet, ping-sweeps the /24, parses the ARP table, resolves best-effort hostnames, and outputs a human table (`--json` for machine-readable, `--targets` for a Node-ready JSON array). It deliberately skips VPN/tunnel interfaces on macOS and reports the real hosts the Node can then scan faithfully.

### Fixed

- **OpenCode documentation now includes `oauth: false` and a literal bearer token.** Without `oauth: false`, OpenCode treats the Node as an OAuth server and prompts for browser sign-in on every connection. OpenCode's documented `{env:...}` interpolation in remote MCP headers is currently broken (anomalyco/opencode#23664), so the `Authorization` header must contain the actual token rather than `{env:MSHIN_NODE_TOKEN}`. `README.md` and `docs/DOCKER-LOCAL-DEV.md` now show the working `opencode.jsonc` snippet, and `scripts/setup_mcp_auth.sh` patches the file automatically.
- **Vibe documentation now stresses `~/.vibe/.env`.** Vibe's `api_key_env` only names the variable; the value must be in `~/.vibe/.env` (or exported in the shell that launches Vibe). The docs now pair the `config.toml` snippet with the helper that writes the env file.

### Changed

- **`configs/compose.local.yaml`** now publishes the Docker Node on `localhost:3001` instead of `3000`. This avoids the silent port collision with a running Lima `mshin-node` guest, which automatically forwards its port 3000 to the Mac's `localhost:3000` and answers client requests with its own token.
- **`docs/DOCKER-LOCAL-DEV.md`** recommends `scripts/setup_mcp_auth.sh` in Setup, documents the OpenCode/Vibe gotchas in Usage, updates every `localhost:3000` reference to `localhost:3001`, explains the new default port, adds a "The macOS host as the LAN vantage" subsection, and points at `scripts/lan_inventory.py` as the host-side discovery path. The capability matrix and Limitations now explicitly mention Docker Desktop on Windows alongside macOS.
- **`README.md`** replaces the hand-rolled token generation in the Vibe and OpenCode mode sections with `scripts/setup_mcp_auth.sh`, updates both Docker-mode URLs to `http://localhost:3001/mcp`, adds the missing `oauth: false` to the OpenCode config, and expands the "Scanning your LAN from a Docker Node" subsection to explain why the Mac itself is the best discovery vantage point.

### Verified

- `scripts/setup_mcp_auth.sh --check` correctly reported the user's existing Docker and Vibe tokens as matching, identified the missing OpenCode env file, and `--token <value>` wrote synchronized tokens to all three files and patched `~/.config/opencode/opencode.jsonc`.
- `scripts/lan_inventory.py` on macOS with a VPN owning the default route correctly selected `en0` (Wi-Fi), found the live gateway and one additional host, and produced valid `--json` and `--targets` output.
- `opencode mcp list` reports `✓ mshin connected` after `setup_mcp_auth.sh` patched `opencode.jsonc` with `oauth: false` and a literal bearer token pointing at `http://localhost:3001/mcp`.
- `npm test` in `servers/src/kali/` passes 67/67; `npm test` in `clients/mshin-cli/` passes 114/114 (no code changed under either package; pre-commit check).
- `bash -n` passes on `scripts/setup_mcp_auth.sh`.
- `python3 -m py_compile scripts/lan_inventory.py` passes.
- `docker compose -f configs/compose.yaml -f configs/compose.local.yaml config` validates after changing the published port to `3001:3000`.

### Not verified

- **Windows and Linux execution of `scripts/lan_inventory.py`** — the macOS path was run live; the Windows and Linux branches were written against documented `ipconfig`/`arp -a`/`ip neigh` output and are expected to work, but were not executed on those platforms.
- **Vibe end-to-end after token synchronization** — the user's `~/.vibe/config.toml` URL was updated to `http://localhost:3001/mcp`, but Vibe itself was not restarted during this session.

## [0.22.0] - 2026-10-21

Honesty release, born from a live session that asked the Docker Node for the LAN's hosts and got 256/256 "up" when five were real. The Node now refuses to return fabricated discovery results, real ARP discovery is a first-class tool, the Mac-side workflow is one command, and the docs state plainly which network position can see what: Docker for evals and internet targets, Lima bridged for LAN discovery on a Mac, a VPS for internet-facing targets — and never anyone's home LAN from the wrong side of a NAT.

### Added

- **Discovery fabrication guard** (`servers/src/kali/tools.js`). An `nmap -sn` (or legacy `-sP`) against a range where *every single address* answered — from 17 addresses up — now fails with `Refusing to return a fabricated discovery result` instead of handing back a fake host list, with the recovery path in the error text. Enumerated `targets` lists of live hosts are untouched (an all-up result is legitimate for a known list); port/service scans are untouched; ranges of 16 addresses or fewer are below the heuristic. On a real segment the guard cannot fire: the network and broadcast addresses never answer ARP.
- **`arp-scan` tool** — real ARP discovery with IP/MAC/vendor output: the tool that is either right or visibly wrong. The tool-list invariant is updated in all five places plus the Lima template mirror (apt list, sudoers, `--tools`): `servers/src/kali/config.js` + `tools.js`, `scripts/setup_mcp_server.sh` (apt, `--tools`, sudoers), `configs/mcp-kali.service`, `configs/Dockerfile` (`KALI_TOOLS` + `CMD`), `lima/mshin-node.yaml`. The binary path is `/usr/sbin/arp-scan` on both Kali and Debian — measured inside the image after the first attempt assumed `/usr/bin` and failed, not guessed a second time.
- **`scripts/lan_inventory.sh`** — host-side LAN inventory on macOS: detects the subnet itself (`ipconfig getifaddr`), ping-sweeps, filters `arp -a` to real MACs, resolves best-effort names, and prints a ready-to-use `targets` array for the Node. Documents the VPN/hostname caveat inline.
- **`scripts/setup_bridged_node.sh`** — the one-command bridged Lima Node (`mshin-node-bridged`): the real LAN vantage point on a Mac. Enforces the token (a bridged Node is LAN-reachable), sets it as a systemd drop-in inside the guest, reads the `lima1` DHCP address, warns about the localhost:3000 port-forwarding collision with other mshin guests, and prints verification and cleanup steps.
- **`docs/VPS-NODE.md`** — the cloud Node guide, led by its Layer-2 truth table: a VPS Node is faithful for internet-facing targets and its own cloud subnet, and cannot see any LAN it is not physically on. Setup (base `compose.yaml` unchanged — host networking is real on a Linux kernel), the mandatory token/scope/firewall posture, and troubleshooting entries for the guard's refusal.

### Changed

- **The docs now tell the LAN-position truth.** `docs/DOCKER-LOCAL-DEV.md` gains the plain rule up front — Docker Node for evals, internet targets, and targeted scans; the Mac itself (`lan_inventory.sh`) or the bridged Lima Node for LAN discovery — and its capability matrix gains the `arp-scan` row and the guard. `AGENTS.md`'s "Local LAN work on macOS" procedure now starts with `lan_inventory.sh`, names the guard, and points at the bridged script and the VPS truth; its tool-list invariant also names the Lima template's three mirrored locations. `CLAUDE.md`'s convention bullet records the refusal; its layout section lists the new script and doc. `README.md` and `CONTRIBUTING.md` cross-reference `docs/VPS-NODE.md` and both scripts.
- **Package versions aligned** to `0.22.0` in both packages, locks resynced.

### Fixed

- **`transport.test.js` no longer inherits the host shell's `MSHIN_NODE_TOKEN`** — the spawned test server demanded a bearer token on any machine where the variable is exported (every configured deployment), failing the three session-lifecycle tests with 401. The child env is scrubbed, so the suite passes 67/67 regardless of the host environment.

### Verified

- **The guard fires live**: `nmap -sn 192.168.0.0/24` through the rebuilt Docker Desktop container returns the fabrication error (the pre-guard behavior, all 256 "up", is what motivated this release). A targeted `-sV -p 80` of the LAN gateway through the same Node returns the real banner — the faithful path is unchanged.
- **`arp-scan` live through the container**: the `tools/call` round trip ARP-scans the requested range from the bridge and honestly reports `0 responded` — no fabricated MACs. `/health` lists all seventeen tools.
- **`scripts/lan_inventory.sh` live on the Mac**: found the real hosts with MACs and built the `targets` array; a host that had joined the network since the session's first manual sweep was picked up.
- `npm test` in `servers/src/kali/` passes 67/67 (63 existing plus four guard tests; the `arp-scan` injection cases extend the existing suites, and the tool-contract test now pins seventeen). `npm test` in `clients/mshin-cli/` passes 114/114 (client unchanged; pre-commit check).
- `bash -n` on all touched/new scripts; `limactl template validate` passes on the updated template.

### Not verified

- **`scripts/setup_bridged_node.sh` end to end** — creating a bridged guest takes minutes and modifies the host's Lima setup, so the script was verified by inspection and `bash -n`, not by running it. Every command it issues mirrors steps documented and previously verified in `docs/LIMA-LOCAL-DEV.md` (bridged create, token drop-in, `lima1` address read).
- **The `arp-scan` sudo path on a bare-metal Node** — the container runs as root (no sudo), so the `/usr/sbin/arp-scan` allowlist entry is synced in both sudoers locations but unexercised on real metal.

## [0.21.0] - 2026-10-21

Two born-from-a-live-session changes. The nmap tool gains multi-target calls, because scanning a discovered host list one host at a time wastes an agent turn per host. And the Docker guide gains the LAN-discovery truth this session measured the hard way: host discovery through Docker Desktop's bridge is fabricated, targeted scans are faithful, and ARP-based discovery needs the bridged-guest hybrid.

### Added

- **`nmap` accepts a `targets` array** (`servers/src/kali/tools.js`). nmap takes host specs as separate arguments — a single comma-joined argv is parsed as a hostname and fails with `Failed to resolve` (verified against Kali's nmap 7.991), so the handler splits comma-separated strings and array entries into one argv per spec. `target` (single spec or comma list) still works; either alone suffices; neither rejects with a clear error. Scope checks run per host via `assertTargetListInScope`, so a `MSHIN_ALLOWED_TARGETS` allowlist of individual IPs admits a discovered host list instead of rejecting the joined string.
- **LAN-discovery section in `docs/DOCKER-LOCAL-DEV.md`** — the measured capability matrix (internet egress yes; targeted scans of live hosts yes; host discovery no) and the **bridged-guest hybrid**: the same container image running inside a Lima guest with `- lima: bridged`, under the base `compose.yaml`'s host networking — putting the tools directly on the physical LAN with working ARP. The production equivalent (real Linux Node, `compose.yaml` unchanged) is named as the simpler path.

### Changed

- **Troubleshooting entry for fabricated discovery** (`docs/DOCKER-LOCAL-DEV.md`): `nmap -sn <LAN>/24` through the bridge returns *all 256* addresses "up" at sub-millisecond latencies — Docker Desktop's NAT answers discovery probes for every address, dead or alive. Measured against ground truth: a host the container reported "up" was down per a native scan, and the live gateway's service scan matched the native result byte-for-byte (banners included). Rule: get the host list from something with a real network position, then scan those hosts through the Node.
- **Package versions aligned** to `0.21.0`, locks resynced.

### Verified

- **Live through the rebuilt container**: one `tools/call` with `targets: ["127.0.0.1","192.168.0.1"]` and `-sV -p 22,80,3000` scanned both hosts in a single call — the container's own Express on `:3000` and the LAN gateway's web UI — two scan reports, real banners, 19.3 s.
- `npm test` in `servers/src/kali/` passes 63/63 (57 existing plus six new: schema contract, targets-array dispatch, comma-list dispatch, injection rejection per entry, non-array rejection, and neither-argument rejection). The existing `/must be a string/` contract tests pass unchanged — `assertSafe` still produces them.
- `npm test` in `clients/mshin-cli/` passes 114/114 (client unchanged; pre-commit check).

## [0.20.0] - 2026-10-21

Measurement release. The full model-comparison suite re-run against the **sandboxed Docker Node**, closing the gap 0.19.0 itself flagged as not verified. No code changed — the harness, case set, and models are identical to the 2026-10-20 baseline; only the Node moved, from a Lima guest to the capabilities-limited container.

### Added

- **`docs/EVAL-RUN-2026-10-21.md`** — the raw harness report plus the run's reasoning, mirroring the 2026-10-20 record: what changed in the environment (the Node's `127.0.0.1` is now the container; tool calls cross the bridge/published-port path), the findings table, and the reproduction command.
- **Eval-harness run artifacts are gitignored** (`.gitignore`). The harness writes transcripts, `AgentMemory` (`eval-results/.mshin-eval/memory.json`), and reports under `clients/mshin-cli/eval-results/` at run time; none of it is source. Curated records are committed deliberately as `docs/EVAL-RUN-*.md`, as both runs now are.

### Changed

- **Roadmap Phase 2** records the second comparison run; `docs/DOCKER-LOCAL-DEV.md`'s "not re-run" caveat is replaced by the measured result; `README.md`, `CONTRIBUTING.md`, and `AGENTS.md` cross-reference the new record.
- **Package versions aligned** to `0.20.0` in both packages, locks resynced — the docs-only 0.18.x releases had left them drifted at 0.17.2 before 0.19.0 fixed them; this release keeps the new habit.

### Verified

- **The suite ran end to end against the Docker container** (`configs/compose.yaml` + `compose.local.yaml`, bridge override, bearer token from `configs/mshin-node.env`), after confirming `/health` listed all sixteen tools and a `tools/call` round trip to `nmap` returned real scan output.
- **The 8B tier is unchanged from the Lima baseline**: `mshin` and `qwen3:8b` both 4/4 — zero narrated calls, zero fabricated outputs, context high-water 902 tokens (baseline: 947). Both models handled the case-set quirk the container introduced (the web server is on `:3000`, not `:80`) by pivoting `nikto` to the right port. Verdict: the sandbox is a drop-in Node for the harness.
- **`qwen3:4b` remains below the bar** (2/4, baseline 3/4): `chain-with-dependency` failed on a fabricated output the backstop blocked — same failure class as the baseline run; `recon-chain` died on an MCP request timeout (`-32001`) during an exploratory `dnsenum` call the model chose beyond the expected set. The cause of that one is not established (model choice vs. container DNS path) and moot on a rejected tier; the record says so rather than dressing it up.
- **One wall-clock caveat, recorded honestly**: `nikto`'s ~8000 requests through the bridge/published-port path are slower than a guest-local path — `chain-with-dependency` took ~105 s per 8B model against ~68 s on the guest. Scores unaffected.
- `npm test` in `servers/src/kali/` passes 57/57 and in `clients/mshin-cli/` passes 114/114 (pre-commit check; no code changed).

## [0.19.0] - 2026-10-21

The Node, sandboxed: Docker becomes the portable deployment artifact and the default local-development path. One image runs the MCP server and all sixteen Kali tools as root *inside a capabilities-limited jail*, so a bad flag or a hijacked model prompt trashes a disposable container instead of the Node's OS — and the sudo-root hot path disappears entirely (no sudo is installed in the image, so the sudoers allowlist and the tshark/dirb/ffuf sudo exceptions are moot).

### Added

- **`configs/Dockerfile`** — Kali image with all sixteen tools as one `KALI_TOOLS` build arg (the tool list's image-side counterpart of `TOOL_PATHS`; under Docker, the setup script's apt list and sudoers allowlist both collapse into it), the MCP server with `npm install --omit=dev`, and `HOME=/tmp` so runtime writes land on the tmpfs under the read-only rootfs. `setcap -r /usr/lib/nmap/nmap` is load-bearing: Kali ships nmap's real binary with file capabilities, and `no-new-privileges` makes any privilege-gaining exec fail with EPERM — measured, the first nmap call died with `Operation not permitted` until that line existed. A `getcap -r /` sweep over the whole image finds capabilities on that one file only.
- **`configs/compose.yaml`** — the production Node shape: `network_mode: host` (raw-socket tools must reach the LAN from the host's own IP), `cap_drop: ALL` + `cap_add: NET_RAW, NET_ADMIN`, `security_opt: no-new-privileges: true`, `read_only: true` with a `/tmp` tmpfs, `mem_limit: 2g`, `pids_limit: 512`, `init: true` for zombie reaping, and a healthcheck on `/health`. Runtime secrets come from a required `env_file` (`configs/mshin-node.env`, gitignored, chmod 600) rather than compose interpolation, so `build`/`ps`/`logs` never need the token — and a missing file fails `up`, fail-closed: with host networking, an unauthenticated Node is drivable by anyone on the LAN.
- **`configs/compose.local.yaml`** — the macOS override: Docker Desktop does not publish host-network services to the Mac (`host` there is the Docker VM's network), so local dev switches to bridge with `3000:3000` published. The base file keeps host networking for Linux Nodes and VPSes.
- **`.dockerignore`** — keeps host `node_modules` and the docs out of the build context (the context transfers 122 kB, not the whole clone).
- **`docs/DOCKER-LOCAL-DEV.md`** — the default local-dev guide (Ollama native on the Mac + the Node container), including the **measured Lima-vs-Docker comparison** that decided the pivot: a full-stack `nmap` MCP round trip ties at 11.32 s (native Lima) / 11.21 s (container in Lima) / 11.30 s (Docker Desktop); the native guest is only ~5–8% faster on a 0.4 s localhost microbenchmark. Also documents the Lima port-forward collision that silently claims `localhost:3000`.

### Changed

- **Docker is the default local-development path**; Lima is demoted to production-shape emulation (systemd unit, Debian host, bridged LAN access). `docs/LIMA-LOCAL-DEV.md` now says so up front, and the README's Vibe and OpenCode mode sections set the Node up as the container (`localhost:3000`) with Lima as the alternative; `README.md`/`CONTRIBUTING.md`/`AGENTS.md`/`CLAUDE.md`/the roadmap cross-reference the new guide. The tool-list invariant gains the Docker location: under `configs/Dockerfile`, the apt list and sudoers collapse into `KALI_TOOLS`, and the `--tools` flag appears in the `CMD`.
- **Package versions aligned** to `0.19.0` in `servers/src/kali/package.json` and `clients/mshin-cli/package.json`, and both `package-lock.json` files resynced — they had drifted to `0.17.2` behind the `0.18.x` docs releases.

### Verified

- **On a Linux host (the `mshin-node` Lima guest, Debian 13, arm64, Docker 26.1.5 installed in-guest):** `docker-compose build` produces the 3.09 GB image; `up -d` brings it up healthy; `GET /health` reports all sixteen tools; `POST /mcp` without a token answers 401; an authenticated initialize → `tools/call` round trip to `nmap` (`-sV -p 22,3000` on `127.0.0.1`) returns real scan output (OpenSSH and the Node's own Express service detected, 11.21 s). `docker exec` confirms `NoNewPrivs: 1` and `CapEff/CapBnd` = exactly `NET_ADMIN|NET_RAW`.
- **On Docker Desktop (macOS, Apple Silicon, daemon 29.8.2):** the same image (transferred, not rebuilt) with the compose override reaches `localhost:3000`; the same authenticated nmap round trip returns real output in 11.30 s; the healthcheck reports healthy. Also verified: with only the base compose file (host networking), nothing answers on the Mac's `localhost:3000` — the documented reason the override exists. A Lima `mshin-node` guest running at the same time silently claims `localhost:3000` via Lima's automatic port forwarding and answers 401 to the container's token — both gotchas are now troubleshooting entries in the guide.
- **Benchmarks** (same Mac, same day, same image where applicable): `nmap -sS -p-` localhost 0.37–0.38 s (native Lima) vs 0.39–0.42 s (container) vs 0.40–0.41 s (Docker Desktop); `openssl speed` aes-256-cbc 1,057–1,120 MB/s across all three (noise-level spread); full MCP nmap round trips within 11.2–11.3 s of each other everywhere.
- **Not verified in this session:** the eval harness itself was not re-run against the Docker Node (only the transport round trip was); the file-taking tools (`tshark`, `john`, `sqlmap`) were not exercised against mounted files; the Raspberry Pi was not in scope.

## [0.18.0] - 2026-10-21


Docs-only release, born from a live session: a fourth deployment mode joins the
two-machine setup, the cloud-inference hybrid, and the Vibe mode. Run **OpenCode**
as the agent driving a **local Ollama** model, with the Node in a Lima guest on the
same host — like the Vibe mode it replaces `mshin-cli`, but inference stays local,
so it is private and offline. No code changed; the Node already speaks the same
Streamable HTTP MCP OpenCode connects to.

### Added

- **OpenCode CLI + local Ollama + Lima Node option** (`README.md`, Architecture).
  Register the Node as a remote MCP server
  (`opencode mcp add mshin --global --url http://<NODE_IP>:3000/mcp`) and add the
  bearer-token header in `~/.config/opencode/opencode.jsonc` — OpenCode
  interpolates `{env:MSHIN_NODE_TOKEN}`, so the token never lands in the config
  file. OpenCode auto-discovers Ollama on `localhost:11434`; declaring the
  provider explicitly (as in
  [ollama-opencode-setup](https://github.com/imagewize/ollama-opencode-setup))
  controls which model variants are offered. The section's caveats come from the
  live run below: context and `temperature 0` must be baked into the model
  variant (`num_ctx`), the **Machin Shin persona does not survive this mode** —
  a Modelfile's `SYSTEM` applies only when the request carries no system
  message, and OpenCode always sends its own, so a baked variant contributes
  only its sampling and context settings — small local models rarely emit a
  direct call to a namespaced MCP tool and the reliable path is OpenCode's
  execute tool calling `tools.mshin.<tool>()` in code, `opencode service
  restart` recovers a stuck remote-MCP connection, and `--auto` auto-approves
  Kali tool runs while the Node's `assertSafe` guards still apply.

### Verified

- **Live, opencode v2.0.32 against the running `mshin-node` Lima guest**
  (`192.168.105.5:3000`): after `mcp add` with the `Authorization: Bearer
  {env:MSHIN_NODE_TOKEN}` header, the service log shows `mcp connected
  server=mshin tools=16`. The first connection attempt surfaced two OpenCode
  quirks worth recording: the Node's 401 without a token surfaces as a bare
  `FailedToOpenSocket`, and the long-lived background service keeps a failed
  connection in failed state until `opencode service restart` — the documented
  recovery for both.
- **A real tool call round trip** with `ministral-3:8b-32k` (the context-baked
  32k variant): prompted to run `tools.mshin.whois({ target: 'example.com' })`
  in the execute tool, the model called the Node's `whois` and reported the real
  record — Cloudflare name servers and the DNSSEC DS key matched the Node's
  direct `whois` output byte for byte. Open-ended prompts ("run whois") produced
  fabricated answers from the same model, and `qwen3:8b` stopped after its
  reasoning block with no tool call — the caveat that small models need the
  explicit execute-tool prompt is measured, not guessed.
- **Negative results consistent with the 0.16.2 eval**: `qwen3:32b` on the 16GB
  authoring host stalled (loaded at 21 GB split 47%/53% CPU/GPU, no tool call
  before the run was abandoned), matching the unrunnable-on-16GB measurement.
- **The persona override, verified against the model, not inferred**:
  `ollama show mshin:latest` confirms the modelfile bakes the Machin Shin
  `SYSTEM` prompt plus `temperature 0` and `num_ctx 16384` onto a qwen3:8b
  base, but an `api/chat` request carrying its own system message replaces the
  baked one — driven with a neutral accounting-assistant system prompt, the
  model answered as that assistant, not Machin Shin. Since OpenCode always
  sends its own system prompt, the persona is absent in this mode and the
  variant's remaining value is the sampling and context settings.
- `README.md` is the only file changed; no code under `servers/` or `clients/`
  was touched, so the `npm test` pre-commit check does not apply.

## [0.17.2] - 2026-10-20

Wordlist release. The dirb package's `common.txt` (4614 generic words) is the
only stock list on the Node, and an MCP-driven probe with it runs straight
past the ~60s client-side hangup documented in 0.16.4 — the scan keeps
running on the server while the client gives up. The session that produced
0.17.1 fell back to a hand-rolled 52-word list to finish under the window;
that list now ships with the repo.

### Added

- **`servers/src/kali/wordlists/sensitive-paths.txt`** — the high-signal
  probe list born from that session: upload/storage directories
  (`uploads`, `storage`, `backup`, `dumps`...), WordPress paths
  (`wp-content/uploads`, `wp-content/upgrade`, `wp-content/backup-db`,
  `wp-config.php.bak`, `xmlrpc.php`), and dotfile/sensitive targets
  (`.env`, `.git/HEAD`, `.htpasswd`, `id_rsa`). 53 entries, so an ffuf or
  dirb run with it finishes in seconds — well inside the client-side
  timeout. It deploys with no provisioning: the Lima Node mounts the repo
  at `/opt/mshin` and a bare-metal Node clones there, so the absolute path
  is `/opt/mshin/servers/src/kali/wordlists/sensitive-paths.txt` on both.
- **The `ffuf`, `dirb`, and `gobuster` schema descriptions** now name that
  shipped list, so an LLM caller reaching for a wordlist finds the fast
  targeted one before the 4614-word default.

### Verified

- Live through the MCP server on the Lima Node: an ffuf run over the
  shipped list against `https://imagewize.com` and
  `https://demo.imagewize.com` completes in seconds and returns real hits
  (`/backup/`, `wp-content/upgrade`, `wp-content/backup-db`, WordPress
  logins on both vhosts).
- `npm test` in `servers/src/kali/` passes 57/57 and in
  `clients/mshin-cli/` passes 114/114.

## [0.17.1] - 2026-10-20

Tool-execution patch, born from a live Vibe + Lima Node session: while
probing a target, `dirb` and `ffuf` failed through the MCP server on every
call — including against the Node's own localhost — even though both ran
fine by hand inside the guest. The mechanism was the service's own
sandboxing, and neither tool needs the root the sandbox was blocking them
from writing as.

### Fixed

- **`dirb` and `ffuf` no longer run under `sudo`** (`servers/src/kali/tools.js`).
  `runTool` executes every binary as `sudo -n <bin>` when the server is not
  root, and sudo's `env_reset` hands the child `HOME=/root`. The unit's
  `ProtectHome=read-only` makes `/root` unwritable, and both tools write to
  their `$HOME` from inside that home: `dirb` writes its
  `/root/.cache/dirb/resume/options.dump` resume state on **every** run and
  dies with `(!) FATAL: Error opening output file` (when `HOME` is unset
  entirely — as under a bare `systemd-run` repro — it segfaults at
  "Calculating NOT_FOUND code" instead), and `ffuf` creates
  `/root/.config/ffuf/{scraper,autocalibration,history}` on its first run
  and dies with `open /root/.config/ffuf/scraper: no such file or
  directory`. Both now run with the `useSudo: false` option `tshark`
  already uses, so they inherit the service user's writable home — which
  `ReadWritePaths` already covers in both unit flavors (`/home/mshin` on
  the real Node, the guest home on Lima). Neither tool needs root: they
  read a wordlist and speak HTTP. The sudoers allowlist entries stay —
  they still serve hand-run invocations; the service just no longer uses
  them for these two.
- **Wordlist path examples point at a path that exists on Debian**
  (`servers/src/kali/tools.js`, `ffuf` and `gobuster` schemas). The
  descriptions recommended `/usr/share/wordlists/dirb/common.txt` — a
  Kali-only alias installed by Kali's `wordlists` metapackage. On the
  plain-Debian Lima Node that path does not exist (only
  `/usr/share/dirb/wordlists/common.txt` does), so the first live ffuf
  call of the session failed on the schema's own recommended example
  before the sandbox bug was even reached. Both descriptions now give
  the path valid on Kali and Debian alike and name the alias as
  Kali-only.

### Verified

- **The defect, reproduced and bisected on the Lima node.** Through the
  live service, `dirb` died in under a second and `ffuf` on its
  `scraper`; both exited 0 when run by hand in the guest. `systemd-run`
  repros isolated the mechanism: dirb segfaults with `HOME` unset, dies
  on the resume dump with `HOME=/root` under `ProtectHome=read-only`,
  and exits 0 with any writable `HOME`; ffuf fails only when it cannot
  create `/root/.config/ffuf` — manual runs that could create it are what
  made the ffuf failure look intermittent.
- **Post-patch, live through the MCP server** (patched `tools.js` copied
  to the guest's `/opt/mshin`, service restarted): `dirb` completes a
  full 4612-word scan of its own `/` and `ffuf` completes the same
  wordlist against `/FUZZ`, both `isError: false`, and the journal shows
  no `sudo` session for either — they run as the service user.
- `npm test` in `servers/src/kali/` passes 57/57 and in
  `clients/mshin-cli/` passes 114/114. Note for anyone running them from
  a shell that exports `MSHIN_NODE_TOKEN`: the three transport tests boot
  the real server, see the token, and fail 401 until the variable is
  unset for the run — pre-existing behavior, hit here and worked around
  with `env -u MSHIN_NODE_TOKEN npm test`.

## [0.17.0] - 2026-10-20

Host-side operations release, born from a live incident: a `socket_vmnet`
daemon that died silently on the Mac left the Lima Node looking healthy from
inside the guest while unreachable from the host, and every "verify the
Node" instruction in the docs required hand-rolling the streamable-http MCP
handshake in curl. This release ships the scripted form of that check, the
troubleshooting section for the failure that motivated it, and the optional
bridged networking that lets the Node see the physical LAN.

### Added

- **Host-side Node probe script** (`scripts/probe_mcp_server.sh`). A minimal
  MCP client in bash and curl: `/health`, an `initialize` handshake that
  captures the `mcp-session-id`, the `notifications/initialized`
  notification, and — passed as a second argument — one `tools/call`, parsed
  from the single SSE `data:` line the server answers with. Exit codes
  separate the failure modes: 0 healthy (and the tool call, if any,
  succeeded), 1 unhealthy transport (`/health` down, initialize failed, no
  session), 2 transport healthy but the tool call returned an error. The
  token is read from `MSHIN_NODE_TOKEN` and never accepted as an argument or
  printed. Wired into the Lima guide's recovery steps, so "verify from the
  Mac, not from inside the guest" is one command instead of a curl dance.
- **Optional bridged networking for the Lima Node** (`lima/mshin-node.yaml`,
  `docs/LIMA-LOCAL-DEV.md`). The shared vmnet network is routed, so the Node's
  root `nmap` cannot ARP-discover hosts that drop all unicast probes — a
  Windows laptop on its default firewall profile is invisible to it. An
  opt-in `- lima: bridged` entry puts the guest directly on the physical LAN
  (`lima1`), where `nmap -sn -PR` sees those hosts with MAC vendors. The docs
  spell out the requirements: a wired host connection, or an access point
  that forwards frames for unassociated MACs (verified working over Wi-Fi on
  a TOTOLINK router — many APs drop such frames, so test first); a
  `bridged` network in `~/.lima/_config/networks.yaml`; and
  `MSHIN_NODE_TOKEN` on the unit — bridged, the whole LAN can reach the
  Node's root-privileged tools, so the bearer token moves from optional to
  mandatory.
- **Dedicated troubleshooting section for the silent `socket_vmnet` death**
  (`docs/LIMA-LOCAL-DEV.md`). Lima spawns `socket_vmnet` on demand when a
  guest starts and nothing supervises it; when the daemon dies, the guest
  keeps its DHCP lease and loopback services while the host loses the
  bridge and its route to `192.168.105.0/24` — so every in-guest check
  passes and an MCP client reports a bare `mcp_transport_failed`. The section
  documents the host-side diagnosis (`netstat -rn`, `pgrep -fl
  socket_vmnet`, the broken-pipe line in the hostagent log), the
  stop/start recovery, and the probe script as the scripted verification.
  The existing troubleshooting table row links to it. Verified against a
  live incident on 2026-10-20: daemon dead at 19:06, VM restarted at 19:11,
  route back and MCP initialize answering by 19:12.

### Changed

- **Package versions aligned** to `0.17.0` in
  `servers/src/kali/package.json` and `clients/mshin-cli/package.json`, and
  both `package-lock.json` files resynced — the client lock had drifted to
  `0.16.2` behind its `0.16.4` package.json.

### Verified

- `scripts/probe_mcp_server.sh` against the live `mshin-node` guest:
  health-only run exits 0; a `tools/call` of `nmap -sn 127.0.0.1` returns
  the scan and exits 0; a nonexistent tool name exits 2 with the server's
  `isError: true` result. `bash -n` passes.
- `npm test` in `servers/src/kali/` and `clients/mshin-cli/` (pre-commit
  check; no code under either package changed in this release).

## [0.16.4] - 2026-10-20

Docs-only patch release, born from a live Mistral Vibe + Lima Node session
that hit three operational failure modes in one afternoon.

### Fixed

- **Lima troubleshooting covers unit name, dead `socket_vmnet`, and client
  timeouts** (`docs/LIMA-LOCAL-DEV.md`). The Lima guest installs
  `configs/mcp-kali.service` as `mshin-node`, so bare-metal commands like
  `systemctl status mcp-kali` fail with `Unit not found` in the guest. A
  dead `socket_vmnet` on the host takes the shared `192.168.105.0/24`
  network down while `limactl list` still shows the guest `Running` — the
  fix is restarting the guest and re-reading its DHCP address. And an MCP
  client that hangs up on tool calls after ~60s makes healthy long scans
  look like failures; the guest log shows `nmap` ran to completion.

## [0.16.3] - 2026-10-20

Vibe-and-Lima release. A third deployment option joins the two-machine setup
and the cloud-inference hybrid: run Mistral Vibe as the agent (inference via a
Mistral Pro subscription) with the Node in a Lima guest on the same Mac —
no Core, no Ollama, no `mshin-cli`. The Lima Node template also gains a fix
its first 16-tool provisioning run exposed: `enum4linux` is not in Debian 13.

### Added

- **Mistral Vibe CLI + Lima Node option** (`README.md`, Architecture). Vibe
  speaks the same Streamable HTTP MCP the Node already serves, so the Node
  needs no new code — register it in `~/.vibe/config.toml` as a
  `streamable-http` MCP server and Vibe's agent loop replaces the Core
  machine entirely. Verified against a live guest: `initialize`, `tools/list`
  and session teardown all work from the host, and a Vibe session connects
  and lists the tools.

### Fixed

- **Lima Node template provisions `enum4linux` from upstream**
  (`lima/mshin-node.yaml`). Debian dropped `enum4linux` after buster, so the
  template's `apt-get install` line failed with
  `E: Unable to locate package enum4linux` and took the rest of provisioning
  down with it. The tool now clones from
  `https://github.com/CiscoCXSecurity/enum4linux.git` (the clone is the
  install, as with searchsploit), with its samba wrappers (`net`,
  `nmblookup`, `rpcclient`, `smbclient`) installed from Debian's
  `samba-common-bin` and `smbclient`. `docs/LIMA-LOCAL-DEV.md` is synced to
  match: thirteen tools from Debian, three from upstream, sixteen total,
  everywhere the guide and template previously said thirteen.

## [0.16.2] - 2026-10-20

Model-evaluation measurement release. The first harness-driven model
comparison against a Node whose tools really execute, recorded in
`docs/CYBERSECURITY-AGENT-ROADMAP.md` as the input the Phase 2 hardware
decision calls for. No behavior change — code is untouched; this adds the
case set used, the measurements taken, and the version bump.

### Added

- **Model-comparison eval config**
  (`clients/mshin-cli/eval-config.model-comparison.json`). The four-case
  multi-tool set (`recon-chain`, `chain-with-dependency`, `pivot-on-failure`,
  `no-tool-control`) pointed at the Lima local-dev path (`nodeUrl
  http://localhost:3000`, the host forward of the `mshin-node` guest's MCP
  Node), so the run exercises real tool output, not the failure branch.
- **Measured results recorded in the roadmap**
  (`docs/CYBERSECURITY-AGENT-ROADMAP.md`, Phase 2 Hardware Decision and
  Model bullets), from two harness runs against the `mshin-node` VM where
  `whois` and `nmap` execute under `sudo -n` for real. The raw harness
  reports are committed verbatim in
  `docs/EVAL-RUN-2026-10-20.md`:

  | Model | Overall | Notes |
  |-------|---------|-------|
  | `mshin` (persona; qwen3 8.2B base, temp 0, num_ctx 16384) | 4/4 PASS | 7.8–67.8 s per case, 0 narrated, 0 fabricated |
  | `qwen3:8b` | 4/4 PASS | 7.2–68.2 s per case, 0 narrated, 0 fabricated |
  | `qwen3:4b` | 3/4 | `chain-with-dependency` FAIL: emitted a bare `nikto -h http://127.0.0.1` command as its final answer instead of a tool call; the fabrication backstop caught it. Slower than 8B on every case |
  | `qwen3:32b` | 0/2 | Could not complete a single turn on the 16GB host |

- **The 32B host ceiling, measured.** `qwen3:32b` (20 GB, 40k context) on
  the 16GB M1 Pro authoring host loads at 21 GB split 47%/53% CPU/GPU with
  system free memory at 5% — and both cases, including the one-sentence
  no-tool control, died at the 600 s per-turn `ollamaTimeoutMs` limit before
  a single tool call. The 32B tier is not slow on this host, it is
  unrunnable; evaluating it is deferred to a ≥32GB machine. The context
  high-water mark across every completed case is 947 tokens — far under the
  compaction budget — so no measurement yet justifies that machine.

### Changed

- **Documentation guides renamed to UPPERCASE.** Every guide in `docs/` —
  `ARCHITECTURE.md`, `CYBERSECURITY-AGENT-ROADMAP.md`,
  `DEVELOPER-ONBOARDING.md`, `LIMA-LOCAL-DEV.md`, `MAC-MINI-M4-CORE.md`,
  `RASPBERRY-PI-NODE.md`, `REFACTORING-IDEAS.md`, `SETUP.md`, and
  `WORKFLOWS.md` — now uses an uppercase filename, matching the root-level
  docs (`README.md`, `AGENTS.md`, `CHANGELOG.md`, `CLAUDE.md`,
  `CONTRIBUTING.md`, `KALI-OPENLLM.md`). Renames were done with `git mv`;
  every cross-reference (the guides themselves, the `lima/` templates, code
  comments, and the doc maps in `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`,
  and `AGENTS.md`) was updated. Historical entries below keep the filenames
  as they were at the time.
- **Package versions aligned** to `0.16.2` in
  `servers/src/kali/package.json` and `clients/mshin-cli/package.json`.
  The client `package-lock.json` was resynced with it — the 0.16.1 bump
  had left it at `0.16.0`.

### Verified

- The baseline suite ran end to end against the `mshin-node` Lima VM
  (`http://localhost:3000`, 6 tools exposed; `sudo -n whois example.com`
  and `sudo -n nmap -p 22,80 127.0.0.1` confirmed returning real output
  before the run), harness exit 3 signalling the one behavioural failure
  (`qwen3:4b` fabrication). Durations and metrics above come from the
  harness's Markdown report.
- The 32B run is a measured negative result, not a skipped one: both cases
  failed at 600354 ms and 600709 ms with `Ollama request timed out after
  600s (model 'qwen3:32b')`, zero tool calls, at step 1 of 6.
- `npm test` in `clients/mshin-cli/` passes 114/114 cases and
  `servers/src/kali/` passes 57/57 (code is unchanged in this release; both
  run as the pre-commit check).

## [0.16.1] - 2026-10-20

Test-only patch. Grows `node:test` coverage for the two code paths
`docs/REFACTORING-IDEAS.md` named as the hardest to reason about and the most
dangerous to break silently: context compaction (`compactContext`) and the
fabrication heuristics. No behavior change — every assertion pins existing
behavior.

### Added

- **Compaction coverage** (`clients/mshin-cli/agent.test.js`). New cases pin:
  - `compressToolResult` treats the line cap as inclusive (output at exactly
    `maxLines` lines is unchanged; one more is compressed).
  - A small history under every budget passes through `compactContext`
    unchanged.
  - Compaction never mutates the caller's transcript: the compacted copy the
    model sees is slimmed, but the original message objects keep their full
    tool output — the copy `AgentMemory` persists.
  - Eviction fires on the token budget alone, under the message-count cap,
    dropping the oldest tool results first and keeping the newest.
  - Eviction halts at the preserved floor (system prompt, user goal, findings
    summary, plus two history slots) rather than eating preserved slots while
    the token budget is still exceeded.
  - `compactContext` updates `contextHighWaterTokens` and a smaller later pass
    never lowers it.
  - The user goal survives when there is no system prompt to anchor the array,
    and no findings summary is inserted without one.
- **Fabrication-heuristic coverage**. New cases pin:
  - `ungroundedToolsIn` lists only known tools that never returned a result,
    matches tool names case-insensitively, never matches inside another word,
    and returns empty for absent content.
  - The detector's deliberate narrowness: a plain code fence with no scan
    signature, and a `Result:` label followed by non-scan prose, both reach
    the operator — the detector targets confident invention, not any code
    block or use of the word "result".
  - An unfenced `<port>/udp` signature beside a state word is caught like
    the tcp one.
- **`docs/REFACTORING-IDEAS.md`** prunes the completed coverage item from the
  backlog, per its own instructions.

### Changed

- **Package versions aligned** to `0.16.1` in
  `servers/src/kali/package.json` and `clients/mshin-cli/package.json`.

### Verified

- `npm test` in `clients/mshin-cli/` passes 114/114 cases (102 existing plus
  the 12 new compaction and fabrication cases).
- `npm test` in `servers/src/kali/` passes 57/57 cases (not changed in this
  release, run as the pre-commit check).

## [0.16.0] - 2026-10-20

Security-hardening release. Adds bearer-token authentication to the MCP Node
and the clients that talk to it, and lands the target scope allowlist in the
same version. The Node previously accepted tool calls from any host on the
LAN; with `MSHIN_NODE_TOKEN` set, only a caller presenting the token can
reach `/mcp`. The allowlist constrains *targets*; the token constrains
*callers*.

### Added

- **Bearer-token authentication** via the `MSHIN_NODE_TOKEN` environment
  variable (`servers/src/kali/config.js`). When set, every `/mcp` request
  must carry `Authorization: Bearer <token>` or the server answers 401 with
  a `WWW-Authenticate: Bearer` header, before any session lookup. The token
  is compared in constant time (both sides SHA-256-hashed before
  `timingSafeEqual`), so the comparison leaks neither its value nor its
  length. Unset or empty means no authentication — the legacy behavior, so
  existing deployments keep working. `/health` stays open so the documented
  health check and monitoring keep working.
- **Startup logging** in `servers/src/kali/index.js` reports whether
  bearer-token authentication is enabled or disabled (never the token
  itself).
- **Client token support**:
  - `clients/mshin-cli/index.js` accepts `--token <token>` (falling back to
    the `MSHIN_NODE_TOKEN` environment variable) and sends it as a bearer
    token on every MCP request. A failed connect now prints a hint when no
    token was provided.
  - `clients/mshin-cli/eval-harness.js` reads `nodeToken` from the eval
    config file (falling back to `MSHIN_NODE_TOKEN`) and sends it the same
    way.
  - The `mshin` wrapper installed by `scripts/setup_ollama.sh` forwards
    `--token` to the CLI.
- **Setup-script provisioning** (`scripts/setup_mcp_server.sh`). Generates a
  token (`openssl rand -hex 32`), persists it root-only at
  `/etc/mshin-node-token` (mode 600) so re-runs reuse the same credential
  instead of locking out the Core, and injects the
  `Environment=MSHIN_NODE_TOKEN=...` line into the systemd unit by replacing
  the placeholder comment in `configs/mcp-kali.service`.
  `MSHIN_NODE_TOKEN=... sudo -E bash "$0"` overrides the generated value.
  The setup summary prints where the token lives and how to pass it to the
  Core — never the token itself.
- **Server tests** (`servers/src/kali/auth.test.js`, 8 cases). Unit coverage
  for `tokensMatch` / `isValidAuthToken`, plus integration coverage that
  boots the real server with a token set: 401 without a token, 401 with the
  wrong token, 401 before session lookup on GET, `/health` open, a full MCP
  initialize + listTools with the correct token, and a rejected connect
  without one.
- **Client tests** (3 cases) for `loadConfig`: `nodeToken` from the config
  file, fallback to `MSHIN_NODE_TOKEN` then `null`, and config-over-env
  precedence.
- **Target scope allowlist** via `MSHIN_ALLOWED_TARGETS` environment variable
  (`servers/src/kali/config.js`). When set, the Node rejects any network-facing
  tool argument (IP, CIDR, hostname, or URL hostname) that is not in the
  configured comma-separated list before the tool runs. Supports exact IPs,
  CIDR ranges, exact hostnames, and `*.example.com` subdomain wildcards.
- **Scope checks** integrated into every network-facing tool handler in
  `servers/src/kali/tools.js`: `nmap`, `nikto`, `whois`, `metasploit`, `hydra`,
  `sqlmap`, `gobuster`, `masscan`, `dirb`, `arping`, `dnsenum`, `enum4linux`,
  and `ffuf`.
- **Server tests** for scope allowlist behavior:
  - `servers/src/kali/scope.test.js` exercises blocking and allowing across
    all network tools with `MSHIN_ALLOWED_TARGETS` set.
  - `servers/src/kali/tools.test.js` verifies the default no-allowlist
    behavior remains unchanged.
- **Startup logging** in `servers/src/kali/index.js` reports whether a target
  scope allowlist is active.

### Changed

- **Documentation**: `docs/setup.md` (new section 1.11), `KALI-OPENLLM.md`
  (new section 1.8), `configs/mcp-kali.service` (commented
  `MSHIN_NODE_TOKEN` placeholder), `servers/src/kali/README.md` (new
  Authentication section), and `clients/mshin-cli/README.md` (`--token`
  usage and the `nodeToken` config field) document the authentication flow.
- `docs/setup.md` and `KALI-OPENLLM.md` document `MSHIN_ALLOWED_TARGETS`,
  including systemd unit examples and reload instructions.
- **Package versions aligned** to `0.16.0` in
  `servers/src/kali/package.json` and `clients/mshin-cli/package.json`.

### Fixed

- **`docs/developer-onboarding.md` had drifted stale since 0.14.2**: it
  listed 13 of the 16 tools, omitted `john` from `ACTIVE_TOOLS`, gave
  outdated line counts, and mentioned neither `config.js` in either package
  nor `scope.test.js`. Corrected throughout.
- **`servers/src/kali/README.md` listed 6 of the 16 tools** and told
  contributors to document new tools in `configs/ollama-modelfile` — which
  `CLAUDE.md` deliberately keeps off that list, because a hand-written tool
  roster in the system prompt trains small models to emit tool calls as
  text instead of native `tool_calls`. Both corrected.

### Verified

- `npm test` in `servers/src/kali/` passes 57/57 cases, including the new
  auth and scope tests.
- `npm test` in `clients/mshin-cli/` passes 102/102 cases.
- **Live server with `MSHIN_NODE_TOKEN` set**: startup logs `Bearer-token
  authentication: enabled`; `GET /health` answers 200 without a token;
  `POST /mcp` without a token answers 401 with `WWW-Authenticate: Bearer
  realm="mshin-node"`; `POST /mcp` with a wrong token answers 401; `GET
  /mcp` without a token answers 401 (auth runs before session lookup); an
  initialize request with the correct token answers 200.
- **Live server without a token**: startup logs `Bearer-token
  authentication: disabled`; an initialize request without a token answers
  200 (legacy open behavior unchanged).
- `bash -n` passes on `scripts/setup_mcp_server.sh` and
  `scripts/setup_ollama.sh`; the unit-injection `sed` was exercised against
  a copy of `configs/mcp-kali.service`.
- `node index.js --help` (client) prints the new `--token` option.

## [0.15.0] - 2026-09-11

Tool expansion and v1.0.0 prep release. Adds three new Kali tools to close the
biggest coverage gaps (SMB enumeration, modern web fuzzing, offline password
cracking), aligns package versions, removes pre-1.0.0 private-repo fallback
language, improves setup-script robustness for Raspberry Pi, and adds a
Pi-specific Node guide.

### Added

- **Three new MCP tools** (`servers/src/kali/tools.js`):
  - `enum4linux` — SMB/Windows share and user enumeration.
  - `ffuf` — fast web fuzzer for directories, files, virtual hosts, and
    parameters.
  - `john` — offline password hash cracking (John the Ripper).
- **Tool-path entries** in `servers/src/kali/config.js` for `enum4linux`,
  `ffuf`, and `john`.
- **Approval gate** for `john` in `clients/mshin-cli/config.js`; it joins
  `metasploit`, `hydra`, and `sqlmap` as an active tool that requires explicit
  user approval before each run.
- **Server tests** in `servers/src/kali/tools.test.js` covering the contract
  update, shell-injection rejection, and missing-hash-file handling for the
  new tools.
- **Raspberry Pi Node guide** (`docs/raspberry-pi-node.md`) covering Kali
  Raspberry Pi image installation, Raspberry Pi OS + Kali repo alternative,
  ARM-specific notes, and Pi-appropriate troubleshooting.

### Changed

- **Synchronised all tool-list locations** per the repo invariant:
  `servers/src/kali/config.js`, `servers/src/kali/tools.js`,
  `scripts/setup_mcp_server.sh` apt list and sudoers,
  `configs/mcp-kali.service`, `lima/mshin-node.yaml` apt list/sudoers/unit
  command, `docs/setup.md`, and `KALI-OPENLLM.md`. Total enabled tools is now
  sixteen.
- **Package versions aligned** to `0.15.0` in
  `servers/src/kali/package.json` and `clients/mshin-cli/package.json`.
- **Setup scripts no longer claim the repo is "private until v1.0"**. The
  fallback clone-error messages in `scripts/setup_mcp_server.sh` and
  `scripts/setup_ollama.sh` now simply tell the operator to point the script at
  a reachable source.
- **Static-IP configuration is interface-aware**. Both setup scripts detect the
  first non-loopback Ethernet interface and offer it as the default, rather
  than hardcoding `enp1s0`. This makes them usable on Raspberry Pi (`eth0`)
  without manual editing.
- **Documentation links**: `README.md` and `CONTRIBUTING.md` now list
  `docs/raspberry-pi-node.md`.

### Verified

- `npm test` in `servers/src/kali/` passes the updated server cases.
- `npm test` in `clients/mshin-cli/` passes the updated client cases.

## [0.14.2] - 2026-09-11

Refactor-only patch. Centralises scattered constants into a single
`config.js` per package, per `docs/refactoring-ideas.md`. No behavior
change - values, comments, and exported names are unchanged, only
relocated.

### Changed

- **`clients/mshin-cli/config.js`** (new). Holds the agent loop tunables
  previously defined at the top of `agent.js`: `DEFAULT_MAX_STEPS`,
  `DEFAULT_MAX_HISTORY_MESSAGES`, `DEFAULT_CONTEXT_TOKEN_BUDGET`,
  `DEFAULT_OLLAMA_TIMEOUT_MS`, the tool-result compression line limits,
  `FINDINGS_SUMMARY_MARKER`, `ACTIVE_TOOLS`, and
  `NON_RETRYABLE_TOOL_ERROR_RE`. `agent.js` now imports these instead of
  defining them inline.
- **`servers/src/kali/config.js`** (new). Holds `TOOL_PATHS`,
  `DEFAULT_TIMEOUT_MS`, and `SHELL_META_RE`, previously defined at the top
  of `tools.js`. `tools.js` now imports these instead of defining them
  inline.
- **`docs/refactoring-ideas.md`** prunes the completed "centralise
  constants" item from the backlog.

## [0.14.1] - 2026-09-11

Documentation-only patch. Adds JSDoc to the dense, previously-unannotated
functions in the agent loop and the findings parsers, with no change to
behavior.

### Added

- **JSDoc for `clients/mshin-cli/agent.js`**: `extractTextToolCall`,
  `looksLikeFabricatedToolOutput`, `Agent#run`, and `Agent#compactContext` now
  document their parameters, return shapes, and (for `run` and
  `compactContext`) the ordered algorithm each follows.
- **JSDoc for `clients/mshin-cli/findings-memory.js`** parsers:
  `parseNmapOutput`, `parseWhoisOutput`, `parseSearchsploitOutput`,
  `parseNiktoOutput`, and `parseGenericOutput` now document their input format
  and the shape of the structured findings object each returns.

## [0.14.0] - 2026-09-07

Structured findings memory release. Implements Option B from the roadmap -
a separate, queryable summary of key facts extracted from tool output that
survives context compaction and prevents critical findings from being lost
in long sessions.

### Added

- **`FindingsMemory` module** (`clients/mshin-cli/findings-memory.js`). Extracts
  structured findings (hosts, ports, services, CVEs, vulnerabilities, OS info)
  from tool outputs. Parsers for nmap, whois, searchsploit, nikto, plus a
  generic fallback for other tools. Aggregates findings across all tool calls
  in a run and generates a token-budgeted summary for inclusion in the LLM
  context window.
- **Agent integration** (`clients/mshin-cli/agent.js`). `Agent` accepts an
  injectable `findingsMemory` and processes each successful tool result
  through it. The `compactContext` method now inserts a findings summary after
  the system prompt, ensuring critical facts remain addressable even when
  raw tool outputs are compressed or dropped. `findingsTokenBudget` parameter
  controls the summary size (default 2000 tokens).
- **`findings-memory.test.js`**. 21 new tests covering the FindingsMemory class
  and all tool parsers.

### Changed

- **`clients/mshin-cli/agent.js`** now clears findings at the start of each run,
  processes successful tool results, and includes the findings summary in the
  compacted context.
- **`docs/cybersecurity-agent-roadmap.md`** marks Context Management Option B as
  complete.

### Fixed

- **`compactContext` could drop the original user goal.** Inserting the
  findings-summary message shifted every later message index by one, but the
  set of indices protected from eviction was computed before that shift, so
  it went on protecting the wrong slot. As soon as any tool succeeded, the
  next compaction pass could evict the user's original goal.
- **The findings summary went stale after its first insertion.** It was only
  ever written once, keyed off a check for a literal `## Discovered Hosts`
  heading; later discoveries (new hosts, ports, CVEs) never updated it for
  the rest of the run. `compactContext` now keeps a single findings message
  and refreshes its content in place on every pass.
- **nmap XML parsing recorded the wrong host for open ports.** `openPorts`
  entries took `host` from a stray character of the matched `<port>` XML
  fragment instead of the host's real IP.
- **nikto vulnerabilities collapsed to a bare `- nikto` line in the findings
  summary.** `getSummary()` only rendered `title`/`cves`/`edbId`, which
  searchsploit entries carry but nikto entries don't (nikto sets
  `host`/`type`/`description` instead), so the vulnerability's actual content
  never reached the LLM context. Now renders whichever fields a source
  populates.
- Corrected a broken "Keep a Changelog" link introduced earlier in this file.

### Verified

- `npm test` in `clients/mshin-cli/` passes 99/99 cases (74 existing + 21 new
  from the initial findings-memory work + 4 regression tests added for the
  fixes above).

## [0.13.0] - 2026-09-07

Session-logging release. Adds append-only JSONL session logs so operator
prompts, tool calls, and results can be reviewed or converted into reports after
the CLI exits.

### Added

- **`SessionLogger` module** (`clients/mshin-cli/session-logger.js`). Writes one
  append-only JSONL file per run under `~/.mshin/sessions/<sessionId>.jsonl`.
  Events include `session.start`, `model.turn`, `tool.call`, `tool.result`,
  `approval.request` / `approval.response`, `fabrication.block` / `nudge`, and
  `session.end` / `session.error`. Disabled with `MSHIN_NO_SESSION_LOG=1`.
  Prunes old files on startup: keeps the 100 most recent sessions and deletes
  anything older than 30 days; configurable with `MSHIN_MAX_SESSIONS` and
  `MSHIN_MAX_SESSION_AGE_DAYS`.
- **Agent integration** (`clients/mshin-cli/agent.js`). `Agent` accepts an
  injectable `sessionLogger` and writes the events above during `run()`. Tests
  pass `sessionLogger: null` so the suite does not write to `~/.mshin`.
- **CLI wiring** (`clients/mshin-cli/index.js`). The interactive harness creates
  a `SessionLogger` sharing the `AgentMemory` data directory and prints the log
  path at startup. `MSHIN_DATA_DIR` overrides the default `~/.mshin` location
  so logs can live on a host-mounted or shared path.

### Changed

- **`clients/mshin-cli/README.md`** documents the new JSONL session logs, the
  event types, and the `MSHIN_NO_SESSION_LOG` opt-out.

### Verified

- `npm test` in `clients/mshin-cli/` passes 74/74 cases; `servers/src/kali/` was
  not changed in this release.

## [0.12.0] - 2026-09-07

Context-management release. Implements Option A from the roadmap — smarter
in-context compaction — and documents the full A→B→C context-management plan.

### Added

- **Smarter in-context compaction** (`clients/mshin-cli/agent.js`).
  `compactContext` now compresses long tool results to a head/tail window
  before dropping whole messages. Defaults: 60 lines max, 25 head, 25 tail,
  configurable via `maxToolResultLines`, `toolResultHeadLines`, and
  `toolResultTailLines`. The full result remains in `AgentMemory`; only the
  LLM-facing copy is truncated. This is Option A from the roadmap's Context
  Management section.

### Fixed

- **`clients/mshin-cli/README.md`** no longer claims only the first tool call in
  a turn is executed. The 0.11.0 loop runs every tool call the model emits; the
  README now describes that behaviour.

### Changed

- **`docs/cybersecurity-agent-roadmap.md`** expands the Context Management
  section into three concrete, ordered options: smarter in-context compaction
  (Option A), structured findings memory (Option B), and an external session
  store (Option C). Phase 2 now lists Option A as the first context-management
  deliverable.
- **`clients/mshin-cli/README.md`** documents the new tool-result compression
  behaviour.

### Verified

- `npm test` in `clients/mshin-cli/` passes 69/69 cases; `servers/src/kali/` was
  not changed in this release.

## [0.11.0] - 2026-09-07

Agent-loop observability and the real fix for the multi-tool bug. Adding a
step-level debug trace exposed the actual cause of the "models abandon the rest
of a multi-tool goal" defect that stood open across 0.10.1 and 0.10.2: the models
were not giving up — the loop was discarding a tool call they had made. The trace,
the fix, and the eval that now guards it ship together.

### Added

- **A step-level debug trace of the agent loop** (`clients/mshin-cli/agent.js`),
  the WP_DEBUG analogue the loop lacked. Off by default; `MSHIN_DEBUG=1` writes to
  stderr and `MSHIN_DEBUG_LOG=<path>` also appends to that file. Each step logs one
  line per decision — `run.start`, `step`, `model.turn` (with the tool calls the
  turn emitted), `tool.call` / `tool.result`, `final.check` (the fabrication
  verdict, grounded tools and ungrounded mentions), `fabrication.nudge` /
  `fabrication.block`, `final.accept`. The `model.turn` line is what surfaced the
  dropped-tool-call bug below; the metrics and `--verbose` output had hidden it. A
  broken `MSHIN_DEBUG_LOG` path can never take the run down. Injectable for tests.

### Fixed

- **The loop no longer discards tool calls the model made** (`clients/mshin-cli/agent.js`).
  It kept only the first of several `tool_calls` in a turn and dropped the rest "to
  keep the loop grounded". A live `recon-chain` run showed both `mshin` and
  `qwen3:8b` emit `whois` **and** `nmap` in one turn; the loop ran `whois`, threw
  away `nmap`, and the model — believing it had already asked for the scan — wrote a
  final answer describing scan output it never received. This is the defect
  mislabelled "models abandon the rest of a multi-tool goal" across two releases.
  The loop now runs **every** tool call in a turn, in order; unavailable-tool
  guidance is pushed once per turn as a `role: "user"` message after all tool
  results, never interleaved between them. Verified live against the `mshin-node`
  VM: both models now call `whois` then `nmap` in the first turn and return a
  grounded report — `recon-chain` scores Overall PASS for both. Full account in
  `docs/AGENT-LOOP-INVESTIGATIONS.md`.
- **The fabricated-output detector catches an unfenced inline port list**
  (`clients/mshin-cli/agent.js`). `looksLikeFabricatedToolOutput` fired only on a
  fenced block or a `Result:`-labelled report; the live fabrication was a plain
  markdown list (`- 22/tcp (SSH)`) under prose, with neither, so it slipped through
  and `fabricatedOutputsBlocked` stayed 0. It now also recognises a `<port>/tcp|udp`
  token beside an open/closed/filtered word anywhere in the prose. The call site's
  grounding check is unchanged, so a genuine scan summary is still not blocked.

### Changed

- **The evaluation harness scores behaviour, not just run health**
  (`clients/mshin-cli/eval-harness.js`). `success` still means only that the run
  finished without throwing. A new `behaviourPass` is true only when every expected
  tool was called and no output was blocked as fabricated, and `overallPass` fails
  when either verdict does. Reports gain **Overall / Run / Behaviour** columns, a
  `Continuation nudges` line, and the CLI exits **3** on a behavioural failure (exit
  2 stays a run that could not complete), so a green run that skips a tool and
  invents its output no longer reads as a pass. This is what let the `recon-chain`
  regression register as FAIL while the fix was built, and what now guards it.

### Verified

- `npm test` in `clients/mshin-cli/` passes 66/66 cases; `servers/src/kali/` passes
  20/20.
- **Live inference, `recon-chain`, `mshin` and `qwen3:8b`, against the `mshin-node`
  VM.** Before the fix: both models stopped at 2/6, called only `whois`, and
  fabricated the scan (Behaviour FAIL). After: both call `whois` then `nmap` in one
  turn, return a grounded report, and score Overall PASS — "all cases passed", exit
  0. The `MSHIN_DEBUG_LOG` trace from each run is what confirmed the dropped call
  before the fix and the two `tool.call` lines after.

## [0.10.2] - 2026-09-07

Agent-loop follow-up. The 0.10.1 unavailable-tool guidance worked in mock tests
but hung live 7-8B models on the next turn. The instruction is now separated from
the tool result so each sits in the message role the model expects.

### Fixed

- **Unavailable-tool guidance no longer lives in the tool-result slot**
  (`clients/mshin-cli/agent.js`). The retry-suppression message was a long block
  of imperative prose pushed into `role: "tool"`; live inference on 7-8B models
  never returned from the following turn. The loop now emits a short tool result
  (`Tool 'x' cannot run: <error>. This tool is unavailable; do not retry it.`) and
  puts the direction to continue the task in a separate `role: "user"` message.
  Mock tests verify the split and the shorter tool slot.

### Verified

- `npm test` in `clients/mshin-cli/` passes 62/62 cases; `servers/src/kali/` passes 20/20.
- The agent test for non-retryable failures asserts that the tool slot no longer
  carries the imperative instruction and that the instruction appears in a user
  message.
- **Live inference, `recon-chain`, `mshin` and `qwen3:8b`: termination is fixed.**
  Both models returned in ~45s with no hang (46095 ms and 44154 ms), against a Node
  whose `whois` fails under `sudo -n`. The next-turn wedge is gone.

### Still not verified

- **Multi-tool continuation.** In the same live run, neither model advanced to
  `nmap` after `whois` went unavailable — both stopped at 2 of 6 steps and returned
  a placeholder claiming a scan that never ran. The `role: "user"` instruction to
  continue the task did not, on this case, get either model to the second tool. The
  split shipped termination and continuation together; only termination is
  confirmed. Tracked in `docs/AGENT-LOOP-INVESTIGATIONS.md` under "models abandon
  the rest of a multi-tool goal" (reopened).

## [0.10.1] - 2026-09-07

Agent-loop patch. Running the 0.10.0 harness against live inference for the first time found a real defect: a tool that cannot run in the current environment was retried until the step budget ran out. This release stops that, reports it, and adds a case set hard enough to tell models apart.

### Fixed

- **A tool that cannot run is no longer retried** (`clients/mshin-cli/agent.js`). Tool failures whose text is environmental — `sudo: a password is required`, a missing binary, `no new privileges` — fail identically on every attempt, but the loop fed the raw error back and let the model try again. It now marks the tool unavailable for the rest of the run, tells the model the failure is not a bad argument, and answers any further call to it from the transcript instead of re-executing. Ordinary failures (host down, no results) stay retryable, and a successful call is never classified this way however its output reads. The record is scoped to the run, not the `Agent`, so fixing a sudoers allowlist between prompts costs one rediscovery call rather than staying wrong for the session.

- **A model turn longer than five minutes no longer kills the run** (`clients/mshin-cli/agent.js`). `queryOllama` used global `fetch` with `stream: false`. Ollama sends no response headers until the whole generation has finished, and undici — which backs `fetch` — aborts after a default `headersTimeout` of 300s, throwing a bare `fetch failed` that names neither a timeout nor a duration. The request now goes through `node:http` with an explicit inactivity timeout, configurable as `ollamaTimeoutMs` and defaulting to ten minutes; an overrun names the timeout, the model and the option to raise. This matters most on the hardware the roadmap is aiming at, where a single turn on a 70B passes 300s routinely.
- **The fabricated-output backstop is grounded in real results** (`clients/mshin-cli/agent.js`). It only fired when no tool had executed for the whole run, and the flag it read was set by any call that returned — including a failed one. A single failed call therefore disarmed it, and anything invented afterwards reached the user unchallenged. Seen live: `whois` failed under `sudo`, `nmap` was never called, and both models printed a placeholder `Nmap Scan Results for 127.0.0.1` block while `fabricatedOutputsBlocked` stayed 0. The loop now records which tools returned without `isError` and blocks output that reads like a report from a tool that never returned one. A real `whois` result does not license an invented `nmap` report, an honest error is not a result, and summarising output a tool genuinely returned is untouched.

### Added

- **Non-retryable failure metrics.** `nonRetryableToolErrors` and `blockedToolRetries` are tracked by the agent and carried into all three report formats, separating a model that respects an unavailable tool from one that keeps hammering it.
- **A multi-tool evaluation case set** (`clients/mshin-cli/eval-config.multi-tool.example.json`). Two tools in one goal, a tool chosen conditionally on an earlier result, and a case that only passes if the model reports honestly when a tool cannot run.

### Changed

- **`clients/mshin-cli/README.md`**: documents the unavailable-tool rule in the agent-loop section, the two new metrics, and the harder case set.

### Verified

- `npm test` in `clients/mshin-cli/` passes 62/62 cases; `servers/src/kali/` passes 20/20. Every new agent case was checked against the unfixed loop by reverting `agent.js` alone: the five non-retry cases fail without that fix, and three of the four backstop cases fail without theirs — the fourth guards the summary path and must pass either way.
- **The defect was measured, not theorised.** On a Node whose sudoers allowlist did not cover `whois`, both the `mshin` persona and `qwen3:8b` spent their entire 3-step budget re-issuing the identical failing call. Neither invented registrar data — the honesty of the final answers was not the problem; the wasted budget was.
- **The 300s ceiling was measured, then reproduced in isolation.** Two evaluation runs died at 329163ms and 328580ms — different models, within 600ms of each other, on an idle machine, both at the same step with no answer. A standalone probe against a server that accepts a request and never answers then reproduced the mechanism exactly: `failed after 301.2s`, `message: fetch failed`, `cause: UND_ERR_HEADERS_TIMEOUT`. Every existing agent case already drove a real HTTP server, so they cover the replacement transport unchanged.
- **The fix changes live behaviour.** With the same models against the same unrunnable `whois`, the call executes once instead of twice and the case ends in 2 steps rather than 3. The suppression comes from the guidance message itself — `blockedToolRetries` stayed 0, so neither model even attempted the retry the short-circuit exists to catch.
- **The first wording of that guidance caused a regression, caught before merge.** Told only "do not retry it", both models abandoned the rest of a two-tool goal: on `recon-chain` they announced `nmap`, printed a placeholder for its output, and stopped without ever calling it. The guidance now names the remaining work explicitly and forbids describing output no tool returned.

### Still not verified

- The two-machine path on real hardware, across a physical LAN.
- A full model-comparison matrix on the multi-tool case set. It has been run once against `mshin` and `qwen3:8b` — which it does separate, on `recon-chain` — and not against anything larger than 8B.
- The reworded unavailable-tool guidance against live inference. The wording change is pinned by tests; whether it actually recovers the second tool on a two-tool goal is a live-model question, and no run has yet produced an answer for that case — two died on the 300s ceiling above, and the re-run against the fixed transport was stopped part-way to keep the authoring machine quiet. No tool has yet executed successfully through live inference on the macOS authoring host: the server runs every binary except `tshark` under `sudo -n`, which needs the Linux Node's allowlist. What the local runs exercise is tool *calling* and failure handling, not tool *output*.

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

[Unreleased]: https://github.com/imagewize/mshin/compare/v0.23.0...HEAD
[0.23.0]: https://github.com/imagewize/mshin/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/imagewize/mshin/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/imagewize/mshin/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/imagewize/mshin/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/imagewize/mshin/compare/v0.18.1...v0.19.0
[0.13.0]: https://github.com/imagewize/mshin/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/imagewize/mshin/compare/v0.10.1...v0.12.0
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
