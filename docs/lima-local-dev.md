# Avendesora Local Development with Lima

> *"The Two Rivers had its wisdom, and the Wisdom of the Two Rivers was this: as the leaf flows, so flows the river. A leaf on the wind, a leaf on the stream, a leaf on the current of the Pattern — and Avendesora flows with you, even on a single machine."*

This guide describes how to run a **local, single-machine Avendesora development environment** on macOS using **Lima VMs**, **Ollama with Mistral 8B**, and **Kali Linux tools** — a lightweight alternative to the recommended two-machine setup for learning, testing, and small-scale experimentation.

---

## Overview

The standard [Avendesora architecture](architecture.md) uses two physical machines:
- **Avendesora Core**: LLM inference server (32GB+ RAM)
- **Avendesora Node**: Kali Linux + MCP server (x86_64 mini PC)

For **local development, testing, or constrained hardware**, you can consolidate both roles into **Lima VMs running on a single macOS host**. This approach:

| Aspect | Full Setup | Lima Local Dev |
| ------ | ---------- | -------------- |
| Machines | 2 physical boxes | 1 macOS host + Lima VMs |
| Cost | ~$150-350 (for the Node) | $0 (uses existing Mac) |
| Performance | Full speed | Slower (VM overhead, shared resources) |
| Scale | Production-ready | Learning / testing only |
| Network | Physical LAN | Virtual network (localhost) |

> **When to use this:** Learning the system, testing workflows, developing the MCP server, or experimenting with smaller models when you don't have a second x86_64 machine.

> **When NOT to use this:** Running production scans, handling sensitive data, or needing full performance. The two-machine setup remains the recommended path.

---

## Architecture: Lima Edition

```
┌─────────────────────────────────────────────────────────────┐
│                     macOS HOST (YOUR MAC)                       │
│                                                                  │
│  ┌──────────────────────┐    ┌──────────────────────┐      │
│  │   Lima: Core VM       │    │   Lima: Kali Node VM  │      │
│  │  (Ubuntu/Debian)      │    │   (Kali Linux)        │      │
│  │                       │    │                       │      │
│  │  ┌─────────────────┐ │    │  ┌─────────────────┐  │      │
│  │  │  Ollama          │ │    │  │  MCP Server      │  │      │
│  │  │  - mistral      │◄─┼───►│  │  - Kali tools    │  │      │
│  │  │  (~4GB VRAM)     │ │    │  │  - Nmap, etc.    │  │      │
│  │  └─────────────────┘ │    │  └─────────────────┘  │      │
│  │  ┌─────────────────┐ │    │                       │      │
│  │  │  Avendesora CLI  │ │    │                       │      │
│  │  │  (MCP Client)    │ │    │                       │      │
│  │  └─────────────────┘ │    │                       │      │
│  └──────────────────────┘    └──────────────────────┘      │
│                     └──────────────────────────────────┘      │
│                              Virtual Network                    │
│                         (192.168.100.0/24)                      │
└─────────────────────────────────────────────────────────────┘
```

Both VMs run as **Lima instances** on your Mac, communicating over a **shared virtual network** (192.168.100.0/24 by convention). The Core VM runs Ollama with a smaller model (Mistral 8B fits in ~5GB), and the Kali Node VM runs the MCP server with Kali tools.

---

## Prerequisites

### Hardware (Your Mac)

| Requirement | Minimum | Recommended | Notes |
| ----------- | ------- | ----------- | ----- |
| **CPU** | Apple Silicon (M1+) or Intel x86_64 | M1 Pro/Max/M2+ | x86_64 Macs can run Kali natively in Lima |
| **RAM** | 16GB | 32GB+ | Each VM needs 8-16GB; they share your Mac's RAM |
| **Disk** | 100GB free | 200GB+ free | VM disks + Ollama models (~4-6GB for mistral) |
| **OS** | macOS Ventura+ | macOS Tahoe (26.6.2) | Lima requires macOS 11.4+ |

> **Check your resources:** Run `sysctl hw.memsize` (RAM in bytes) and `df -h /` (disk space). Free up at least 100GB of disk and 16GB RAM for a smooth experience.

### Software

```bash
# Install Lima (if not already installed)
brew install lima

# Install Ollama
brew install ollama

# Verify installations
lima --version    # Should show 0.20+
ollama --version   # Should show 0.33+
```

> **Note:** Lima uses **qemu** for x86_64 emulation on Apple Silicon. Performance will be slower than native, but functional.

---

## Setup

### Step 1: Create the Kali Node Lima VM

The Kali Node VM runs **Kali Linux** with the **Avendesora MCP server** and Kali tools.

#### Option A: Kali Linux (x86_64, Recommended for Intel Macs)

If you have an **Intel Mac**, you can run Kali Linux natively:

```bash
# Create a Kali Linux VM
limactl create --name=avendesora-kali \
  --os=debian \
  --arch=x86_64 \
  --cpus=4 \
  --memory=8GiB \
  --disk=50GiB \
  --dns=8.8.8.8 \
  --ip=192.168.100.100
```

Then, **after creation**, we'll transform it into a Kali environment.

#### Option B: Debian with Kali Tools (Apple Silicon / Universal)

For **Apple Silicon Macs**, use a Debian base and install Kali tools:

```bash
# Create a Debian VM (works on both Apple Silicon and Intel)
limactl create --name=avendesora-kali \
  --os=debian \
  --arch=aarch64 \
  --cpus=4 \
  --memory=8GiB \
  --disk=50GiB \
  --dns=8.8.8.8 \
  --ip=192.168.100.100
```

> **Note on Apple Silicon:** Running x86_64 Kali in qemu emulation on M1/M2 Macs is possible but **very slow**. The Debian + Kali tools approach (Option B) is much more practical.

#### Start and Configure the Kali Node VM

```bash
# Start the VM
limactl start avendesora-kali

# SSH into the VM
limactl shell avendesora-kali
```

Now, inside the VM, set up Kali tools:

```bash
# Update and upgrade
sudo apt update && sudo apt upgrade -y

# Install Node.js v20+ (required for MCP server)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Install Kali tools
sudo apt install -y nmap nikto whois tshark sqlmap metasploit-framework searchsploit

# Verify installation
nmap --version
nikto -Version
```

> **For Option A (Intel Mac with Kali OS):** You can skip the `apt install` of Kali tools if you started from a Kali image. However, as of 2026, Lima doesn't have a built-in Kali OS template, so Option B (Debian + tools) is the practical path.

#### Set Up the MCP Server

Inside the Kali Node VM:

```bash
# Clone Avendesora (or copy from host)
# Option 1: Clone directly (if VM has internet)
git clone https://github.com/jasperfrumau/avendesora.git /opt/avendesora

# Option 2: Or copy from your Mac host (replace with actual path)
# On your Mac: rsync -avz /Users/jasperfrumau/code/avendesora/ avendesora-kali:/opt/

# Install MCP server dependencies
cd /opt/avendesora/servers/src/kali
npm install

# Test the MCP server
node index.js --tools nmap,nikto,whois,tshark,searchsploit &

# Install as a systemd service (if systemd is available)
# For Lima VMs without systemd, use a simple approach:
cat > /home/$(whoami)/start-mcp.sh << 'EOF'
#!/bin/bash
cd /opt/avendesora/servers/src/kali
node index.js --tools nmap,nikto,whois,tshark,searchsploit
EOF
chmod +x /home/$(whoami)/start-mcp.sh

# Add to .bashrc for auto-start
echo "nohup /home/$(whoami)/start-mcp.sh > /tmp/mcp.log 2>&1 &" >> ~/.bashrc
```

> **Note:** Lima VMs typically use **containerd init** rather than systemd. The `.bashrc` approach above ensures the MCP server starts when you shell in.

---

### Step 2: Create the Core Lima VM

The Core VM runs **Ollama** with your LLM and the **Avendesora CLI client**.

```bash
# Create the Core VM
limactl create --name=avendesora-core \
  --os=ubuntu \
  --arch=aarch64 \
  --cpus=4 \
  --memory=16GiB \
  --disk=50GiB \
  --dns=8.8.8.8 \
  --ip=192.168.100.200

# Start the VM
limactl start avendesora-core

# SSH into the VM
limactl shell avendesora-core
```

Inside the Core VM:

```bash
# Update and install dependencies
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model that fits in the VM's RAM
# Options that work well in Lima VMs:
# - mistral (7B, ~4GB) - Official Mistral AI 7B model
# - qwen2:7b (7B, ~4GB) - Fast and capable
# - phi3:3.8b (3.8B, ~2GB) - Very lightweight
ollama pull mistral

# Verify
ollama list
```

#### Create the Avendesora Persona Model

```bash
# Clone Avendesora repo (if not already present)
git clone https://github.com/jasperfrumau/avendesora.git /opt/avendesora

# Create the model
ollama create avendesora -f /opt/avendesora/configs/ollama-modelfile

# Verify
ollama list
```

#### Install the Avendesora CLI Client

```bash
cd /opt/avendesora/clients/avendesora-cli
npm install
```

---

### Step 3: Configure Networking

Lima automatically creates a **shared virtual network** for all VMs. Verify connectivity:

```bash
# From the Core VM, ping the Kali Node VM
ping 192.168.100.100

# From the Core VM, test MCP server connection
curl http://192.168.100.100:3000/health
```

If the connection fails:

1. **Verify both VMs are running:**
   ```bash
   limactl list
   ```

2. **Check IP addresses:**
   ```bash
   # On Core VM
   ip a
   
   # On Kali Node VM
   ip a
   ```

3. **Test MCP server manually:**
   ```bash
   # On Kali Node VM, start the server manually
   cd /opt/avendesora/servers/src/kali
   node index.js --tools nmap,nikto,whois
   ```

---

### Step 4: Connect and Test

From the **Core VM**, run the Avendesora CLI:

```bash
# Start an interactive session
/opt/avendesora/clients/avendesora-cli/index.js --node http://192.168.100.100:3000 --model avendesora
```

Or, for a simpler test:

```bash
# Run a direct Ollama session with MCP context
export MCP_NODE_URL=http://192.168.100.100:3000
ollama run avendesora
```

Then, try a command:

```
"Avendesora, run an Nmap scan on 127.0.0.1 and show me the results."
```

> **Note:** The first run may take a moment as the MCP server connects and validates available tools.

---

## Usage

### Starting the Environment

```bash
# Start both VMs
limactl start avendesora-kali
limactl start avendesora-core

# Shell into Core VM
limactl shell avendesora-core

# Start the Avendesora CLI
/opt/avendesora/clients/avendesora-cli/index.js --node http://192.168.100.100:3000 --model avendesora
```

### Stopping the Environment

```bash
# Stop both VMs
limactl stop avendesora-kali
limactl stop avendesora-core
```

### Managing Models

To try different models in the Core VM:

```bash
# List available models
ollama list

# Pull a different model (if you have the RAM)
ollama pull qwen2:7b

# Recreate the avendesora persona with a different base
ollama create avendesora -f /opt/avendesora/configs/ollama-modelfile

# Remove old models to free space
ollama rm mistral
```

> **Model recommendations for Lima:**
> - `mistral` (7B, ~4GB) - Official Mistral AI model, good balance
> - `qwen2:7b` (7B, ~4GB) - Fast and capable
> - `phi3:3.8b` (3.8B, ~2GB) - Very light, fast
> - `llama3.2:3b` (3B, ~2GB) - Good for testing
> - `ministral-3:8b` (8B, ~6GB) - Community Mistral variant (if already pulled)

---

## Alternative: Single VM (All-in-One)

For **maximum simplicity** (at the cost of isolation), you can run everything in **one Lima VM**:

```bash
# Create a single VM
limactl create --name=avendesora-allinone \
  --os=ubuntu \
  --arch=aarch64 \
  --cpus=8 \
  --memory=16GiB \
  --disk=80GiB \
  --dns=8.8.8.8

limactl start avendesora-allinone
limactl shell avendesora-allinone
```

Inside the VM:

```bash
# Install all dependencies
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git curl nmap nikto whois tshark

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull model
ollama pull mistral

# Clone Avendesora
git clone https://github.com/jasperfrumau/avendesora.git /opt/avendesora

# Create avendesora model
ollama create avendesora -f /opt/avendesora/configs/ollama-modelfile

# Start MCP server in background
cd /opt/avendesora/servers/src/kali
npm install
node index.js --tools nmap,nikto,whois,tshark &

# Start Avendesora CLI in another session
/opt/avendesora/clients/avendesora-cli/index.js --node http://localhost:3000 --model avendesora
```

> **Pros:** Simplest setup, single VM to manage
> **Cons:** Less isolation, tools and LLM share resources, MCP server runs on localhost

---

## Performance Considerations

### Resource Allocation

| VM | CPUs | Memory | Disk | Notes |
| ---- | ---- | ------ | ---- | ----- |
| Kali Node | 2-4 | 4-8GB | 30-50GB | Tools don't need much RAM |
| Core | 4-8 | 8-16GB | 30-50GB | Needs RAM for models |

**Total:** 8-12 CPUs, 16-24GB RAM, 80-120GB disk

> **Adjust based on your Mac:** If you have 32GB RAM, allocate 12GB to Core and 4GB to Kali Node. If you have 16GB, use 8GB+8GB split.

### Apple Silicon Notes

1. **x86_64 emulation:** Running x86_64 Kali in qemu on M1/M2 Macs works but is **slow** (~10-20x slower than native).
2. **aarch64 Kali:** As of 2026, Kali Linux has **official ARM64 support**. You can build a custom Lima template:
   ```bash
   # Create a custom Lima template for Kali ARM64
   lima-ctl create --name=avendesora-kali-arm \
     --os=https://cdimage.kali.org/kali-2026.2/kali-linux-2026.2-installer-arm64.iso \
     --arch=aarch64 \
     --cpus=4 \
     --memory=8GiB \
     --disk=50GiB
   ```
   > **Note:** ISO-based Lima VMs require more setup. Check the [Lima documentation](https://github.com/lima-vm/lima) for details.

### GPU Acceleration

Lima does **not** currently pass through Mac GPU to VMs (as of 2026). Ollama in the VM will use **CPU-only inference**, which is slower but functional for 8B models.

For better performance:
- Use **smaller models** (8B or smaller)
- Use **quantized models** (Q4_K_M is the default, Q2_K is smaller/faster)
- Accept **slower token generation** (~2-5 tokens/sec for 8B on CPU)

---

## Troubleshooting

| Issue | Diagnosis | Solution |
| ----- | --------- | -------- |
| VM won't start | `limactl list` shows error | `limactl delete <name>` and recreate |
| MCP connection refused | `curl http://192.168.100.100:3000/health` fails | Check MCP server is running in Kali VM |
| Ollama model won't load | `ollama list` shows model, but `ollama run` fails | Check VRAM: `free -h`; model may be too large |
| Slow performance | VMs are responsive but slow | Reduce CPU/memory allocation or use smaller model |
| `limactl create` fails | Permission or disk space | Run `brew update && brew upgrade lima` |
| Kali tools not found | `nmap` command not found | Reinstall tools: `sudo apt install -y nmap` |

### Common Commands

```bash
# List all VMs
limactl list

# List running VMs
limactl list --running

# Shell into a VM
limactl shell <name>

# Stop a VM
limactl stop <name>

# Delete a VM (permanent!)
limactl delete <name>

# View VM logs
limactl logs <name>

# Edit VM configuration
limactl edit <name>
```

### Cleaning Up

To free up disk space:

```bash
# Remove stopped VMs
limactl delete avendesora-kali
limactl delete avendesora-core

# Remove all Lima data
limactl prune

# On your Mac, remove Ollama cache (if installed natively)
rm -rf ~/.ollama
```

---

## Comparison: Lima vs. Full Setup

| Feature | Lima Local Dev | Full Two-Machine Setup |
| ------- | -------------- | ---------------------- |
| **Cost** | $0 (uses Mac) | ~$150-350 (mini PC) |
| **Performance** | Slow (VM overhead, CPU-only) | Full speed (native, optional GPU) |
| **RAM for models** | Limited by Mac RAM | Dedicated Core machine (32GB+) |
| **Tool execution** | In VM (emulated) | Native x86_64 (fast) |
| **Network** | Virtual (localhost) | Physical LAN |
| **Isolation** | Good (separate VMs) | Excellent (separate machines) |
| **Portability** | Easy (VMs are files) | Hardware-dependent |
| **Use case** | Learning, testing, dev | Production, real scans |

---

## Advanced: Custom Lima Templates

For repeated use, create a **custom Lima template** for the Kali Node:

```yaml
# ~/.lima/avendesora-kali.yaml
arch: "aarch64"
images:
  - location: "https://cloud-images.ubuntu.com/releases/jammy/release/ubuntu-22.04-server-cloudimg-arm64.img"
    arch: "aarch64"
cpus: 4
memory: "8GiB"
disk: "50GiB"
mounts:
  - location: "/Users/jasperfrumau/code/avendesora"
    writable: true
    mountPoint: "/opt/avendesora"
ssh:
  localPort: 56471
  loadDotSSHPubKeys: true
network:
  - lima: shared
  - interface: "avendesora-net"
    gateway: "192.168.100.1"
    cidr: "192.168.100.0/24"
    dns: ["8.8.8.8", "8.8.4.4"]

# Then create with:
limactl create --name=avendesora-kali --template=avendesora-kali
```

---

## Resources

- [Lima Documentation](https://github.com/lima-vm/lima)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Avendesora Architecture](architecture.md)
- [Avendesora Setup Guide](setup.md)
- [Kali Linux Tools](https://www.kali.org/tools/)

---

## Limitations

1. **No GPU acceleration:** Lima doesn't pass through Mac GPU, so Ollama runs on CPU only.
2. **x86_64 emulation overhead:** On Apple Silicon, x86_64 Kali runs in qemu emulation (~10-20x slower).
3. **Shared resources:** Both VMs compete for your Mac's CPU, RAM, and disk.
4. **Not for production:** This setup is for **learning and testing only**.
5. **Network isolation:** The virtual network is isolated from your physical LAN by default.

> **For production use:** Follow the [full setup guide](setup.md) with dedicated hardware.

---

## Changelog

| Date | Change | Author |
| ---- | ------ | ------ |
| 2026-09-06 | Initial version: Lima local development guide | Jasper Frumau |

---

## The Avendesora Philosophy (Local Edition)

> *"Even the smallest cutting of Avendesora can root and grow. So too can this system take root on a single machine, that you might learn its ways before planting the full tree in your garden."*

The Wheel weaves as the Wheel wills. With Lima, you weave a smaller Pattern — but a Pattern nonetheless.
