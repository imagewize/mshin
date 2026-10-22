#!/usr/bin/env python3
"""
Machin Shin — cross-platform LAN inventory.

Discovers live hosts on the local network segment from the machine itself,
because a Docker Desktop container (and most VM NAT setups) cannot do truthful
Layer-2 discovery. Output can be read by a human or fed straight into the
mshin Node's nmap tool as a targets array.

Supported on macOS, Windows and Linux. No third-party packages required.

Usage:
  scripts/lan_inventory.py              # human-readable table
  scripts/lan_inventory.py --json       # machine-readable JSON
  scripts/lan_inventory.py --targets    # Node-ready JSON targets array
  scripts/lan_inventory.py --interface eth0
"""

import argparse
import json
import platform
import re
import socket
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from typing import List, Optional, Tuple


@dataclass
class Host:
    ip: str
    mac: str
    hostname: str = ""
    vendor: str = ""


class OuiLookup:
    """Tiny built-in OUI table for common consumer vendors."""

    PREFIXES = {
        "00:50:56": "VMware",
        "08:00:27": "VirtualBox",
        "0a:00:27": "VirtualBox",
        "52:54:00": "QEMU/KVM",
        "b0:83:fe": "Apple",
        "ac:de:48": "Apple",
        "a4:5e:60": "Apple",
        "a4:da:22": "Apple",
        "8c:85:90": "Apple",
        "f0:18:98": "Apple",
        "dc:a9:04": "Apple",
        "e0:5f:45": "Apple",
        "14:c1:4e": "Apple",
        "44:00:49": "Apple",
        "64:9a:be": "Apple",
        "6c:7e:67": "Apple",
        "84:38:35": "Apple",
        "b4:18:d1": "Apple",
        "9c:8e:cd": "Huawei",
        "a4:71:74": "Huawei",
        "b0:53:65": "Huawei",
        "c0:2e:25": "Huawei",
        "d0:66:7b": "Huawei",
        "e4:35:c8": "Huawei",
        "00:1a:11": "Google",
        "3c:5a:b4": "Google",
        "54:60:09": "Google",
        "a4:77:33": "Google",
        "00:90:a9": "Western Digital",
        "00:04:4b": "NVIDIA",
        "00:22:58": "Asus",
        "04:d4:c4": "Asus",
        "10:7b:44": "Asus",
        "14:dd:a9": "Asus",
        "1c:87:74": "Asus",
        "2c:4d:54": "Asus",
        "30:5a:3a": "Asus",
        "50:46:5d": "Asus",
        "ac:22:0b": "Asus",
        "e0:3f:49": "Asus",
        "00:1d:d0": "Dell",
        "18:03:73": "Dell",
        "24:b6:fd": "Dell",
        "5c:26:0a": "Dell",
        "64:00:6a": "Dell",
        "74:e6:e2": "Dell",
        "84:8f:69": "Dell",
        "a4:ba:db": "Dell",
        "b8:2a:72": "Dell",
        "c8:1f:66": "Dell",
        "f8:ca:b8": "Dell",
        "00:21:cc": "Hewlett-Packard",
        "3c:5a:37": "Hewlett-Packard",
        "9c:b6:54": "Hewlett-Packard",
        "a4:5d:36": "Hewlett-Packard",
        "d4:c9:ef": "Hewlett-Packard",
        "ec:b1:d7": "Hewlett-Packard",
        "00:0c:f3": "Microsoft",
        "28:18:78": "Microsoft",
        "38:f2:3e": "Microsoft",
        "50:1a:c5": "Microsoft",
        "7c:ed:8d": "Microsoft",
        "ac:7e:8f": "Microsoft",
        "c0:33:5e": "Microsoft",
        "d4:6d:6d": "Microsoft",
        "00:1b:21": "Intel",
        "00:1c:c0": "Intel",
        "00:21:5c": "Intel",
        "00:22:fa": "Intel",
        "00:23:14": "Intel",
        "00:24:d6": "Intel",
        "00:26:c7": "Intel",
        "08:11:96": "Intel",
        "10:02:b5": "Intel",
        "10:65:30": "Intel",
        "10:77:b1": "Intel",
        "18:ff:0f": "Intel",
        "1c:87:2c": "Intel",
        "24:77:03": "Intel",
        "34:13:e8": "Intel",
        "34:e6:ad": "Intel",
        "3c:a9:f4": "Intel",
        "4c:34:88": "Intel",
        "4c:79:6e": "Intel",
        "50:1d:93": "Intel",
        "5c:80:b6": "Intel",
        "60:57:18": "Intel",
        "64:80:99": "Intel",
        "6c:29:95": "Intel",
        "6c:88:14": "Intel",
        "74:e5:43": "Intel",
        "78:0c:b8": "Intel",
        "78:92:9c": "Intel",
        "7c:5c:f8": "Intel",
        "80:32:53": "Intel",
        "88:53:2e": "Intel",
        "8c:70:5a": "Intel",
        "8c:a9:82": "Intel",
        "90:2e:1c": "Intel",
        "94:65:9c": "Intel",
        "98:54:1b": "Intel",
        "a0:36:bc": "Intel",
        "a0:88:b4": "Intel",
        "a4:02:b9": "Intel",
        "a4:34:d9": "Intel",
        "a4:5e:60": "Intel",
        "a8:a1:59": "Intel",
        "ac:fd:ce": "Intel",
        "b4:6b:fc": "Intel",
        "b8:08:cf": "Intel",
        "b8:81:98": "Intel",
        "b8:bf:83": "Intel",
        "bc:54:36": "Intel",
        "c0:3f:d5": "Intel",
        "c4:85:08": "Intel",
        "c8:21:58": "Intel",
        "cc:3d:82": "Intel",
        "d0:57:94": "Intel",
        "d0:7e:35": "Intel",
        "d4:6d:6d": "Intel",
        "d4:6e:5e": "Intel",
        "d8:3b:bf": "Intel",
        "d8:fc:93": "Intel",
        "dc:53:60": "Intel",
        "e0:94:67": "Intel",
        "e0:9d:31": "Intel",
        "e4:b9:7a": "Intel",
        "e8:6a:96": "Intel",
        "ec:9b:f3": "Intel",
        "f0:7d:68": "Intel",
        "f0:9f:c2": "Intel",
        "f4:06:69": "Intel",
        "f4:96:34": "Intel",
        "f4:b5:20": "Intel",
        "f4:d1:08": "Intel",
        "f8:16:54": "Intel",
        "fc:45:96": "Intel",
        "00:0e:35": "Cisco",
        "00:1b:0d": "Cisco",
        "00:1e:14": "Cisco",
        "00:24:14": "Cisco",
        "00:40:96": "Cisco",
        "00:50:80": "Cisco",
        "00:60:70": "Cisco",
        "00:90:6e": "Cisco",
        "00:a0:c9": "Cisco",
        "00:d0:58": "Cisco",
        "08:21:ef": "Cisco",
        "18:33:9d": "Cisco",
        "20:37:06": "Cisco",
        "24:b6:57": "Cisco",
        "28:93:fe": "Cisco",
        "2c:3f:0b": "Cisco",
        "2c:ab:00": "Cisco",
        "30:e4:db": "Cisco",
        "34:bd:c8": "Cisco",
        "38:ed:18": "Cisco",
        "3c:5a:37": "Cisco",
        "3c:a0:67": "Cisco",
        "48:ad:08": "Cisco",
        "50:57:a8": "Cisco",
        "58:ac:78": "Cisco",
        "5c:50:15": "Cisco",
        "60:73:5c": "Cisco",
        "64:9e:f3": "Cisco",
        "68:bc:0c": "Cisco",
        "6c:20:56": "Cisco",
        "70:10:5c": "Cisco",
        "78:da:6e": "Cisco",
        "84:78:ac": "Cisco",
        "88:1d:fc": "Cisco",
        "90:02:18": "Cisco",
        "98:5d:82": "Cisco",
        "a0:55:4f": "Cisco",
        "a4:0c:c3": "Cisco",
        "a8:0c:0d": "Cisco",
        "a8:9d:21": "Cisco",
        "ac:f2:c5": "Cisco",
        "b0:be:76": "Cisco",
        "b4:de:31": "Cisco",
        "b8:38:61": "Cisco",
        "bc:16:65": "Cisco",
        "c0:62:6b": "Cisco",
        "c4:64:13": "Cisco",
        "c8:9c:1d": "Cisco",
        "cc:5a:53": "Cisco",
        "d0:5f:64": "Cisco",
        "d4:a0:2a": "Cisco",
        "d4:d7:48": "Cisco",
        "d8:24:bd": "Cisco",
        "dc:a9:04": "Cisco",
        "e0:ac:f1": "Cisco",
        "e4:d3:f1": "Cisco",
        "e8:65:49": "Cisco",
        "ec:bd:1d": "Cisco",
        "f0:25:72": "Cisco",
        "f4:ac:c1": "Cisco",
        "f8:8c:21": "Cisco",
        "fc:fb:fb": "Cisco",
    }

    @classmethod
    def lookup(cls, mac: str) -> str:
        if not mac:
            return ""
        prefix = mac.lower()[:8]
        return cls.PREFIXES.get(prefix, "")


def run_command(cmd: List[str], timeout: int = 10) -> str:
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="ignore",
        )
        return result.stdout + result.stderr
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


def parse_mac(addr: str) -> str:
    """Normalise a MAC address to aa:bb:cc:dd:ee:ff."""
    addr = addr.strip().lower()
    if not addr:
        return ""
    # Remove common separators and any trailing/interface text.
    addr = re.split(r"[\s\[]", addr)[0]
    hex_digits = re.sub(r"[^0-9a-f]", "", addr)
    if len(hex_digits) != 12:
        return ""
    return ":".join(hex_digits[i : i + 2] for i in range(0, 12, 2))


def ping_host(ip: str) -> bool:
    """Return True if the host answers at least one ICMP echo."""
    system = platform.system()
    if system == "Windows":
        cmd = ["ping", "-n", "1", "-w", "500", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", "1", ip]
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def resolve_hostname(ip: str) -> str:
    """Best-effort reverse DNS / mDNS lookup with a short timeout."""
    try:
        socket.setdefaulttimeout(1.5)
        host, _, _ = socket.gethostbyaddr(ip)
        socket.setdefaulttimeout(None)
        if host and host != ip:
            return host.split(".")[0]
    except (socket.herror, socket.gaierror, OSError):
        pass
    finally:
        socket.setdefaulttimeout(None)
    return ""


def _macos_physical_interfaces() -> List[str]:
    """List non-virtual interfaces that are likely on the physical LAN."""
    output = run_command(["networksetup", "-listallhardwareports"])
    ifaces = []
    for line in output.splitlines():
        match = re.match(r"Device:\s*(\S+)", line)
        if match:
            ifaces.append(match.group(1))
    return ifaces


def get_macos_info(iface: Optional[str]) -> Tuple[str, str, str]:
    """Return (interface, ip, subnet) on macOS."""
    if iface:
        candidates = [iface]
    else:
        # The default route may be owned by a VPN (utun*). Prefer the LAN
        # interface explicitly: en0 is Wi-Fi on most Macs, then fall back to
        # any physical interface reported by networksetup that has an address.
        candidates = ["en0"] + [i for i in _macos_physical_interfaces() if i != "en0"]

    for candidate in candidates:
        ip_output = run_command(["ipconfig", "getifaddr", candidate])
        ip = ip_output.strip().splitlines()[0] if ip_output else ""
        if ip and "." in ip:
            subnet = ".".join(ip.split(".")[:3])
            return candidate, ip, subnet

    raise RuntimeError(
        "Could not determine a physical LAN IPv4 address. "
        "If a VPN owns the default route, pass --interface with your Wi-Fi/LAN device (e.g. en0)."
    )


def get_linux_info(iface: Optional[str]) -> Tuple[str, str, str]:
    """Return (interface, ip, subnet) on Linux."""
    if not iface:
        output = run_command(["ip", "route", "get", "1.1.1.1"])
        match = re.search(r"dev\s+(\S+)", output)
        iface = match.group(1) if match else "eth0"

    output = run_command(["ip", "-4", "addr", "show", iface])
    match = re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)/\d+", output)
    ip = match.group(1) if match else ""
    if not ip:
        raise RuntimeError(f"Could not determine IPv4 address on {iface}")
    subnet = ".".join(ip.split(".")[:3])
    return iface, ip, subnet


def get_windows_info(iface: Optional[str]) -> Tuple[str, str, str]:
    """Return (interface, ip, subnet) on Windows."""
    output = run_command(["ipconfig"])
    # Find the first adapter with a default gateway unless an interface is named.
    blocks = re.split(r"\n(?=\S)", output)
    for block in blocks:
        if "Default Gateway" not in block:
            continue
        gateway_match = re.search(r"Default Gateway.*?:\s*(\d+\.\d+\.\d+\.\d+)", block)
        if not gateway_match:
            continue
        ip_match = re.search(r"IPv4 Address.*?:\s*(\d+\.\d+\.\d+\.\d+)", block)
        if not ip_match:
            continue
        name_line = block.splitlines()[0].strip().rstrip(":")
        if iface and iface.lower() not in name_line.lower():
            continue
        ip = ip_match.group(1)
        subnet = ".".join(ip.split(".")[:3])
        return name_line, ip, subnet
    raise RuntimeError("Could not determine IPv4 address and gateway")


def get_network_info(iface: Optional[str]) -> Tuple[str, str, str]:
    system = platform.system()
    if system == "Darwin":
        return get_macos_info(iface)
    if system == "Linux":
        return get_linux_info(iface)
    if system == "Windows":
        return get_windows_info(iface)
    raise RuntimeError(f"Unsupported platform: {system}")


def parse_arp_table_macos(iface: str) -> dict:
    """Return {ip: mac} from 'arp -a -i <iface>'."""
    output = run_command(["arp", "-a", "-i", iface])
    table = {}
    for line in output.splitlines():
        # ? (192.168.1.1) at ab:cd:ef:12:34:56 on en0 [ethernet]
        match = re.match(r"\?\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)\s+on", line)
        if match:
            ip, mac = match.groups()
            mac = parse_mac(mac)
            if mac and "incomplete" not in line.lower():
                table[ip] = mac
    return table


def parse_arp_table_linux() -> dict:
    """Return {ip: mac} from 'ip neigh' or 'arp -a'."""
    table = {}
    output = run_command(["ip", "neigh", "show"])
    if not output:
        output = run_command(["arp", "-a"])
    for line in output.splitlines():
        # 192.168.1.1 dev eth0 lladdr ab:cd:ef:12:34:56 REACHABLE
        match = re.match(r"(\d+\.\d+\.\d+\.\d+)\s+.*lladdr\s+([0-9a-f:]+)", line)
        if match:
            ip, mac = match.groups()
            mac = parse_mac(mac)
            if mac:
                table[ip] = mac
            continue
        # ? (192.168.1.1) at ab:cd:ef:12:34:56 [ether] on eth0
        match = re.match(r"\?\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)", line)
        if match:
            ip, mac = match.groups()
            mac = parse_mac(mac)
            if mac and "incomplete" not in line.lower():
                table[ip] = mac
    return table


def parse_arp_table_windows() -> dict:
    """Return {ip: mac} from 'arp -a'."""
    output = run_command(["arp", "-a"])
    table = {}
    for line in output.splitlines():
        line = line.strip()
        # 192.168.1.1          ab-cd-ef-12-34-56     dynamic
        match = re.match(r"(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})\s+", line)
        if match:
            ip, mac = match.groups()
            mac = parse_mac(mac)
            if mac:
                table[ip] = mac
    return table


def get_arp_table(iface: str) -> dict:
    system = platform.system()
    if system == "Darwin":
        return parse_arp_table_macos(iface)
    if system == "Linux":
        return parse_arp_table_linux()
    if system == "Windows":
        return parse_arp_table_windows()
    return {}


def discover_hosts(subnet: str, iface: str, max_workers: int = 64) -> List[Host]:
    """Ping-sweep the /24 and collect IP/MAC/hostname for live hosts."""
    ips = [f"{subnet}.{i}" for i in range(1, 255)]
    live = set()

    def check(ip: str):
        if ping_host(ip):
            live.add(ip)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        list(executor.map(check, ips))

    arp_table = get_arp_table(iface)

    hosts = []
    for ip in sorted(live, key=lambda x: [int(p) for p in x.split(".")]):
        mac = arp_table.get(ip, "")
        if not mac:
            continue
        hostname = resolve_hostname(ip)
        vendor = OuiLookup.lookup(mac)
        hosts.append(Host(ip=ip, mac=mac, hostname=hostname, vendor=vendor))

    return hosts


def output_table(hosts: List[Host], iface: str, subnet: str):
    print(f"Interface: {iface}  Subnet: {subnet}.0/24  Live hosts: {len(hosts)}")
    print()
    print(f"{'IP':<16} {'MAC':<18} {'HOSTNAME':<24} {'VENDOR'}")
    print("-" * 16 + " " + "-" * 18 + " " + "-" * 24 + " " + "-" * 20)
    for h in hosts:
        print(f"{h.ip:<16} {h.mac:<18} {h.hostname or '-':<24} {h.vendor or '-'}")
    print()
    print("Feed these to the Node (targeted scans are faithful):")
    targets = [h.ip for h in hosts]
    print(f"  targets: {json.dumps(targets)}")


def output_json(hosts: List[Host], iface: str, subnet: str):
    data = {
        "interface": iface,
        "subnet": f"{subnet}.0/24",
        "live_hosts": len(hosts),
        "hosts": [asdict(h) for h in hosts],
    }
    print(json.dumps(data, indent=2))


def output_targets(hosts: List[Host]):
    targets = [h.ip for h in hosts]
    print(json.dumps(targets))


def main():
    parser = argparse.ArgumentParser(
        description="Cross-platform LAN inventory for Machin Shin."
    )
    parser.add_argument(
        "--interface",
        "-i",
        help="Network interface to scan (default: the interface with the default gateway)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output JSON instead of a table",
    )
    parser.add_argument(
        "--targets",
        action="store_true",
        help="Output only a Node-ready targets array",
    )
    args = parser.parse_args()

    try:
        iface, ip, subnet = get_network_info(args.interface)
    except RuntimeError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)

    hosts = discover_hosts(subnet, iface)

    if args.targets:
        output_targets(hosts)
    elif args.json:
        output_json(hosts, iface, subnet)
    else:
        output_table(hosts, iface, subnet)


if __name__ == "__main__":
    main()
