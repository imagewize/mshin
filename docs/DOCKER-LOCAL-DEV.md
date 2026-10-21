# Machin Shin Local Development with Docker

> *"The stone that sits in one place all its life is still a stone; the stone carried down the river becomes smooth. Be the river's stone, not the field's."*

This guide describes how to run a **local, single-machine Machin Shin development environment** with the Node in a **Docker container** and **Ollama native on the macOS host**. It is the default local path — the same `configs/Dockerfile` and `configs/compose.yaml` that run here also run the Node on a real Linux box or a VPS, unchanged.

For the Lima-VM alternative, see [Lima Local Dev](LIMA-LOCAL-DEV.md) — it is no longer the default local path, but it remains the way to emulate the **production shape** (systemd unit, Debian host, bridged LAN access).

---

## Overview

| Aspect | Full setup | Docker local dev |
| ------ | ---------- | ---------------- |
| Machines | 2 physical boxes | 1 macOS host |
| Core | Separate machine, 32GB+ RAM | Native Ollama on the Mac (7–8B model tier) |
| Node | Kali on its own box | `mshin-node` container, all 16 tools |
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
│  │  16 Kali tools • cap NET_RAW/NET_ADMIN • read-only rootfs   │  │
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
| ~10 GB disk | The image with all 16 tools is ~3.1 GB |
| Apple Silicon or x86_64 | The image builds natively on both; `FROM kalilinux/kali-rolling` is multi-arch |
| Ollama (native) | For the Core side — see [Lima Local Dev](LIMA-LOCAL-DEV.md)'s model guidance (7–8B tier on 16 GB) |

## Setup

```bash
# 1. The token file. Compose refuses to start without it — fail-closed,
#    because an unauthenticated Node with host networking is drivable by
#    anyone on the LAN. The file is gitignored.
printf 'MSHIN_NODE_TOKEN=%s\n' "$(openssl rand -hex 32)" > configs/mshin-node.env
chmod 600 configs/mshin-node.env
# Optional, recommended: pin the target scope
echo 'MSHIN_ALLOWED_TARGETS=127.0.0.1,::1' >> configs/mshin-node.env

# 2. Build (no token needed at build time)
docker compose -f configs/compose.yaml build

# 3. Up. On macOS, include the local override (see below); on a Linux
#    host or VPS, drop it — host networking is what you want there.
docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d

# 4. Verify
curl http://localhost:3000/health
```

**The local override:** Docker Desktop does not publish `network_mode: host` services to the Mac — `host` there is the Docker VM's network, so nothing answers on the Mac's `localhost:3000`. `configs/compose.local.yaml` switches to bridge networking and publishes `3000:3000` for macOS; the base file keeps host networking for Linux Nodes and VPSes, where the tools must reach the LAN from the host's own IP.

## Usage

The MCP surface is identical to any other Node: point the CLI (`--mcp-url http://localhost:3000/mcp --token <value>`), Vibe, or OpenCode at `localhost:3000`. Verified in this environment: `tools/list` exposes all sixteen tools, a `tools/call` round trip to `nmap` returns real scan output (11.3 s), and `POST /mcp` without the token answers 401.

What the sandbox changes relative to a bare-metal Node:

- **No sudo.** Tools run as root *inside* the container; the sudoers allowlist does not exist in this mode, and the tshark/dirb/ffuf sudo exceptions in `tools.js` are moot.
- **Capabilities, not host root.** `cap_drop: ALL` plus `NET_RAW`/`NET_ADMIN` in `compose.yaml` — a bad flag or a hijacked prompt trashes a disposable container, not the host filesystem.
- **Nothing persists.** The rootfs is read-only; writable state is a `/tmp` tmpfs (msfconsole's first-run init, sqlmap output, resume dumps all land there and die with the container).
- **File-taking tools have no host files.** `tshark`, `john`, `sqlmap` see only the container's filesystem. Mount a volume in `compose.local.yaml` if you need to feed them files.

The eval harness (`clients/mshin-cli/eval-harness.js`) and its case sets work against this Node unchanged — the transport is the same Streamable HTTP. The full model-comparison suite **was re-run against the Docker Node on 2026-10-21** (see [Eval Run 2026-10-21](EVAL-RUN-2026-10-21.md)): the 8B tier scores 4/4 on both models, identical to the Lima baseline, with zero fabricated outputs — the sandbox is a drop-in Node for the harness. One wall-clock caveat: `nikto`'s ~8000 requests through the bridge/published-port path are slower than a guest-local path (~40 s per affected case); scores are unaffected.

---

## Troubleshooting

**`localhost:3000` answers 401 with the right token — or connects to the wrong Node.** If a Lima `mshin-node` guest is running, **Lima automatically forwards the guest's listening ports to the Mac's localhost** and will silently claim `localhost:3000` before Docker does. The request then reaches the *guest's* systemd Node (with *its* token), not your container. Fix: `limactl stop mshin-node`, then `docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d --force-recreate`. This collision is measured behavior, not speculation — it cost an hour of confused 401s during this guide's own verification.

**`nmap` fails with `Operation not permitted` at exec.** Kali ships `/usr/lib/nmap/nmap` with file capabilities; `no-new-privileges` makes any privilege-gaining exec fail with EPERM. The Dockerfile strips them (`setcap -r`) — if a rebuild regresses this, that line is the fix.

**`compose up` fails: env file missing.** Expected: the `env_file` is required so the stack fails closed without a token. Create `configs/mshin-node.env` (see Setup).

**Metasploit's first call after a restart is slow.** msfconsole's one-time init runs against the `/tmp` tmpfs once per container start (pre-warming at build time would be masked by the tmpfs, so the Dockerfile deliberately does not).

## Limitations

- Scanning targets are still governed by the repo's rules: `127.0.0.1` or RFC 5737 ranges in examples and tests, and by `MSHIN_ALLOWED_TARGETS` in practice.
- The container cannot reach the Mac's physical LAN; ARP-discovery workflows need the Lima bridged mode or a real Node.
- This is for development and testing, never production scanning of machines you do not own.

## Changelog

- **2026-10-21** — Guide created with the sandboxed Docker Node. The Lima-vs-Docker comparison was measured, not estimated: identical full-stack `nmap` round trips (11.2–11.3 s) across native Lima, Docker-in-Lima, and Docker Desktop.

## See Also

- [Architecture](ARCHITECTURE.md) — the two-machine design this runs a single-machine version of
- [Lima Local Dev](LIMA-LOCAL-DEV.md) — the production-shape emulation alternative
- [Eval Run 2026-10-20](EVAL-RUN-2026-10-20.md) — the model-comparison measurements this Node serves
- `configs/Dockerfile`, `configs/compose.yaml`, `configs/compose.local.yaml` — the artifacts themselves
