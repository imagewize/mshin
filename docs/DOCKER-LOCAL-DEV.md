# Machin Shin Local Development with Docker

> *"The stone that sits in one place all its life is still a stone; the stone carried down the river becomes smooth. Be the river's stone, not the field's."*

This guide describes how to run a **local, single-machine Machin Shin development environment** with the Node in a **Docker container** and **Ollama native on the macOS host**. It is the default local path — the same `configs/Dockerfile` and `configs/compose.yaml` that run here also run the Node on a real Linux box or a VPS, unchanged.

For the Lima-VM alternative, see [Lima Local Dev](LIMA-LOCAL-DEV.md) — it is no longer the default local path, but it remains the way to emulate the **production shape** (systemd unit, Debian host, bridged LAN access).

> **Plain rule for LAN work on a Mac:** the Docker Node cannot see your physical LAN and will not pretend to (it refuses fabricated discovery results — see Troubleshooting). For **discovery on your own network**, use the Mac itself (`scripts/lan_inventory.sh`) or the bridged Lima Node (`scripts/setup_bridged_node.sh`); keep this Docker Node for **evals, internet-facing targets, and targeted scans of hosts already known live**. Docker is the deployment artifact; Lima is the LAN vantage point.

---

## Overview

| Aspect | Full setup | Docker local dev |
| ------ | ---------- | ---------------- |
| Machines | 2 physical boxes | 1 macOS host |
| Core | Separate machine, 32GB+ RAM | Native Ollama on the Mac (7–8B model tier) |
| Node | Kali on its own box | `mshin-node` container, all 17 tools |
| Cost | ~$150–350 (the Node) | $0 (uses existing Mac) |
| Portability | — | The **same compose files** run on a Linux Node or VPS |
| Sandbox | The Node machine is the boundary | Plus container isolation: dropped capabilities, read-only rootfs |

> **When to use this:** developing the MCP server, testing workflows, running the eval harness, driving the Node from Vibe/OpenCode/the CLI. **When NOT to use this:** scanning your physical LAN (Docker Desktop's network is the Docker VM's, not the Mac's), or emulating the production systemd shape (use Lima for that).

### Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  macOS HOST                                                        │
│                                                                    │
│  Ollama (native) :11434       agent: CLI / Vibe / OpenCode         │
│         ^                              |                          │
│         |_________ MCP :3000 <_________|                          │
│                    |  (configs/compose.local.yaml publishes :3000) │
│  ┌─────────────────v───────────────────────────────────────────┐  │
│  │ Docker Desktop VM ── mshin-node container                  │  │
│  │  17 Kali tools • cap NET_RAW/NET_ADMIN • read-only rootfs   │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Performance: Lima vs Docker, measured

The obvious question before swapping Lima for Docker: does the container make the tools slower? Measured on the same 16GB Apple Silicon Mac, same day, same image, same capability set — nmap is the tool that most depends on raw sockets and kernel networking:

| Workload | Lima guest, native (`sudo -n`, no Docker) | Docker container inside Lima guest | Docker Desktop container (Mac) |
| --------- | ------------------------------------------ | ---------------------------------- | ------------------------------ |
| `nmap -sS -p-` full-port localhost scan (3 runs) | 0.37 / 0.37 / 0.38 s | 0.39 / 0.40 / 0.42 s | 0.40 / 0.40 / 0.41 s |
| `openssl speed` aes-256-cbc @8192B | 1,057 MB/s | 1,093 MB/s | 1,120 MB/s |
| Full MCP round trip: `nmap -sV -p 22,3000` through `tools/call` | 11.32 s | 11.21 s | 11.30 s |

**Verdict:** the native Lima guest is ~5–8% faster on the raw localhost microbenchmark — 30 ms on a 0.4 s scan — and that is the whole difference. On the realistic workload (the MCP round trip with service detection, 11.3 s) the three paths tie within noise: tool time is dominated by nmap's probes, not by the container's namespace layer. Both stacks are Linux VMs behind Apple's Virtualization.framework; there is no meaningful speed argument for Lima, and on a real Linux host or VPS the VM layer disappears entirely, leaving only the namespace overhead.

That is why Docker is the deployment artifact: one image from laptop to VPS.

---

## Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| Docker Desktop (or any Docker 24+) | Verified against daemon 29.8.2 on Apple Silicon |
| ~10 GB disk | The image with all 17 tools is ~3.1 GB |
| Apple Silicon or x86_64 | The image builds natively on both; `FROM kalilinux/kali-rolling` is multi-arch |
| Ollama (native) | For the Core side — see [Lima Local Dev](LIMA-LOCAL-DEV.md)'s model guidance (7–8B tier on 16 GB) |

## Setup

```bash
# 1. The token file. Compose refuses to start without it — fail-closed,
#    because an unauthenticated Node with host networking is drivable by
#    anyone on the LAN. The helper writes the same token to the Node env file
#    and to the client credential files so they stay in sync.
scripts/setup_mcp_auth.sh
# Optional, recommended: pin the target scope
echo 'MSHIN_ALLOWED_TARGETS=127.0.0.1,::1' >> configs/mshin-node.env

# 2. Build (no token needed at build time)
docker compose -f configs/compose.yaml build

# 3. Up. On macOS, include the local override (see below); on a Linux
#    host or VPS, drop it — host networking is what you want there.
docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d

# 4. Verify
curl http://localhost:3001/health
```

If you already have tokens scattered in different places, run
`scripts/setup_mcp_auth.sh --check` to see where they differ, then re-run
without `--check` to synchronize them.

**The local override:** Docker Desktop does not publish `network_mode: host` services to the Mac — `host` there is the Docker VM's network, so nothing answers on the Mac's `localhost:3000`. `configs/compose.local.yaml` switches to bridge networking and publishes `3001:3000` for macOS; the base file keeps host networking for Linux Nodes and VPSes, where the tools must reach the LAN from the host's own IP. Port `3001` is chosen deliberately: Lima's automatic port forwarding silently claims `localhost:3000` when a `mshin-node` guest is running, and changing the Docker published port avoids that collision entirely.

## Usage

The MCP surface is identical to any other Node: point the CLI (`--mcp-url http://localhost:3001/mcp --token <value>`), Vibe, or OpenCode at `localhost:3001`. Verified in this environment: `tools/list` exposes all seventeen tools, a `tools/call` round trip to `nmap` returns real scan output (11.3 s), and `POST /mcp` without the token answers 401.

Two client-specific gotchas that keep appearing in issues:

- **OpenCode must have `oauth: false`** for this server. OpenCode treats every
  remote MCP server as OAuth by default; without `oauth: false` it keeps asking
  you to sign in even though the Node only wants a static bearer token. The
  `setup_mcp_auth.sh` helper prints the correct `opencode.jsonc` snippet.
- **Vibe reads the token from `~/.vibe/.env`.** Editing `config.toml` is not
  enough: `api_key_env = "MSHIN_NODE_TOKEN"` tells Vibe the variable name, but
  the value must be in `~/.vibe/.env` (or exported in the shell that starts
  Vibe). The helper writes it there; restart Vibe after running it.

What the sandbox changes relative to a bare-metal Node:

- **No sudo.** Tools run as root *inside* the container; the sudoers allowlist does not exist in this mode, and the tshark/dirb/ffuf sudo exceptions in `tools.js` are moot.
- **Capabilities, not host root.** `cap_drop: ALL` plus `NET_RAW`/`NET_ADMIN` in `compose.yaml` — a bad flag or a hijacked prompt trashes a disposable container, not the host filesystem.
- **Nothing persists.** The rootfs is read-only; writable state is a `/tmp` tmpfs (msfconsole's first-run init, sqlmap output, resume dumps all land there and die with the container).
- **File-taking tools have no host files.** `tshark`, `john`, `sqlmap` see only the container's filesystem. Mount a volume in `compose.local.yaml` if you need to feed them files.

The eval harness (`clients/mshin-cli/eval-harness.js`) and its case sets work against this Node unchanged — the transport is the same Streamable HTTP. The full model-comparison suite **was re-run against the Docker Node on 2026-10-21** (see [Eval Run 2026-10-21](EVAL-RUN-2026-10-21.md)): the 8B tier scores 4/4 on both models, identical to the Lima baseline, with zero fabricated outputs — the sandbox is a drop-in Node for the harness. One wall-clock caveat: `nikto`'s ~8000 requests through the bridge/published-port path are slower than a guest-local path (~40 s per affected case); scores are unaffected.

---

## Troubleshooting

**`localhost:3001` is the Docker Node; `localhost:3000` may be the Lima guest.** This guide's macOS override publishes the container on `3001` so a running Lima `mshin-node` guest cannot steal `localhost:3000` via its automatic port forwarding. If you changed the override back to `3000:3000` and a Lima guest is running, the request reaches the *guest's* systemd Node (with *its* token), not your container — fix: `limactl stop mshin-node`, then `docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d --force-recreate`. This collision is measured behavior, not speculation — it cost an hour of confused 401s during this guide's own verification.

To see who is actually listening on port 3001: `lsof -i :3001` (macOS) or `ss -ltnp | grep 3001` (Linux). Port 3000 held by `limactl` is your Lima guest.

To see whether your tokens are out of sync: `scripts/setup_mcp_auth.sh --check` compares the Docker env file, Vibe env file, OpenCode env file, and the current shell.

**Host discovery from the container reports every address as up.** Measured on this setup: `nmap -sn <LAN>/24` through the bridge override returned all 256 addresses "up" with sub-millisecond latencies — Docker Desktop's NAT answers discovery probes on behalf of every address, dead or alive, so an "up" verdict from inside the container means nothing. Targeted scans of genuinely live hosts are faithful (a scan of the LAN gateway matched a native scan byte-for-byte, banners included), but you cannot tell live from dead from inside. **The Node now refuses to return such results:** an `nmap -sn` against a CIDR where every single address answered fails with `Refusing to return a fabricated discovery result` instead of handing back a fake host list.

Get the host list from something with a real network position:

```bash
# Cross-platform: macOS, Windows, Linux
scripts/lan_inventory.py

# Just the targets array, ready for the Node's nmap tool
scripts/lan_inventory.py --targets
```

Then scan those specific hosts through the Node. For real ARP-based discovery
(finding machines that drop all unicast probes), use the
[bridged-guest hybrid](#lan-discovery-on-macos--the-bridged-guest-hybrid) or a
real Linux Node / VPS with host networking.

**`nmap` fails with `Operation not permitted` at exec.** Kali ships `/usr/lib/nmap/nmap` with file capabilities; `no-new-privileges` makes any privilege-gaining exec fail with EPERM. The Dockerfile strips them (`setcap -r`) — if a rebuild regresses this, that line is the fix.

**Every internet target reports `Host seems down` from a bridged Lima guest.** The bridged interface's DHCP lease installs its own default route (metric 100), which outranks Lima's NAT default (metric 200) — and a home router will not usually forward the guest's off-LAN traffic. Every non-LAN probe dies: `nmap` reports the host down and `curl` times out, while the same target answers from the Mac. `scripts/setup_bridged_node.sh` now deletes the `lima1` default route (guarded, so it survives re-provisioning): `lima1` keeps the on-link LAN route, the NAT interface carries the internet. Measured 2026-10-21: before the fix, every guest-side scan of a public VPS ~400 ms away failed while the Mac reached it; after it, `nmap -sV` through the Node returned the real banners at the real latency.

**Ping from inside a Lima guest lies about internet hosts.** Lima's user-mode NAT answers ICMP on behalf of *any* address: from inside the guest, `ping` against a public VPS whose real RTT is ~400 ms returned sub-millisecond replies. TCP is unaffected — connections forward to the real host, and nmap's banners and latencies are faithful. Never trust an ICMP verdict (or an RTT) for a non-LAN target from inside the guest; judge internet hosts by TCP, or ping from the Mac. This is the same family as Docker Desktop's fabricated discovery above, one layer up the stack — and a reason the discovery guard's refusal is scoped to discovery, not to TCP.

**`compose up` fails: env file missing.** Expected: the `env_file` is required so the stack fails closed without a token. Create `configs/mshin-node.env` (see Setup).

**Metasploit's first call after a restart is slow.** msfconsole's one-time init runs against the `/tmp` tmpfs once per container start (pre-warming at build time would be masked by the tmpfs, so the Dockerfile deliberately does not).

## LAN discovery on macOS — the bridged-guest hybrid

A container on Docker Desktop **cannot** sit on the physical LAN: the Docker VM's NIC is NAT'd by the host OS and no bridge to the physical NIC exists, so `macvlan`/`host` tricks from Linux simply do not apply on macOS or Windows. What each path can and cannot do, measured on this setup:

| Operation from the container | Faithful? |
| ------ | --------- |
| Internet egress (`whois`, `dnsenum`, public targets) | Yes |
| Targeted scan of a **known-live** LAN host | Yes — byte-identical port states and banners to a native scan |
| Host **discovery** across the LAN | **No — fabricated** (see Troubleshooting). The Node now *refuses* such results (`nmap -sn` against a CIDR where every address answers returns an error, not a fake list) |
| ARP discovery (`arp-scan`, `nmap -sn -PR`) | **No** — the container has no Layer-2 presence on the LAN. Use the host (`scripts/lan_inventory.py`) or the [bridged-guest hybrid](#lan-discovery-on-macos--the-bridged-guest-hybrid) |

### The macOS host as the LAN vantage

For ordinary LAN work the simplest truthful position is the Mac itself, not a
container or VM. Run `scripts/lan_inventory.py` on the host, copy the `targets`
array it prints, and ask the Node to scan those hosts. The host finds the live
IPs, MACs and best-effort names; the Docker Node runs the actual offensive
tools against the targets you already know are real. This is the recommended
path when the only hardware you have is the Mac and you want to stay in Docker.

A full "macOS host Node" is not practical: the MCP server expects Linux/Kali
binaries at fixed paths (`/usr/bin/nmap`, `/usr/sbin/arp-scan`, etc.) and runs
them with assumptions that do not hold on macOS. Discovery is the one task the
host does better than the container, so the helper is designed to bridge the
two.

When you need real ARP-based discovery — finding machines that drop all unicast probes (Windows defaults, sleeping phones) — run the *same container image* on a machine that is itself on the LAN:

1. **Create the Lima guest with bridged networking** — follow [Lima Local Dev](LIMA-LOCAL-DEV.md)'s bridged mode (a `bridged` network in `~/.lima/_config/networks.yaml` bound to the wired interface, plus the `- lima: bridged` entry in the template). Bridged was verified working over Wi-Fi on this project's own TOTOLINK router; test your AP first.
2. **Install Docker in the guest** — `sudo apt-get install -y docker.io docker-compose` (the same in-guest setup the 0.19.0 verification used).
3. **Run the base compose file inside the guest** — `configs/compose.yaml` with **no** override: `network_mode: host` inside the guest makes the container share the guest's bridged NIC, which puts the tools directly on the physical LAN with working ARP.
4. **Point clients at the guest's bridged IP** — `http://<GUEST_LAN_IP>:3000/mcp` with the same `configs/mshin-node.env` token. The Node is now LAN-reachable, so the token is mandatory and `MSHIN_ALLOWED_TARGETS` is strongly recommended.

Two measured truths about the guest's vantage point, discovered 2026-10-21 and both handled in [Troubleshooting](#troubleshooting): the bridged DHCP default route shadows Lima's NAT route and kills internet egress until the setup script removes it, and Lima's NAT answers ICMP for any address — so a ping-based verdict for an internet host from inside the guest means nothing. TCP through the guest is faithful in both directions: real banners, real latencies.

The production equivalent is simpler: a real Linux Node or VPS runs `configs/compose.yaml` unchanged, and `network_mode: host` there means real LAN presence with no VM at all. The hybrid above is what you use when the only hardware you have is the Mac.

## Limitations

- Scanning targets are still governed by the repo's rules: `127.0.0.1` or RFC 5737 ranges in examples and tests, and by `MSHIN_ALLOWED_TARGETS` in practice.
- The container cannot reach the host's physical LAN from the bridge override on Docker Desktop (macOS or Windows); ARP-based discovery needs the [bridged-guest hybrid](#lan-discovery-on-macos--the-bridged-guest-hybrid) or a real Linux Node / VPS.
- This is for development and testing, never production scanning of machines you do not own.

## Changelog

- **2026-10-21 (second session)** — Two more measured truths documented: the bridged Lima guest's DHCP default route silently killed all internet egress (fixed in `scripts/setup_bridged_node.sh`), and Lima's user-mode NAT answers ICMP on behalf of any address, so ping-based verdicts for internet hosts from inside the guest are meaningless while TCP remains faithful.
- **2026-10-21** — Guide created with the sandboxed Docker Node. The Lima-vs-Docker comparison was measured, not estimated: identical full-stack `nmap` round trips (11.2–11.3 s) across native Lima, Docker-in-Lima, and Docker Desktop.

## See Also

- [Architecture](ARCHITECTURE.md) — the two-machine design this runs a single-machine version of
- [Lima Local Dev](LIMA-LOCAL-DEV.md) — the production-shape emulation alternative
- [Eval Run 2026-10-20](EVAL-RUN-2026-10-20.md) — the model-comparison measurements this Node serves
- `configs/Dockerfile`, `configs/compose.yaml`, `configs/compose.local.yaml` — the artifacts themselves
