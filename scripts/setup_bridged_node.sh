#!/bin/bash
#
# Machin Shin — one-command bridged Lima Node (real LAN discovery on a Mac)
#
# Description: creates a Lima guest ("mshin-node-bridged") whose Node sits
# directly on the physical LAN, where its root nmap/arp-scan can ARP-discover
# hosts that drop all unicast probes. This is the path Docker Desktop cannot
# offer: its container sits behind NAT and fabricates host discovery (see
# docs/DOCKER-LOCAL-DEV.md, Troubleshooting). Prefer this guest for LAN
# discovery work on a Mac; keep the Docker Node for evals and internet targets.
#
# Usage: scripts/setup_bridged_node.sh
#
# Prerequisites:
#   - limactl: brew install lima
#   - socket_vmnet + the lima sudoers rule:
#       brew install socket_vmnet
#       limactl sudoers | sudo tee /etc/sudoers.d/lima
#   - a "bridged" network in ~/.lima/_config/networks.yaml bound to your
#     interface. Wired works everywhere; over Wi-Fi many access points drop
#     frames from unassociated MACs — test yours first (see
#     docs/LIMA-LOCAL-DEV.md, "Bridged networking (optional)").
#   - MSHIN_NODE_TOKEN exported before running: a bridged Node is reachable
#     by the entire LAN, and without the token anyone on the network can
#     drive its tools as root. Generate one with: openssl rand -hex 32
#
# The script is idempotent: an existing guest is started, not re-created.

set -euo pipefail

GUEST="mshin-node-bridged"
NETWORKS_FILE="${HOME}/.lima/_config/networks.yaml"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v limactl >/dev/null 2>&1 || {
    echo "[ERROR] limactl not found: brew install lima" >&2
    exit 1
}

if [ ! -f "${NETWORKS_FILE}" ] || ! grep -q "bridged" "${NETWORKS_FILE}"; then
    cat >&2 <<EOF
[ERROR] No 'bridged' network in ${NETWORKS_FILE}.

Create one bound to your network interface (wired recommended):

  networks:
    bridged:
      mode: bridged
      interface: en0

See docs/LIMA-LOCAL-DEV.md, "Bridged networking (optional)".
EOF
    exit 1
fi

if [ -z "${MSHIN_NODE_TOKEN:-}" ]; then
    echo "[ERROR] MSHIN_NODE_TOKEN is not set. A bridged Node is reachable by the" >&2
    echo "         whole LAN; the token is mandatory. Generate one: openssl rand -hex 32" >&2
    exit 1
fi

# Lima automatically forwards a guest's listening ports to the Mac's
# localhost, so two running Node guests would fight over localhost:3000.
# Warn, do not block: the user may know the other guest is stopped.
if limactl list 2>/dev/null | grep -q "mshin"; then
    echo "[WARN] An mshin guest appears in 'limactl list'. If another Node guest is" >&2
    echo "       running, stop it first (limactl stop <name>) — both would claim" >&2
    echo "       localhost:3000 via Lima's automatic port forwarding." >&2
fi

if limactl list 2>/dev/null | grep -q "^${GUEST}\b"; then
    echo "[INFO] Guest ${GUEST} exists — starting it."
    limactl start "${GUEST}"
else
    echo "[+] Creating ${GUEST} from lima/mshin-node.yaml with the bridged network."
    echo "    This provisions Debian plus the full tool set; several minutes."
    limactl create --name="${GUEST}" --network=lima:bridged \
        "${REPO_ROOT}/lima/mshin-node.yaml"
fi

# The bridged interface is lima1 inside the guest. Read its DHCP address.
LAN_IP="$(limactl shell "${GUEST}" -- ip -4 -br addr show lima1 \
    | awk '{print $3}' | cut -d/ -f1)"
if [ -z "${LAN_IP}" ]; then
    echo "[ERROR] No address on lima1 inside the guest. The bridge did not come up." >&2
    echo "        Over Wi-Fi this usually means the AP dropped the unassociated MAC." >&2
    echo "        Try a wired connection, or a different AP. See docs/LIMA-LOCAL-DEV.md." >&2
    exit 1
fi

# The token must reach the unit inside the guest. A systemd drop-in keeps the
# repo-shipped unit untouched.
limactl shell "${GUEST}" -- sudo mkdir -p /etc/systemd/system/mshin-node.service.d
printf '[Service]\nEnvironment=MSHIN_NODE_TOKEN=%s\n' "${MSHIN_NODE_TOKEN}" \
    | limactl shell "${GUEST}" -- sudo tee /etc/systemd/system/mshin-node.service.d/token.conf >/dev/null
limactl shell "${GUEST}" -- sudo systemctl daemon-reload
limactl shell "${GUEST}" -- sudo systemctl restart mshin-node

echo "[+] Bridged Node is up: http://${LAN_IP}:3000/mcp"
limactl shell "${GUEST}" -- curl -fsS http://127.0.0.1:3000/health

cat <<EOF

Next steps:

  1. Verify the vantage point from the Mac (expect the real LAN, MACs included):
       ping -c 3 ${LAN_IP}
  2. ARP-discover the segment from inside the guest:
       limactl shell ${GUEST} -- sudo -n arp-scan --localnet
  3. Point your client at the Node:
       http://${LAN_IP}:3000/mcp  (bearer token: the MSHIN_NODE_TOKEN you set)
  4. Strongly consider scoping the tools to your LAN:
       limactl shell ${GUEST} -- sudo systemctl edit mshin-node
       [Service]
       Environment=MSHIN_ALLOWED_TARGETS=<YOUR_LAN_CIDR>

  Cleanup when done: limactl stop ${GUEST} && limactl delete ${GUEST}
EOF
