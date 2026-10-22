# Machin Shin Node on a VPS

> *"Distance means nothing to the One Power. The weave does not care how far the thread has come — only whether it can reach."*

Run the Machin Shin Node on a cloud VPS: the same `configs/Dockerfile` and `configs/compose.yaml` that run on your Mac, on a Linux host where `network_mode: host` actually means the host. Cheap, always on, and reachable from anywhere — for the right targets.

---

## Overview

| Aspect | VPS Node | Mac (Docker local dev) | Mac (Lima bridged) |
| ------ | -------- | ---------------------- | ------------------- |
| Runs 24/7, reachable from anywhere | Yes | No | No |
| Truthful host discovery **on its own network** (the VPS's) | Yes — host networking, no NAT | No — fabricated (see [Docker Local Dev](DOCKER-LOCAL-DEV.md)) | Yes — on **your** LAN |
| Can discover **your home/office LAN** | **No — not physically on it** | No | Yes |
| Scanning internet-facing targets you own | Yes — the main use case | Yes | Yes |
| Port `:3000` exposure | Public by default — token and firewall mandatory | LAN only | LAN only |

**The one thing a VPS Node cannot do is see your home LAN.** ARP discovery works only on the network segment the scanner is physically attached to. A VPS is not on your Wi-Fi; it can enumerate its *own* cloud subnet, but the hosts on `192.168.x.x` behind your router are unreachable except through NAT-assisted services you deliberately expose. If your workload is discovering or attacking your own LAN, the Node must be on that LAN: the Raspberry Pi Node ([RASPBERRY-PI-NODE.md](RASPBERRY-PI-NODE.md)), a Linux box, or the bridged Lima guest (`scripts/setup_bridged_node.sh`).

**When to use a VPS Node:** scanning internet-facing systems you own or are authorised to test (your servers, staging environments, CTF boxes), running long scans without occupying your laptop, and having the Node available from any machine.

> **Ethics reminder.** This project documents offensive tooling. Use it only against systems you own or are explicitly authorised to test. A VPS with attack tools on it is a responsibility: keep the token strong, keep the scope allowlist tight, and do not port-forward the Node to the internet.

---

## Prerequisites

- A VPS from any provider, Linux, 2 GB RAM minimum (the Node is a Node.js process plus short-lived CLI tools)
- Docker + Docker Compose on the VPS
- The repo on the VPS (`git clone`) or transferred by your own means
- `MSHIN_NODE_TOKEN` — a random 64-hex-char token (`openssl rand -hex 32`)

## Setup

On the VPS, the **base** compose file runs as-is — no override. `network_mode: host` on a real Linux kernel means the container shares the host's NIC: raw sockets work, and there is no NAT layer to fabricate discovery or mangle banners.

```bash
git clone https://github.com/imagewize/mshin.git && cd mshin

# 1. The token file. Compose refuses to start without it — fail-closed.
printf 'MSHIN_NODE_TOKEN=%s\n' "$(openssl rand -hex 32)" > configs/mshin-node.env
chmod 600 configs/mshin-node.env
# Scope the tools to the targets this engagement is authorised to touch:
echo 'MSHIN_ALLOWED_TARGETS=<AUTHORISED_TARGETS>' >> configs/mshin-node.env

# 2. Build and run — no .local override on a Linux host.
docker compose -f configs/compose.yaml up -d --build

# 3. Verify, on the VPS.
curl http://127.0.0.1:3000/health
```

**Lock it down.** With host networking the Node binds `0.0.0.0:3000` — on a VPS that means the public internet, and the bearer token is the only thing between the world and root-level tools inside the jail:

- Keep `MSHIN_NODE_TOKEN` set (the compose file fails closed without it).
- Set `MSHIN_ALLOWED_TARGETS` to the engagement scope; the scope allowlist constrains *targets*, the token constrains *callers*.
- Firewall `:3000` to your own addresses (`ufw deny 3000` + `ufw allow from <YOUR_IP> to any port 3000`), or use the provider's security groups. The token is required; the firewall means a leak does not become a public root-tool API.
- Never forward `:3000` through a reverse proxy "for convenience".

## Usage

Point any Machin Shin client at the VPS: the CLI (`--mcp-url http://<VPS_IP>:3000/mcp --token <value>`), Mistral Vibe, or OpenCode — the Node speaks the same Streamable HTTP everywhere. Verify from your machine with `scripts/probe_mcp_server.sh <VPS_IP> 3000`.

What is faithful from a VPS position, and what is not:

- **Internet-facing targets** — faithful. Scans leave the VPS's own IP.
- **Its own cloud subnet** — truthful discovery (`arp-scan`, `nmap -sn`), usually only the gateway and the provider's neighbours.
- **Your home/office LAN** — not reachable, period. Don't try; the discovery guard will at least refuse to lie if you point it at a CIDR whose every address "answers".

### Scanning client sites from a VPS

The main reason to run the Node on a VPS is to scan internet-facing systems
you own or are explicitly authorised to test: client staging environments,
your own servers, or CTF boxes. Keep the engagement scope in one place:

```bash
# On the VPS, scope the Node to only the authorised targets
echo 'MSHIN_ALLOWED_TARGETS=client-staging.example.com,203.0.113.0/24' >> configs/mshin-node.env
docker compose -f configs/compose.yaml up -d --force-recreate
```

From your machine, point Vibe or OpenCode at `http://<VPS_IP>:3000/mcp` with
the same `MSHIN_NODE_TOKEN`. On the client machine, sync the token and patch
the OpenCode config with `scripts/setup_mcp_auth.sh --url http://<VPS_IP>:3000/mcp`
(run it from a checkout of this repo). The scope allowlist rejects anything
outside the engagement before a tool runs, and the VPS firewall should
restrict `:3000` to your own IP. Never set `MSHIN_ALLOWED_TARGETS=0.0.0.0/0`
for a client scan.

## Troubleshooting

**`curl 127.0.0.1:3000/health` fails on the VPS.** `docker compose -f configs/compose.yaml ps` and `docker logs mshin-node`. The most common cause is a missing `configs/mshin-node.env` — compose fails closed by design.

**The Node answers 401.** Correct behaviour with a token set — present it as a bearer header. If every client is rejected, the token in the env file and the one the client sends differ.

**A discovery scan refuses to return results.** By design: if every address in a scanned range answers, the Node returns `Refusing to return a fabricated discovery result` rather than a fake host list. That means this Node's position cannot discover that range truthfully (see [Docker Local Dev](DOCKER-LOCAL-DEV.md), Troubleshooting).

**Scans of my home LAN find nothing.** Not a bug — the VPS is not on your LAN. Put the Node on the LAN instead: a Raspberry Pi or a bridged Lima guest.

## Limitations

- A VPS Node cannot discover or ARP-scan any LAN it is not physically on — that is physics (Layer 2), not a missing feature.
- The container is a jail, not a magic box: with host networking, whatever the VPS can reach, the tools can reach. The token, the scope allowlist and the firewall are the defenses — use all three.
- Provider terms of service apply: many cloud providers restrict port scanning from their networks even for authorised targets. Know your provider's policy before pointing the toolset outward.

## Changelog

- **2026-10-21** — Guide created alongside the discovery-honesty work (0.22.0): the fabrication guard, the `arp-scan` tool, and the host-side `scripts/lan_inventory.sh`. The "VPS sees everything" assumption is called out as false where it is false.
- **2026-10-22** — Added "Scanning client sites from a VPS" section: scope the Node with `MSHIN_ALLOWED_TARGETS`, keep the token and firewall tight, and point Vibe/OpenCode at the VPS. `setup_mcp_auth.sh --url` now handles the VPS URL in the OpenCode config.

## See Also

- [Docker Local Dev](DOCKER-LOCAL-DEV.md) — the same image on macOS, and the measured LAN-discovery truth
- [Lima Local Dev](LIMA-LOCAL-DEV.md) — the bridged-guest hybrid for real LAN discovery from a Mac
- [Raspberry Pi Node](RASPBERRY-PI-NODE.md) — a Node that lives on your LAN
- `scripts/probe_mcp_server.sh` — scripted health check and tool round trip from any client host
