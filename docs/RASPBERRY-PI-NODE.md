# Machin Shin Node on Raspberry Pi

> *"The smallest wind can still carry a whisper through the Ways. So too can the smallest Node carry Machin Shin's hunt into the corners of your network."*

This guide covers running the **Machin Shin Node** (the Kali tool + MCP server box) on a **Raspberry Pi**. The Pi is a quiet, low-power option for the Node role, but it is not a full-speed offensive platform: heavy tools such as Metasploit, large `sqlmap` runs, or `john` with big wordlists will be slow or memory-constrained. Treat it as an entry point for light reconnaissance and learning, not a replacement for a faster x86_64 Node.

The Core (Ollama + CLI) is not covered here; set it up on your Mac Mini, desktop, or other 32GB+ machine per [docs/SETUP.md](SETUP.md).

---

## What works well on a Pi

- `nmap`, `whois`, `nikto`, `arping`, `dnsenum`, `gobuster`, `dirb`, `ffuf`, `enum4linux`
- Light `tshark` PCAP analysis
- Light `hydra` or `john` runs against small wordlists

## What will be slow or constrained

- `metasploit-framework` startup and module loading
- Large `sqlmap` scans or `--dump` operations
- `masscan` at high rates (the Pi's NIC and CPU are the bottleneck)
- `john` against large hash lists or without a GPU

---

## Prerequisites

| Item | Recommendation |
| ---- | --------------- |
| Raspberry Pi | Pi 4 or Pi 5 with 4GB+ RAM; 8GB preferred |
| Storage | 64GB+ microSD or USB SSD |
| OS | Kali Linux Raspberry Pi image (recommended) or Raspberry Pi OS with Kali repo |
| Network | Ethernet strongly preferred; Wi-Fi adds latency and can drop packets during scans |
| Power | Official Pi power supply; undervolting causes filesystem corruption under load |

---

## Option A: Kali Linux Raspberry Pi image (recommended)

### 1. Flash the image

Download the Kali Raspberry Pi image from [kali.org/get-kali](https://www.kali.org/get-kali/) and flash it to your microSD/USB SSD with Raspberry Pi Imager or `dd`.

```bash
# Example with dd; replace /dev/sdX with your device.
sudo dd if=kali-linux-2026.2-raspberry-pi-arm64.img of=/dev/sdX bs=4M status=progress
```

### 2. First boot

Insert the storage, connect Ethernet, and power on. Find the Pi on your LAN:

```bash
# From another machine on the same LAN
nmap -sn 192.168.1.0/24
```

Default Kali credentials are typically `kali` / `kali`. Change the password immediately:

```bash
passwd
```

### 3. Expand filesystem

Kali images may not auto-expand to fill the storage. If needed:

```bash
sudo raspi-config
# Advanced Options -> Expand Filesystem -> Reboot
```

### 4. Run the Machin Shin Node setup script

The setup script detects the Pi's network interface automatically and installs all sixteen tools. Metasploit and `john` will install but run slowly; they are included for completeness.

```bash
# On the Pi, as a user with sudo
sudo bash -c 'apt update && apt install -y git curl'
# Clone or transfer the repo, then run:
sudo bash /opt/mshin/scripts/setup_mcp_server.sh
```

When the script asks about a static IP, it will suggest the first non-loopback interface (usually `eth0` on a Pi). Accept it or enter `wlan0` if you must use Wi-Fi.

### 5. Verify the Node

```bash
curl http://localhost:3000/health
```

You should see all sixteen tools listed.

---

## Option B: Raspberry Pi OS + Kali repository

If you already run Raspberry Pi OS, you can graft the Kali tool packages onto it. This is less tested than the Kali image but works for most tools.

```bash
# Add the Kali repository
wget -q -O - https://archive.kali.org/archive-key.asc | sudo apt-key add -
echo "deb http://http.kali.org/kali kali-rolling main non-free contrib" | sudo tee /etc/apt/sources.list.d/kali.list
sudo apt update

# Install the Node toolset
sudo apt install -y nmap metasploit-framework exploitdb nikto whois tshark \
    hydra sqlmap gobuster masscan dirb arping dnsenum enum4linux ffuf john \
    net-tools git curl
```

Then continue from step 4 of Option A.

> **Warning:** Mixing Debian and Kali repositories can create package conflicts. Prefer the Kali Raspberry Pi image for a clean install.

---

## ARM-specific notes

- All sixteen tools are available for `arm64` (the Pi 4/5 64-bit OS). If you run a 32-bit OS, `masscan` and `metasploit-framework` may be unavailable or broken.
- `john` on ARM is CPU-only; hash cracking will be slower than on x86_64 with AVX.
- `masscan` on the Pi's shared USB/Ethernet bus can saturate quickly. Start with `--rate 100` and increase only if the Pi stays responsive.

---

## Connecting the Mac Mini Core to the Pi Node

On the Mac Mini (or other Core machine), point the CLI at the Pi's IP:

```bash
mshin 192.168.1.100
```

Replace `192.168.1.100` with the static IP you assigned to the Pi.

---

## Troubleshooting

### `sudo: a password is required` on tool calls

The `mshin` user's sudoers allowlist does not match the installed tool paths, or the systemd service picked up an old `--tools` list. Re-run `scripts/setup_mcp_server.sh` or restart the service after editing `mcp-kali.service`.

### Metasploit is very slow to start

This is expected on a Pi. The first launch builds the module cache. Subsequent launches are faster but still slower than on x86_64.

### Scans hang or the Pi becomes unresponsive

Reduce scan rates and thread counts:

- `masscan --rate 100`
- `nmap -T3` instead of `-T4` or `-T5`
- `ffuf -t 20` instead of the default 40

### `john` runs out of memory

Use smaller wordlists or add swap:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

Swap on microSD is slow; use a USB SSD if possible.

### Poor Wi-Fi scan performance

Use Ethernet. If you must use Wi-Fi, place the Pi close to the access point and avoid high-rate scans.

---

## Limitations

- The Pi Node is not a substitute for a fast x86_64 Kali box for heavy exploitation or large-scale scanning.
- `john` performance is CPU-only and modest.
- `metasploit-framework` starts slowly and large modules may time out at the default 600-second timeout. Raise `DEFAULT_TIMEOUT_MS` in `servers/src/kali/config.js` if needed.

---

## When to use a faster Node instead

Move to an x86_64 mini PC or SFF when:

- You run Metasploit regularly.
- You crack large hash lists with `john`.
- You scan large networks with `masscan` or `nmap` at high throughput.
- You notice scans timing out or the Pi swapping during normal use.

---

## Changelog

| Date | Change |
| ---- | ------ |
| 2026-09-11 | Initial Raspberry Pi Node guide |

---

*"Even a whisper can travel far in the Ways. So too can a Pi Node, when the hunt is light and the wind is right."*
