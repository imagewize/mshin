# Avendesora Local Development with Lima

> *"The Two Rivers had its wisdom, and the Wisdom of the Two Rivers was this: as the leaf flows, so flows the river. A leaf on the wind, a leaf on the stream, a leaf on the current of the Pattern — and Avendesora flows with you, even on a single machine."*

This guide describes how to run a **local, single-machine Avendesora development environment** on macOS using **Lima VMs**, **Ollama with a small local model**, and **Kali Linux tools** — a lightweight alternative to the recommended two-machine setup for learning, testing, and small-scale experimentation.

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
| Network | Physical LAN | Virtual (vmnet, `192.168.105.0/24`) |

> **When to use this:** Learning the system, testing workflows, developing the MCP server, or experimenting with smaller models when you don't have a second x86_64 machine.

> **When NOT to use this:** Running production scans, handling sensitive data, or needing full performance. The two-machine setup remains the recommended path.

---

## Architecture: Lima Edition

```
┌────────────────────────────────────────────────────────────────┐
│                    macOS HOST (Apple Silicon)                  │
│                                                                │
│  ┌───────────────────────────┐   ┌──────────────────────────┐  │
│  │   Lima: avendesora-core   │   │  Lima: avendesora-kali   │  │
│  │   Ubuntu, aarch64         │   │  Debian + Kali tools     │  │
│  │                           │   │                          │  │
│  │  ┌─────────────────────┐  │   │  ┌────────────────────┐  │  │
│  │  │ Ollama       :11434 │  │   │  │ MCP server   :3000 │  │  │
│  │  │ mistral (7B, ~4GB)  │  │   │  │ nmap, nikto,       │  │  │
│  │  └──────────▲──────────┘  │   │  │ whois, tshark      │  │  │
│  │             │             │   │  └─────────▲──────────┘  │  │
│  │  ┌──────────▼──────────┐  │   │            │             │  │
│  │  │ Avendesora CLI      │──┼───┼──── SSE ───┘             │  │
│  │  │ (MCP client)        │  │   │                          │  │
│  │  └─────────────────────┘  │   │                          │  │
│  └───────────────────────────┘   └──────────────────────────┘  │
│                                                                │
│        lima shared network (vmnet) — 192.168.105.0/24          │
└────────────────────────────────────────────────────────────────┘
```

Both VMs run as **Lima instances** on your Mac. They talk to each other over Lima's **shared vmnet network** (`192.168.105.0/24`, addresses assigned by DHCP), which is opt-in per instance — see [Shared networking](#shared-networking-required-for-two-vms) below. The Core VM runs Ollama with a smaller model (`mistral`, 7B, ~4GB), and the Kali Node VM runs the MCP server with Kali tools.

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
limactl --version    # Should show 2.0+
ollama --version     # Should show 0.33+
```

> **Note:** `limactl` is the CLI. The `lima` binary is a shortcut that runs a command *inside* the default instance, so `lima --version` does not report the Lima version.

> **Note:** Lima uses **vz** (Apple Virtualization) for native-architecture guests and **qemu** for cross-architecture emulation. x86_64 guests on Apple Silicon are emulated and slow.

### Shared networking (required for two VMs)

Lima's default networking is **user-mode (SLIRP)**: every instance gets the same `192.168.5.15` address and **instances cannot reach each other**. VM-to-VM traffic needs the shared vmnet network, which is a one-time host setup:

```bash
# Install the vmnet helper
brew install socket_vmnet

# Grant Lima permission to run it (writes /etc/sudoers.d/lima)
limactl sudoers | sudo tee /etc/sudoers.d/lima
```

Instances then opt in with `--network=lima:shared`, and each receives a DHCP address on `192.168.105.0/24` via a `lima0` interface. Addresses are **assigned, not chosen** — `limactl create` has no `--ip` flag.

> **Single-VM setups** (see [Alternative: Single VM](#alternative-single-vm-all-in-one)) do not need any of this; everything talks over `localhost`.

---

## Setup

There are two ways to build these guests, and the guide covers both.

| | **Path A — Template files** | **Path B — `limactl` flags** |
| - | --------------------------- | ---------------------------- |
| Command | `limactl create --name=… lima/avendesora-kali.yaml` | `limactl create template:debian-13 --cpus=4 …` |
| Provisioning | Automatic, on first boot | You type every step inside the guest |
| Architecture | Host default — one file for Intel and Apple Silicon | You pass `--arch` yourself |
| Mounts, port forwards, probes | Available | No flags exist for them |
| Repeatable | Yes — the file is versioned in this repo | Only as far as you re-type it correctly |
| Good for | Anything you will rebuild | A one-off you plan to throw away |

**Path A is the shorter road**, and it is the one this repo maintains: `lima/avendesora-kali.yaml` and `lima/avendesora-core.yaml` carry the resources, the shared network, and a `provision:` block that runs the same commands Path B asks you to type. Path B is kept in full because it shows what those blocks actually do — read it if you want to understand the guest, or if you are debugging a provisioning failure.

Both paths need the [shared networking](#shared-networking-required-for-two-vms) host setup first.

---

### Step 1: Create the Kali Node VM

The Kali Node VM runs **Debian with Kali tools** and the **Avendesora MCP server**.

> **Lima ships no Kali template** (`limactl create --list-templates`), and `limactl create` boots **cloud images**, not installer ISOs — so neither path boots Kali itself. Both install the tools Debian packages on top of a Debian base.

#### Path A: From the template file

```bash
# From your clone of this repo
limactl create --name=avendesora-kali lima/avendesora-kali.yaml
limactl start avendesora-kali
```

That is the whole step. On first boot the template:

1. Installs `nmap`, `nikto`, `whois`, `tshark`, `git` and Node.js 20.
2. Clones this repo to `/opt/avendesora` and runs `npm install` for the MCP server.
3. Writes the `NOPASSWD` sudoers allowlist those four tools need.
4. Installs `configs/mcp-kali.service` as `avendesora-node`, rewritten for the Lima login user and the four available tools.

Lima then waits on a probe until `curl :3000/health` answers, so `limactl start` returning means the MCP server is up. It prints the command that reads the guest's address on the shared network.

> **The template sets no `arch`.** Lima defaults to the host architecture, so the same file gives an Intel Mac an x86_64 guest and an Apple Silicon Mac an aarch64 guest. Either way the tools run natively — see [Apple Silicon Notes](#apple-silicon-notes).

To point the guest at your working clone instead of a fresh GitHub checkout, uncomment the `mounts:` block at the top of the template and set `location` to your clone's path.

> **When provisioning fails**, `limactl start` reports a failed probe rather than the underlying error. The error is in the guest: `limactl shell avendesora-kali -- sudo journalctl -u avendesora-node -n 50`, and `/var/log/cloud-init-output.log` for the provisioning scripts themselves. `limactl start --debug` is louder still.

#### Path B: From `limactl` flags, provisioned by hand

##### Create the VM

On an **Intel Mac**, build on an x86_64 base:

```bash
limactl create template:debian-13 \
  --name=avendesora-kali \
  --arch=x86_64 \
  --cpus=4 \
  --memory=8 \
  --disk=50 \
  --network=lima:shared
```

On **Apple Silicon**, build on an aarch64 base:

```bash
limactl create template:debian-13 \
  --name=avendesora-kali \
  --arch=aarch64 \
  --cpus=4 \
  --memory=8 \
  --disk=50 \
  --network=lima:shared
```

> **Flag notes:** the template is a **positional** argument (`template:<name>`; run `limactl create --list-templates` for the full list). `--memory` and `--disk` are plain numbers in GiB — `--memory=8GiB` fails to parse. There is no flag for mounts, port forwards, or provisioning; those need a template file.

```bash
limactl start avendesora-kali
limactl shell avendesora-kali
```

##### Install the tools

Inside the VM:

```bash
# Update and upgrade
sudo apt update && sudo apt upgrade -y

# Install Node.js v20+ (required for MCP server)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# nikto is in Debian's non-free component, which the cloud image does not
# enable. nmap, whois and tshark are in main.
sudo sed -i 's/^Components: main$/Components: main non-free/' \
  /etc/apt/sources.list.d/debian.sources
sudo apt update

# Install the security tools Debian ships
sudo apt install -y nmap nikto whois tshark

# Verify installation
nmap --version
nikto -Version
```

> **`nikto` needs `non-free`.** Debian 13's cloud image enables only the `main` component, and `nikto` is packaged in `non-free` — without the `sed` above, `apt install` fails with `E: Unable to locate package nikto` and takes the rest of the command down with it. Debian's `nikto` is also **1:2.1.5**, against Kali's 2.5.x: the plugin database is years older, so findings will differ from a real Node.

> **Two tools are missing on purpose.** `searchsploit` (package `exploitdb`) and `metasploit-framework` live in **Kali's** repositories, not Debian's — `apt install` for either fails on this base, and grafting Kali's repo onto Debian is unsupported and can break the guest. Leave both out of the MCP server's `--tools` list here; if you need them, use the real Kali Node from the [full setup guide](setup.md).

##### Set up the MCP server

```bash
# Option 1: Clone directly (if the VM has internet)
sudo git clone https://github.com/imagewize/avendesora.git /opt/avendesora
sudo chown -R "$(whoami)" /opt/avendesora

# Option 2: Or mount your Mac clone into the VM instead — that needs a
# template file, so see Path A above

# Install MCP server dependencies
cd /opt/avendesora/servers/src/kali
npm install
```

The server shells out as `sudo -n <tool>` whenever it is not running as root (`servers/src/kali/tools.js:53-57`), so it needs a passwordless allowlist or **every tool call fails** with `sudo: a password is required`:

```bash
# Mirror the allowlist that scripts/setup_mcp_server.sh installs,
# limited to the tools available on this base
sudo tee /etc/sudoers.d/avendesora >/dev/null <<EOF
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/nikto, /usr/bin/whois, /usr/bin/tshark
EOF
sudo chmod 440 /etc/sudoers.d/avendesora
```

Test it in the foreground before daemonising:

```bash
node index.js --tools nmap,nikto,whois,tshark
# Expect: [INFO] Avendesora Node listening on http://0.0.0.0:3000
# Ctrl-C to stop
```

Then install the unit the repo already ships:

```bash
sudo cp /opt/avendesora/configs/mcp-kali.service /etc/systemd/system/avendesora-node.service

# The shipped unit runs as a dedicated 'avendesora' user and enables all six
# tools. In a throwaway Lima VM, run as your own login user and drop the two
# tools Debian does not provide.
sudo sed -i "s|^User=.*|User=$(whoami)|" /etc/systemd/system/avendesora-node.service
sudo sed -i "s|^ReadWritePaths=.*|ReadWritePaths=/opt/avendesora $HOME|" /etc/systemd/system/avendesora-node.service
sudo sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/node index.js --tools nmap,nikto,whois,tshark|" /etc/systemd/system/avendesora-node.service

sudo systemctl daemon-reload
sudo systemctl enable --now avendesora-node
systemctl status avendesora-node --no-pager
```

> **Use `$HOME`, not `/home/$(whoami)`.** Lima's guest home carries a suffix — `/home/<user>.linux` — so a hand-written `/home/<user>` path leaves `ReadWritePaths` pointing at a directory that does not exist.

> **Note:** Lima's Debian and Ubuntu guests boot standard cloud images and run **systemd**, so the packaged unit works as-is. Follow the logs with `journalctl -u avendesora-node -f`.

---

### Step 2: Create the Core VM

The Core VM runs **Ollama** with your LLM and the **Avendesora CLI client**.

#### Path A: From the template file

```bash
limactl create --name=avendesora-core lima/avendesora-core.yaml
limactl start avendesora-core
```

On first boot the template installs Node.js 20 and Ollama, pulls the base model, clones this repo to `/opt/avendesora`, installs the CLI's dependencies, symlinks it to `/usr/local/bin/avendesora`, and builds the `avendesora` persona. Expect the first start to take a while — most of it is the model download.

To build the persona on a different base model:

```bash
limactl create --name=avendesora-core --param model=qwen2.5:7b lima/avendesora-core.yaml
```

> **The template rewrites the Modelfile's `FROM` line.** `configs/ollama-modelfile` is `FROM mistral-small` (24B, ~15GB), sized for a real Core machine and far too large for a Lima guest. The template renders a copy with `FROM <param model>` into `/var/lib/avendesora/Modelfile` and builds from that, leaving the repo copy untouched. **Path B must do the same** — see below.

#### Path B: From `limactl` flags, provisioned by hand

```bash
limactl create template:ubuntu \
  --name=avendesora-core \
  --arch=aarch64 \
  --cpus=4 \
  --memory=16 \
  --disk=50 \
  --network=lima:shared

limactl start avendesora-core
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
# - qwen2.5:7b (7B, ~4GB) - Fast and capable
# - phi3:3.8b (3.8B, ~2GB) - Very lightweight
ollama pull mistral

# Verify
ollama list
```

##### Create the Avendesora persona model

```bash
# Clone Avendesora repo (if not already present)
sudo git clone https://github.com/imagewize/avendesora.git /opt/avendesora
sudo chown -R "$(whoami)" /opt/avendesora

# configs/ollama-modelfile is FROM mistral-small (24B, ~15GB) and will pull
# that model if you build it as-is. Render a copy on the small model instead.
sed 's|^FROM .*|FROM mistral|' /opt/avendesora/configs/ollama-modelfile > ~/Modelfile.lima
ollama create avendesora -f ~/Modelfile.lima

# Verify
ollama list
```

##### Install the Avendesora CLI client

```bash
cd /opt/avendesora/clients/avendesora-cli
npm install
```

---

### Step 3: Configure Networking

Both VMs must have been created with `--network=lima:shared` (see [Shared networking](#shared-networking-required-for-two-vms)). Their addresses are assigned by DHCP, so read them rather than assuming them.

From the **Mac host**:

```bash
# Read each VM's address on the shared network
limactl shell avendesora-kali -- ip -4 -br addr show lima0
limactl shell avendesora-core -- ip -4 -br addr show lima0
```

Note the Kali Node address (something in `192.168.105.0/24`) — it is `<KALI_IP>` throughout the rest of this guide. Then, from the **Core VM**:

```bash
# Reach the Kali Node VM
ping -c 3 <KALI_IP>

# Test the MCP server
curl http://<KALI_IP>:3000/health
```

If the connection fails:

1. **Verify both VMs are running:**
   ```bash
   limactl list
   ```

2. **Check the shared interface exists:**
   ```bash
   # In each VM - a missing lima0 means the instance was created
   # without --network=lima:shared
   ip -4 -br addr show lima0
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
/opt/avendesora/clients/avendesora-cli/index.js --node http://<KALI_IP>:3000 --model avendesora
```

Then, try a command:

```
"Avendesora, run an Nmap scan on 127.0.0.1 and show me the results."
```

> **Note:** The first run may take a moment as the MCP server connects and validates available tools.

To check the two halves separately when something misbehaves:

```bash
# Is the Node reachable and serving tools?
curl http://<KALI_IP>:3000/health

# Is the model loaded and answering?
ollama run avendesora
```

> **`ollama run` has no tools.** It is a plain chat session — Ollama is not an MCP client and reads no Node URL from the environment. The persona will happily *describe* an Nmap scan, but nothing executes. Only the Avendesora CLI bridges the model to the Node.

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
/opt/avendesora/clients/avendesora-cli/index.js --node http://<KALI_IP>:3000 --model avendesora
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
ollama pull qwen2.5:7b

# Recreate the avendesora persona with a different base
sed 's|^FROM .*|FROM qwen2.5:7b|' /opt/avendesora/configs/ollama-modelfile > ~/Modelfile.lima
ollama create avendesora -f ~/Modelfile.lima

# Remove old models to free space
ollama rm mistral
```

> **Model recommendations for Lima:**
> - `mistral` (7B, ~4GB) - Official Mistral AI model, good balance
> - `qwen2.5:7b` (7B, ~4GB) - Fast and capable
> - `phi3:3.8b` (3.8B, ~2GB) - Very light, fast
> - `llama3.2:3b` (3B, ~2GB) - Good for testing
>
> Check a tag exists with `ollama show <tag>` before building the persona on it. The full setup's **Mistral Small 3 (24B)** needs ~15GB and is out of reach for a Lima guest.

---

## Alternative: Single VM (All-in-One)

For **maximum simplicity** (at the cost of isolation), you can run everything in **one Lima VM**:

```bash
# Create a single VM (no shared network needed - everything is on localhost)
limactl create template:ubuntu \
  --name=avendesora-allinone \
  --arch=aarch64 \
  --cpus=8 \
  --memory=16 \
  --disk=80

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
sudo git clone https://github.com/imagewize/avendesora.git /opt/avendesora
sudo chown -R "$(whoami)" /opt/avendesora

# Create avendesora model. configs/ollama-modelfile is FROM mistral-small
# (24B, ~15GB); render a copy on the small model instead of building it as-is.
sed 's|^FROM .*|FROM mistral|' /opt/avendesora/configs/ollama-modelfile > ~/Modelfile.lima
ollama create avendesora -f ~/Modelfile.lima

# Allow the tools to run without a password prompt
sudo tee /etc/sudoers.d/avendesora >/dev/null <<EOF
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/nikto, /usr/bin/whois, /usr/bin/tshark
EOF
sudo chmod 440 /etc/sudoers.d/avendesora

# Start MCP server in background
cd /opt/avendesora/servers/src/kali
npm install
node index.js --tools nmap,nikto,whois,tshark &

# Start Avendesora CLI in another session
/opt/avendesora/clients/avendesora-cli/index.js --node http://localhost:3000 --model avendesora
```

> **If `apt` cannot find `nikto`**, the component that carries it is not enabled. It lives in `non-free` on Debian and **`multiverse`** on Ubuntu (verified against `packages.ubuntu.com` for jammy 22.04 and noble 24.04: `nikto 1:2.1.5-3.1 [multiverse]`) — not `universe`. If the install fails on the Lima `template:ubuntu` guest, enable multiverse with `sudo add-apt-repository -y multiverse && sudo apt update`, then reinstall. The Debian fix is in [Step 1](#step-1-create-the-kali-node-vm).

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
2. **aarch64 Kali:** Kali Linux publishes ARM64 builds, but Lima ships **no Kali template** (`limactl create --list-templates`) and `limactl create` boots **cloud images**, not installer ISOs. Kali's ARM64 releases are installer ISOs and pre-built VM disks rather than cloud-init images, so there is no drop-in Lima equivalent. The practical ARM64 path is what both paths in [Step 1](#step-1-create-the-kali-node-vm) do — a Debian base with Kali tooling installed on top. See the [Lima templates documentation](https://lima-vm.io/docs/templates/) if you want to try wiring up a custom image.

### GPU Acceleration

Lima does **not** currently pass through Mac GPU to VMs (as of 2026). Ollama in the VM will use **CPU-only inference**, which is slower but functional for 7B models.

For better performance:
- Use **smaller models** (7B or smaller)
- Use **quantized models** (Q4_K_M is the default, Q2_K is smaller/faster)
- Accept **slower token generation** (~2-5 tokens/sec for 7B on CPU)

---

## Troubleshooting

| Issue | Diagnosis | Solution |
| ----- | --------- | -------- |
| VM won't start | `limactl list` shows error | `limactl delete <name>` and recreate |
| MCP connection refused | `curl http://<KALI_IP>:3000/health` fails | Check the MCP server is running in the Kali VM |
| Ollama model won't load | `ollama list` shows model, but `ollama run` fails | Check VRAM: `free -h`; model may be too large |
| Slow performance | VMs are responsive but slow | Reduce CPU/memory allocation or use smaller model |
| `limactl create` rejects a flag | `unknown flag: --os` / `--ip` | Those flags do not exist; pass a template positionally and use `--network=lima:shared` |
| `limactl create` rejects memory | `invalid argument "8GiB"` | `--memory` and `--disk` take plain GiB numbers: `--memory=8` |
| VMs cannot ping each other | No `lima0` interface in the VM | Instance was created without `--network=lima:shared`; recreate it, and check `socket_vmnet` is installed |
| Kali tools not found | `nmap` command not found | Reinstall tools: `sudo apt install -y nmap` |
| `E: Unable to locate package nikto` | Debian cloud image enables only `main` | `nikto` is in `non-free`; add it to `Components:` in `/etc/apt/sources.list.d/debian.sources`, then `apt update` |
| Template edit has no effect | Guest still behaves the old way after editing `lima/*.yaml` | `limactl create` snapshotted the template; edit `~/.lima/<name>/lima.yaml` with `limactl edit`, or delete and recreate |
| `limactl start` fails on a probe | "avendesora-node did not come up" / "the avendesora model was never created" | The probe timed out; the real error is in the guest. See `journalctl -u avendesora-node -n 50` and `/var/log/cloud-init-output.log` |
| Persona pulls a 15GB model | `ollama create` on the repo Modelfile as-is | `configs/ollama-modelfile` is `FROM mistral-small`; render a copy with `FROM mistral` first |

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
| **Network** | Virtual vmnet (`192.168.105.0/24`) | Physical LAN |
| **Isolation** | Good (separate VMs) | Excellent (separate machines) |
| **Portability** | Easy (VMs are files) | Hardware-dependent |
| **Use case** | Learning, testing, dev | Production, real scans |

---

## Advanced: Editing the Templates

The two templates live in this repo:

| File | Guest |
| ---- | ----- |
| `lima/avendesora-kali.yaml` | Debian 13 + Kali tools + `avendesora-node` MCP server |
| `lima/avendesora-core.yaml` | Ubuntu LTS + Ollama + the `avendesora` persona and CLI |

Copy one, edit it, and pass its **path** to `limactl create`. (`~/.lima/` holds created *instances*, not templates — a file dropped there is not picked up.)

```bash
cp lima/avendesora-kali.yaml ~/my-kali.yaml
$EDITOR ~/my-kali.yaml

# Check it before you build it
limactl template validate ~/my-kali.yaml

# See exactly what Lima will run, with every {{.Var}} resolved
limactl template copy --fill ~/my-kali.yaml -

limactl create --name=my-kali ~/my-kali.yaml
```

What is worth changing:

- **`mounts:`** — uncomment the block to bind your Mac clone to `/opt/avendesora`, so edits to `servers/src/kali` take effect without a `git pull` in the guest. The provisioning skips its `chown` when the path is a mount.
- **`param.model`** (Core only) — the base model the persona is built on, overridable per-instance with `limactl create --param model=…`.
- **`cpus` / `memory` / `disk`** — see [Resource Allocation](#resource-allocation). Unlike the CLI flags, these YAML fields **do** take unit suffixes.
- **`arch`** — unset on purpose, so the guest matches the host. Set it only if you deliberately want emulation.

> **Note:** the key is `networks` (plural), and its only supported forms are `lima: <name>` or `socket: <path>` — a template cannot invent its own gateway or CIDR.

> **Provisioning runs on every boot.** Lima installs the blocks as cloud-init per-boot scripts (`/var/lib/cloud/scripts/per-boot/00-lima.boot.sh`, reading `/mnt/lima-cidata/provision.system/`), so each script guards itself and exits early when its work is already done. Keep that property if you add steps, or every `limactl start` will re-run an `apt-get install`.

> **`limactl create` snapshots the template.** The instance keeps its own copy at `~/.lima/<name>/lima.yaml`, and that copy is what generates the cidata the guest reads — so **editing the file in this repo does nothing to a VM that already exists**. To pick up a template change, either edit the instance in place (`limactl edit <name>`, or `limactl edit <name> --set '<yq expression>'` for a single field), or delete and recreate:
>
> ```bash
> limactl delete avendesora-kali
> limactl create --name=avendesora-kali lima/avendesora-kali.yaml
> ```
>
> Recreating is cheap after the first run — the cloud image stays in `~/Library/Caches/lima`, so only provisioning repeats. Check which one you are actually running with `grep <something-you-changed> ~/.lima/<name>/lima.yaml`.

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
| 2026-09-06 | Correct `limactl` syntax, document shared vmnet networking, systemd unit and sudoers allowlist | Jasper Frumau |
| 2026-09-06 | Add `lima/` templates and split Setup into template and flag paths | Jasper Frumau |
| 2026-09-06 | Enable Debian's `non-free` component so `nikto` installs | Jasper Frumau |

---

## The Avendesora Philosophy (Local Edition)

> *"Even the smallest cutting of Avendesora can root and grow. So too can this system take root on a single machine, that you might learn its ways before planting the full tree in your garden."*

The Wheel weaves as the Wheel wills. With Lima, you weave a smaller Pattern — but a Pattern nonetheless.
