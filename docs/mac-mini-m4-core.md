# Machin Shin Core on Mac Mini M4 Pro 24GB

> *"The Stone of Tear stood unbroken, yet the Dragon banner flew above it. So too can a Mac Mini stand as your Core — silent, unassuming, yet mighty in the Pattern of your hunt."*

This guide covers running **Machin Shin Core** (LLM inference server + CLI) on a **Mac Mini M4 Pro with 24GB unified memory**, paired with a **Raspberry Pi Node** running either the Kali Linux Raspberry Pi image or Raspberry Pi OS with the Kali repository. This hybrid approach lets you use your Mac Mini for regular work when not running Machin Shin, while still providing a capable Core for the system.

The Mac Mini M4 Pro 24GB is **Tier 1** hardware for the Core role — comfortable for the default `mistral-small` (24B, ~14GB) model with headroom for context and tool use. See [Sizing the Core](architecture.md#sizing-the-core) for details.

---

## Overview

| Component | Role | This Setup | Notes |
| --------- | ---- | ---------- | ----- |
| **Mac Mini M4 Pro 24GB** | Machin Shin Core | Runs Ollama + CLI in a Lima VM (`mshin-core`) | Native ARM64, no Asahi Linux needed |
| **Raspberry Pi 4/5** | Machin Shin Node | Kali Linux ARM64 image or Pi OS + Kali repo | 4GB+ RAM recommended, 8GB preferred |
| **Network** | Core ↔ Node | Physical LAN (Ethernet strongly preferred) | `192.168.1.x` range as per conventions |

**Why this setup:**

- **No dual-boot / Asahi Linux required**: The Core runs in a Lima VM on macOS, so your Mac Mini remains a fully functional macOS machine for daily work.
- **Full ARM64 native performance**: The M4 Pro's Apple Silicon runs the Lima guest at native speed (no x86_64 emulation).
- **Proven tool compatibility**: The Node on Raspberry Pi runs the full sixteen-tool set via Kali's ARM64 packages.
- **Cost-effective**: Uses hardware you may already own; the only new purchase is a modest Raspberry Pi.

> **When to use this:** You want to run Machin Shin without dedicated hardware, repurposing a capable Mac Mini for the Core role while keeping macOS available for daily use.

> **When NOT to use this:** You need maximum inference speed (Lima guests have no GPU passthrough) or you plan to run very large models (>24B) that exceed 24GB RAM. For that, see [Tier 2 and 3 hardware](architecture.md#sizing-the-core) instead.

---

## Architecture: Mac Mini M4 Pro Edition

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  MAC MINI M4 PRO 24GB (macOS)                                                 │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │ Lima: mshin-core                                                    │   │
│  │ Ubuntu, aarch64 (native ARM64)                                     │   │
│  │                                                                     │   │
│  │  ┌──────────────────────┐   ┌────────────────────────────────────────┐  │   │
│  │  │ Ollama       :11434  │   │ Machin Shin CLI (MCP client)           │  │   │
│  │  │ mistral-small         │   │ - Bridges model to MCP Server         │  │   │
│  │  │ (24B, ~14GB)          │   │ - Runs on Core VM                      │  │   │
│  │  └──────────────────────┘   └────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                    │                                           │
│  macOS (your daily driver)         │  Ethernet/Wi-Fi                          │
│                                    ▼                                           │
└────────────────────────────────────┼───────────────────────────────────────┘
                                     │ Physical LAN (192.168.1.0/24)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  RASPBERRY PI (ARM64)                                                               │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │ Kali Linux / Raspberry Pi OS + Kali repo                             │   │
│  │                                                                     │   │
│  │  ┌──────────────────────┐   ┌────────────────────────────────────────┐  │   │
│  │  │ MCP Server    :3000  │   │ 16 Kali tools:                           │  │   │
│  │  │ - nmap, metasploit     │   │   nmap, searchsploit, nikto, whois,       │  │   │
│  │  │ - Runs as systemd     │   │   tshark, hydra, sqlmap, gobuster,      │  │   │
│  │  │   service             │   │   masscan, dirb, arping, dnsenum,        │  │   │
│  │  └──────────────────────┘   │   enum4linux, ffuf, john                 │  │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The Mac Mini runs **macOS natively** with a **single Lima VM** (`mshin-core`) hosting Ollama and the CLI. The Raspberry Pi runs **Kali Linux natively** (or Raspberry Pi OS with Kali repo) hosting the MCP server and tools. Both communicate over your **physical LAN** on `192.168.1.x` addresses.

---

## Prerequisites

### Hardware

| Item | Recommendation | Notes |
| ---- | --------------- | ----- |
| **Mac Mini M4 Pro** | 24GB unified memory | 8-core CPU (4P+4E), 10-core GPU. ARM64 native. |
| **Raspberry Pi** | Pi 4 (4GB+) or Pi 5 (8GB preferred) | Pi 5 recommended for better CPU and NIC performance |
| **Storage (Mac)** | 512GB+ SSD | Enough for Lima VMs, Ollama models, and macOS |
| **Storage (Pi)** | 64GB+ microSD or USB SSD | Kali image + tools + swap. SSD strongly preferred |
| **Network** | Ethernet cable + switch/router | Wi-Fi *works* but adds latency and drops packets during scans |

### Software (Mac Mini)

```bash
# Install Lima
brew install lima

# Install socket_vmnet (required for Lima networking)
# See lima-local-dev.md for the proper root-owned install:
#   git clone https://github.com/lima-vm/socket_vmnet
#   cd socket_vmnet && git checkout v1.2.2 && make
#   sudo make PREFIX=/opt/socket_vmnet install.bin
#   limactl sudoers | sudo tee /etc/sudoers.d/lima

# Verify installations
limactl --version    # Should show 2.0+
```

> **Note:** The Lima VM uses the **shared vmnet network** internally, but the **Core VM communicates with the Raspberry Pi Node over your physical LAN**, not through vmnet. This is different from the [full Lima local dev setup](lima-local-dev.md) which uses vmnet for VM-to-VM communication.

---

## Setup

There are two main paths through this setup:

| Path | Core | Node | Good for |
| ---- | ----- | ---- | -------- |
| **Path A (Recommended)** | Lima VM on Mac Mini | Kali Linux Raspberry Pi image on Pi | Cleanest, most tested |
| **Path B** | Lima VM on Mac Mini | Raspberry Pi OS + Kali repository | If you already have Pi OS running |

Both paths use the **same Core setup** on the Mac Mini. The difference is only in how the Raspberry Pi Node is provisioned.

---

### Step 1: Set Up Mac Mini M4 Pro as Core

The Mac Mini runs **one Lima VM** (`mshin-core`) that hosts:
- Ubuntu LTS (aarch64, native ARM64)
- Ollama with the `mistral-small` (24B) model
- The `mshin` persona (built from `configs/ollama-modelfile`)
- The Machin Shin CLI client

#### 1.1 Create the Core VM from Template

```bash
# Clone this repo if you haven't already
git clone https://github.com/imagewize/mshin.git
cd mshin

# Create and start the Core VM
limactl create --name=mshin-core lima/mshin-core.yaml
limactl start mshin-core
```

On first boot, the template:
1. Installs Node.js 20 and Ollama
2. Pulls the `mistral` model (7B, ~4GB) by default — **we'll upgrade this to `mistral-small` after**
3. Clones this repo to `/opt/mshin`
4. Installs the CLI's dependencies
5. Symlinks the CLI to `/usr/local/bin/mshin`
6. Builds the `mshin` persona

Wait for `limactl start` to return (it blocks until provisioning completes).

> **Template note:** `lima/mshin-core.yaml` defaults to `model: mistral` (7B) because Lima guests typically have limited RAM. We will override this for the Mac Mini's 24GB.

#### 1.2 Upgrade to mistral-small (24B) Model

The Mac Mini M4 Pro's 24GB unified memory can comfortably run `mistral-small` (24B, ~14GB weights). The Lima guest needs enough RAM allocated to hold it.

```bash
# Stop the VM first
limactl stop mshin-core

# Edit the instance to allocate more RAM (16GB for the guest)
# This leaves ~8GB for macOS and overhead
limactl edit mshin-core --set '.memory="16GiB"'

# Restart the VM
limactl start mshin-core

# Shell into the VM
limactl shell mshin-core
```

Inside the Core VM:

```bash
# Pull mistral-small (24B)
ollama pull mistral-small

# Rebuild the mshin persona on the 24B model
# The template built it on 'mistral' (7B); rebuild on mistral-small
sed 's|^FROM .*|FROM mistral-small|' /opt/mshin/configs/ollama-modelfile > /tmp/Modelfile
ollama create mshin -f /tmp/Modelfile

# Verify the model is loaded
ollama list
# Should show: mshin    latest  mistral-small   ...

# Test the persona
ollama run mshin
# Type a test prompt, then Ctrl-D to exit
```

> **Memory allocation rationale:** 16GB for the Lima guest on a 24GB Mac leaves ~8GB for macOS, the VM overhead, and your daily work. This fits `mistral-small` (~14GB weights + ~5GB KV cache at 32k context) comfortably. If you find the host constrained, reduce to 14GB guest (`--set '.memory="14GiB"'`) and accept a smaller context window.

#### 1.3 Configure the CLI for External Node

The CLI needs to point at your **Raspberry Pi Node's IP** (on your physical LAN), not `localhost`. We'll configure this after setting up the Pi, but note the pattern:

```bash
# From within the Core VM, the pattern is:
/opt/mshin/clients/mshin-cli/index.js --node http://<PI_IP>:3000 --model mshin

# Or, using the symlink:
mshin --node http://<PI_IP>:3000 --model mshin
```

---

### Step 2: Set Up Raspberry Pi as Node

Choose **one** of the following paths. Path A (Kali Linux Raspberry Pi image) is recommended.

#### Path A: Kali Linux Raspberry Pi Image (Recommended)

This is the cleanest path and mirrors the [Raspberry Pi Node guide](raspberry-pi-node.md) exactly.

##### 2.1 Flash the Image

Download the **Kali Linux Raspberry Pi ARM64 image** from [kali.org/get-kali](https://www.kali.org/get-kali/) — look for `kali-linux-2026.2-raspberry-pi-arm64.img.xz`.

Flash it to your microSD or USB SSD:

```bash
# On your Mac Mini
curl -LO https://cdimage.kali.org/kali-images/raspberry-pi/kali-2026.2-raspberry-pi-arm64.img.xz
xz -d kali-2026.2-raspberry-pi-arm64.img.xz

# Find your SD card device (use diskutil list, look for external physical disk)
diskutil list

# Unmount (don't eject) the device - replace diskN with your actual device
sudo diskutil unmountDisk /dev/diskN

# Write the image - BE VERY CAREFUL with the target device
sudo dd if=kali-2026.2-raspberry-pi-arm64.img of=/dev/rdiskN bs=4m status=progress

# Eject when done
sudo diskutil eject /dev/diskN
```

> **Warning:** `of=/dev/rdiskN` writes directly to the device. **Double-check the device name** — writing to the wrong disk will destroy data.

##### 2.2 First Boot and Configuration

Insert the storage into the Pi, connect **Ethernet** (strongly preferred), and power on.

Find the Pi on your LAN:

```bash
# From your Mac Mini (macOS side)
nmap -sn 192.168.1.0/24
```

Look for the new host (likely `192.168.1.x`). SSH in:

```bash
# Default Kali credentials: kali / kali
ssh kali@<PI_IP>

# Change the password immediately
passwd
```

##### 2.3 Expand Filesystem

```bash
# On the Pi
sudo raspi-config
# Advanced Options -> Expand Filesystem -> Reboot
```

##### 2.4 Set Static IP (Optional but Recommended)

Edit `/etc/dhcpcd.conf`:

```bash
sudo nano /etc/dhcpcd.conf
```

Add at the bottom:

```
# Machin Shin Node - static IP
interface eth0
static ip_address=192.168.1.100/24
static routers=192.168.1.1
static domain_name_servers=8.8.8.8 8.8.4.4
```

Apply:

```bash
sudo service dhcpcd restart
```

> **Note:** This follows the [Network conventions](CLAUDE.md) — Node at `192.168.1.100`, Core at `192.168.1.200`. If you already have a device at `.100`, pick another unused address in the range.

##### 2.5 Run the Machin Shin Node Setup Script

```bash
# On the Pi, as a user with sudo
sudo bash -c 'apt update && apt install -y git curl'
git clone https://github.com/imagewize/mshin.git /opt/mshin
sudo bash /opt/mshin/scripts/setup_mcp_server.sh
```

The script:
1. Installs all sixteen tools from Kali repositories
2. Installs Node.js 20+
3. Sets up the `mshin` user and sudoers allowlist
4. Installs the MCP server as a systemd service
5. Starts and enables the service

When prompted for a static IP, enter `eth0` (or `wlan0` if you must use Wi-Fi).

##### 2.6 Verify the Node

```bash
# On the Pi
curl http://localhost:3000/health
```

You should see JSON listing all sixteen tools.

From your **Mac Mini's macOS** (to test connectivity):

```bash
curl http://192.168.1.100:3000/health
```

#### Path B: Raspberry Pi OS + Kali Repository

If you already have **Raspberry Pi OS** running on your Pi, you can graft the Kali tool packages onto it.

> **Warning:** Mixing Debian (Pi OS) and Kali repositories can create package conflicts. Prefer [Path A](#path-a-kali-linux-raspberry-pi-image-recommended) for a clean install.

##### 2.1 Add Kali Repository

```bash
# On the Pi
wget -q -O - https://archive.kali.org/archive-key.asc | sudo apt-key add -
echo "deb http://http.kali.org/kali kali-rolling main non-free contrib" | sudo tee /etc/apt/sources.list.d/kali.list
sudo apt update
```

##### 2.2 Install the Toolset

```bash
# Install all sixteen tools
sudo apt install -y nmap metasploit-framework exploitdb nikto whois tshark \
    hydra sqlmap gobuster masscan dirb arping dnsenum enum4linux ffuf john \
    net-tools git curl
```

##### 2.3 Set Up the MCP Server

```bash
# Clone the repo
git clone https://github.com/imagewize/mshin.git /opt/mshin

# Install Node.js 20+
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

# Install MCP server dependencies
cd /opt/mshin/servers/src/kali
npm install

# Create the mshin user
sudo adduser mshin
sudo usermod -aG sudo mshin

# Set up sudoers allowlist
sudo tee /etc/sudoers.d/mshin >/dev/null <<'EOF'
# tshark is omitted - see docs/raspberry-pi-node.md for rationale
mshin ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/nikto, /usr/bin/whois, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/hydra, /usr/bin/sqlmap, /usr/bin/gobuster, /usr/bin/masscan, /usr/bin/dirb, /usr/bin/arping, /usr/bin/dnsenum, /usr/bin/enum4linux, /usr/bin/ffuf, /usr/bin/john
EOF
sudo chmod 440 /etc/sudoers.d/mshin

# Install systemd service
sudo cp /opt/mshin/configs/mcp-kali.service /etc/systemd/system/mshin-node.service
sudo sed -i "s|^User=.*|User=mshin|" /etc/systemd/system/mshin-node.service
sudo sed -i "s|^ReadWritePaths=.*|ReadWritePaths=/opt/mshin /home/mshin|" /etc/systemd/system/mshin-node.service
sudo systemctl daemon-reload
sudo systemctl enable --now mshin-node
```

##### 2.4 Verify the Node

```bash
curl http://localhost:3000/health
```

---

### Step 3: Connect Core to Node

Now that both components are running, connect them.

#### 3.1 Configure Static IP for Core (Optional)

On your **Mac Mini's macOS**, set a static IP to match the conventions:

```bash
# Find your network interface name
networksetup -listallnetworkservices

# Set manual IP (replace en0 with your interface)
sudo networksetup -setmanual "Wi-Fi" 192.168.1.200 255.255.255.0 192.168.1.1

# Or for Ethernet
sudo networksetup -setmanual "Ethernet" 192.168.1.200 255.255.255.0 192.168.1.1
```

> **Note:** This sets the **macOS host** IP. The Lima VM (`mshin-core`) shares the host's network and will be reachable at this address from other devices on your LAN. However, **from within the Core VM itself**, use `localhost` to reach services running on macOS, and the Pi's IP (`192.168.1.100`) to reach the Node.

#### 3.2 Test Connectivity

From the **Core VM**:

```bash
limactl shell mshin-core

# Test reaching the Pi Node
ping -c 3 192.168.1.100

# Test the MCP server
curl http://192.168.1.100:3000/health
```

You should see the list of sixteen tools.

#### 3.3 Start the CLI

```bash
# From within the Core VM
mshin --node http://192.168.1.100:3000 --model mshin
```

> **Tip:** Create an alias for convenience. In the Core VM:
> ```bash
> echo "alias mshin-node='mshin --node http://192.168.1.100:3000 --model mshin'" >> ~/.bashrc
> source ~/.bashrc
> ```
> Then just run `mshin-node` to start.

#### 3.4 Test the System

Try a prompt:

```
"Machin Shin, run an Nmap scan on 192.168.1.1 and summarize the open ports."
```

The system should:
1. Call `nmap` on the Raspberry Pi Node
2. Return the scan results
3. Summarize the findings

---

## Usage

### Starting the Environment

```bash
# On Mac Mini (macOS)

# Start the Core VM (if not already running)
limactl start mshin-core

# Shell into Core VM
limactl shell mshin-core

# Start the CLI
mshin --node http://192.168.1.100:3000 --model mshin
```

> **Note:** The Raspberry Pi Node should already be running (it's a physical machine, not a VM). If you rebooted it, SSH in and run `sudo systemctl start mshin-node`.

### Stopping the Environment

```bash
# From macOS - stop the Core VM
limactl stop mshin-core

# On the Raspberry Pi - stop the Node service
ssh kali@192.168.1.100
sudo systemctl stop mshin-node
```

### Switching Models

To try a different model on the Core:

```bash
# Shell into Core VM
limactl shell mshin-core

# List models
ollama list

# Pull a different model (if you have the RAM)
# Options that fit in 16GB guest:
# - mistral-small (24B, ~14GB) - default, strongest
# - qwen3:32b (~20GB) - does NOT fit in 16GB
# - llama3.3:70b (~40GB) - does NOT fit in 16GB
offset

# For example, try a smaller model for testing:
ollama pull phi3:3.8b

# Rebuild the persona on the new base
sed 's|^FROM .*|FROM phi3:3.8b|' /opt/mshin/configs/ollama-modelfile > /tmp/Modelfile
ollama create mshin -f /tmp/Modelfile

# Restart the CLI to use the new persona
mshin --node http://192.168.1.100:3000 --model mshin
```

---

## Performance Considerations

### Mac Mini M4 Pro as Core

| Aspect | Performance | Notes |
| ------ | ----------- | ----- |
| **Inference Speed** | ~15-20 tokens/sec (mistral-small) | CPU-only; M4 GPU not accessible to Lima VM |
| **Model Capacity** | Up to 24B (mistral-small) | In 16GB guest allocation |
| **Context Length** | ~32k tokens | Limited by KV cache memory |
| **Power Consumption** | ~15-20W | Efficient ARM64 CPU |

> **GPU Acceleration Note:** Lima does **not** pass through Mac GPU to VMs as of 2026. The Ollama instance in the Lima VM runs **CPU-only inference**. This is slower than native macOS Ollama (which can use the M4 GPU via Metal), but provides clean isolation. For GPU acceleration, see [Alternative: Host Ollama](#alternative-host-ollama-on-macos) below.

### Raspberry Pi as Node

| Tool Category | Performance | Notes |
| ------------- | ----------- | ----- |
| Light scanners (nmap, nikto, whois) | Full speed | ARM64 native |
| Heavy tools (metasploit, john, masscan) | Slow/constrained | See raspberry-pi-node.md for details |

> **See also:** [What works well on a Pi](raspberry-pi-node.md#what-works-well-on-a-pi) and [What will be slow](raspberry-pi-node.md#what-will-be-slow-or-constrained)

---

## Alternative: Host Ollama on macOS

For **maximum inference speed**, you can run Ollama **natively on macOS** (accessing the M4 GPU via Metal) and only run the **Core VM for the CLI client**. This is a hybrid approach:

- **Ollama**: Runs natively on macOS (GPU-accelerated)
- **CLI**: Runs in the Lima VM (or natively on macOS)
- **Node**: Runs on Raspberry Pi

### Setup

1. Install Ollama natively on macOS:

```bash
brew install ollama
ollama pull mistral-small
offset
```

2. Build the persona on macOS:

```bash
sed 's|^FROM .*|FROM mistral-small|' /opt/mshin/configs/ollama-modelfile > /tmp/Modelfile
ollama create mshin -f /tmp/Modefile
```

3. Run the CLI from macOS (no VM needed):

```bash
# Install the CLI dependencies natively
cd /opt/mshin/clients/mshin-cli
npm install

# Run the CLI, pointing to your Pi Node and local Ollama
node index.js --node http://192.168.1.100:3000 --ollama http://localhost:11434 --model mshin
```

> **Pros:** Full GPU acceleration, ~30-50 tokens/sec for mistral-small on M4 GPU.
> **Cons:** Less isolation; Ollama runs alongside your daily macOS workloads.

---

## Troubleshooting

### Core VM Issues

| Issue | Diagnosis | Solution |
| ----- | --------- | -------- |
| VM won't start | `limactl list` shows error | `limactl delete mshin-core` and recreate |
| Model won't load | `ollama list` shows model but `ollama run` fails | Check RAM: the guest may need more memory |
| Slow inference | Tokens/sec is low | Expected for CPU-only; use smaller model or [host Ollama](#alternative-host-ollama-on-macos) |
| `limactl create` fails | socket_vmnet not installed | Follow [shared networking setup](lima-local-dev.md#shared-networking-required-for-two-vms) |

### Node (Raspberry Pi) Issues

See the [Raspberry Pi Node troubleshooting section](raspberry-pi-node.md#troubleshooting) for Node-specific issues.

### Connection Issues

| Issue | Diagnosis | Solution |
| ----- | --------- | -------- |
| Core can't reach Node | `ping 192.168.1.100` fails | Check both devices are on same network |
| MCP connection refused | `curl http://192.168.1.100:3000/health` fails | Check MCP server is running on Pi: `sudo systemctl status mshin-node` |
| CLI hangs | CLI starts but doesn't respond to prompts | Check Ollama is running in Core VM: `ollama list` |

### Common Commands

**Core VM (Lima):**
```bash
# List VMs
limactl list

# Start/stop VM
limactl start mshin-core
limactl stop mshin-core

# Shell into VM
limactl shell mshin-core

# Delete VM
limactl delete mshin-core

# Edit VM configuration
limactl edit mshin-core
```

**Raspberry Pi Node:**
```bash
# Check MCP server status
sudo systemctl status mshin-node

# View MCP server logs
sudo journalctl -u mshin-node -f

# Restart MCP server
sudo systemctl restart mshin-node

# Test MCP server
curl http://localhost:3000/health
```

---

## Limitations

1. **No GPU acceleration in VM**: Lima does not pass through Mac GPU, so Ollama in the Core VM runs CPU-only. Inference is functional but not optimal.
2. **Shared Mac resources**: The Core VM competes with macOS and your daily workloads for CPU and RAM.
3. **Raspberry Pi constraints**: Heavy tools (metasploit, john with large wordlists, masscan at high rates) will be slow or memory-constrained.
4. **Network latency**: Ethernet is strongly preferred; Wi-Fi adds latency and can drop packets during scans.

---

## When to Use a Different Setup

Consider a different architecture when:

- **You need faster inference**: Use [native macOS Ollama](#alternative-host-ollama-on-macos) for GPU acceleration
- **You run heavy Node tools regularly**: Move the Node to an x86_64 mini PC (Intel N100/N150, etc.)
- **You need larger models**: Upgrade to a Core machine with 48GB+ RAM for Qwen3 32B or Llama 3.3 70B
- **You want production use**: Follow the [full two-machine setup](setup.md) with dedicated hardware

---

## Comparison: This Setup vs. Alternatives

| Setup | Core Hardware | Node Hardware | Inference Speed | Tool Speed | Isolation | Cost |
| ----- | ------------ | ------------- | --------------- | ---------- | ---------- | ---- |
| **This guide** | Mac Mini M4 Pro (Lima VM) | Raspberry Pi | CPU-only (~15-20 tok/s) | ARM64 native | Good | $0 (if you own Mac + Pi) |
| [Full Setup](setup.md) | 32GB+ x86_64 Linux box | x86_64 mini PC | GPU possible | x86_64 native | Excellent | ~$350-600 |
| [Lima Local Dev](lima-local-dev.md) | Mac (Lima VM) | Mac (Lima VM) | CPU-only | Emulated x86_64 | Good | $0 |
| Host Ollama | Mac (native) | Raspberry Pi | GPU (~30-50 tok/s) | ARM64 native | Limited | $0 (if you own Mac + Pi) |

---

## Resources

- [Mac Mini M4 Pro Specifications](https://www.apple.com/mac-mini/specs/) — Apple Silicon M4, 24GB unified memory
- [Lima Documentation](https://github.com/lima-vm/lima) — macOS virtual machines
- [Ollama Documentation](https://github.com/jmorganca/ollama) — LLM runtime
- [Kali Linux ARM](https://www.kali.org/docs/arm/) — ARM64 support
- [Raspberry Pi Node Guide](raspberry-pi-node.md) — Node setup details
- [Machin Shin Architecture](architecture.md) — System design and sizing
- [Lima Local Dev Guide](lima-local-dev.md) — Full VM-based development

---

## Changelog

| Date | Change | Author |
| ---- | ------ | ------ |
| 2026-09-11 | Initial Mac Mini M4 Pro Core guide with Raspberry Pi Node | Jasper Frumau |

---

## The Pattern on Apple Silicon

> *"The Aiel do not avoid the Way of the Leaf out of fear, but out of knowledge. They know the cost. So too must you know the cost of your choices: the Mac Mini's GPU idle, the Pi's patience with heavy tools. But in this Pattern, both serve the hunt, and the hunt goes on."*

The Wheel weaves as the Wheel wills. With Mac Mini M4 Pro and Raspberry Pi, you weave a Pattern that bends to your needs — silent when you work, relentless when you hunt.
