#!/bin/bash
#
# Machin Shin — host-side LAN inventory (macOS)
#
# Description: one command to list the live hosts on this Mac's current
# wireless/wired network: IP, MAC, and best-effort hostname. This runs on the
# Mac itself because only the Mac is on the physical network — the Docker
# Desktop Node cannot do this (its NAT fabricates discovery; see
# docs/DOCKER-LOCAL-DEV.md, Troubleshooting). The Node stays faithful for
# targeted scans of the hosts this script lists.
#
# Usage: scripts/lan_inventory.sh [interface]
#   interface: optional, defaults to en0 (Wi-Fi on most Macs)
#
# Output: a table of live hosts on stdout, progress on stderr, and a final
# ready-to-use `targets` array for the Node's nmap tool.
#
# Notes: a VPN interface owning the default route can suppress reverse-DNS
# and Bonjour name resolution, so hostnames may come up empty — the IP/MAC
# list is still complete. arp -a is the source of truth.

set -euo pipefail

IFACE="${1:-en0}"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "[ERROR] macOS only — this script drives ipconfig and arp on the Mac." >&2
    exit 1
fi

IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
if [ -z "$IP" ]; then
    echo "[ERROR] No IPv4 address on ${IFACE}. Pass the interface as the first" >&2
    echo "         argument. Find yours with: networksetup -listallhardwareports" >&2
    exit 1
fi

SUBNET="$(printf '%s' "$IP" | cut -d. -f1-3)"
echo "[+] ${IFACE}: ${IP} — ping-sweeping ${SUBNET}.0/24 ..." >&2

for i in $(seq 1 254); do
    ping -c 1 -W 300 "${SUBNET}.${i}" >/dev/null 2>&1 &
done
wait

# Only entries with a real MAC are live: drop (incomplete), the broadcast
# entries, and the IPv4 multicast rows (01:00:5e/..., which arp prints with
# leading zeros stripped, e.g. 1:0:5e:0:0:fb).
LIVE="$(arp -a -i "$IFACE" \
    | grep -v "(incomplete)" \
    | grep -v "ff:ff:ff:ff:ff:ff" \
    | grep -v " 1:0:5e:" \
    | sort -t. -k4 -n)"

if [ -z "$LIVE" ]; then
    echo "[ERROR] No live hosts in the ARP table — unexpected on a working network." >&2
    exit 1
fi

printf '%-16s %-18s %s\n' "IP" "MAC" "HOSTNAME"
printf '%-16s %-18s %s\n' "---------------" "------------------" "--------"

TARGETS_JSON="["
FIRST=1
while IFS= read -r line; do
    ip="$(printf '%s' "$line" | sed -E 's/.*\(([0-9.]+)\).*/\1/')"
    mac="$(printf '%s' "$line" | sed -E 's/.* at ([0-9a-f:]+) on .*/\1/')"
    host="$(dscacheutil -q host -a address "$ip" 2>/dev/null | awk '/^name:/ {print $2; exit}')"
    printf '%-16s %-18s %s\n' "$ip" "$mac" "${host:--}"
    if [ "$FIRST" -eq 1 ]; then
        TARGETS_JSON+="\"${ip}\""
        FIRST=0
    else
        TARGETS_JSON+=", \"${ip}\""
    fi
done <<< "$LIVE"

echo
echo "Scan these through the Node (targeted scans are faithful):"
echo "  targets: ${TARGETS_JSON}]"
