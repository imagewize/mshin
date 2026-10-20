# Machin Shin Local Development with Lima

> *"The Two Rivers had its wisdom, and the Wisdom of the Two Rivers was this: as the leaf flows, so flows the river. A leaf on the wind, a leaf on the stream, a leaf on the current of the Pattern — and Machin Shin flows with you, even on a single machine."*

This guide describes how to run a **local, single-machine Machin Shin development environment** on macOS using **Lima VMs**, **Ollama with a small local model**, and **Kali Linux tools** — a lightweight alternative to the recommended two-machine setup for learning, testing, and small-scale experimentation.

---

## Overview

The standard [Machin Shin architecture](ARCHITECTURE.md) uses two physical machines:
- **Machin Shin Core**: LLM inference server (32GB+ RAM)
- **Machin Shin Node**: Kali Linux + MCP server (x86_64 mini PC)

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
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  macOS HOST (Apple Silicon)                                                         │
│                                                                                     │
│  ┌──────────────────────────┐               ┌────────────────────────────────────┐  │
│  │ Lima: mshin-core         │               │ Lima: mshin-node                   │  │
│  │ Ubuntu, aarch64          │               │ Debian, all 13 tools               │  │
│  │                          │               │                                    │  │
│  │  ┌──────────────────────┐│               │ MCP server   :3000                 │  │
│  │  │ Ollama       :11434  ││               │ nmap, nikto, whois, tshark,        │  │
│  │  │ mistral (7B, ~4GB)   ││               │ hydra, sqlmap, gobuster, masscan,  │  │
│  │  └──────────────────────┘│               │ dirb, arping, dnsenum,             │  │
│  │      │                   │               │ metasploit, searchsploit           │  │
│  │  ┌──────────────────────┐│               │                                    │  │
│  │  │ Machin Shin CLI      ││  ── HTTP ──▶  │                                    │  │
│  │  │ (MCP client)         ││               │                                    │  │
│  │  └──────────────────────┘│               │                                    │  │
│  └──────────────────────────┘               └────────────────────────────────────┘  │
│                                                                                     │
│                   lima shared network (vmnet) — 192.168.105.0/24                    │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Both VMs run as **Lima instances** on your Mac. They talk to each other over Lima's **shared vmnet network** (`192.168.105.0/24`, addresses assigned by DHCP), which is opt-in per instance — see [Shared networking](#shared-networking-required-for-two-vms) below. The Core VM runs Ollama with a smaller model (`mistral`, 7B, ~4GB), and the Node VM runs the MCP server with the security tools.

---

## Prerequisites

### Hardware (Your Mac)

| Requirement | Minimum | Recommended | Notes |
| ----------- | ------- | ----------- | ----- |
| **CPU** | Apple Silicon (M1+) or Intel x86_64 | M1 Pro/Max/M2+ | x86_64 Macs can run Kali natively in Lima |
| **RAM** | 16GB | 32GB+ | The templates size the Core at 10GB and the Node at 4GB; they share your Mac's RAM |
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

Lima requires the `socket_vmnet` binary to be **owned by root** and installed at the default path `/opt/socket_vmnet/bin/socket_vmnet`, with no user-writable parent directory. A Homebrew install alone does not satisfy this: it lands under `/opt/homebrew` owned by your user, and `limactl sudoers` then aborts with `` file `/opt/homebrew/opt/socket_vmnet/bin/socket_vmnet` is not owned by `root` `` (or, if you repoint `networks.yaml` at it, the same complaint about the user-owned path). The Lima project [documents from-source as the supported method](https://lima-vm.io/docs/config/network/vmnet/) and calls the Homebrew path insecure. Install it root-owned at the default location:

```bash
# Build and install from source, root-owned, to the default /opt/socket_vmnet
git clone https://github.com/lima-vm/socket_vmnet
cd socket_vmnet && git checkout v1.2.2 && make
sudo make PREFIX=/opt/socket_vmnet install.bin

# Grant Lima permission to run it (writes /etc/sudoers.d/lima)
limactl sudoers | sudo tee /etc/sudoers.d/lima
```

> **Already ran `brew install socket_vmnet`?** You can reuse that binary instead of building — copy it to the root-owned default path rather than repointing `networks.yaml` at the Homebrew prefix (which Lima rejects):
>
> ```bash
> sudo install -o root -g wheel -m 0755 -d /opt/socket_vmnet/bin
> sudo install -o root -g wheel -m 0755 \
>   /opt/homebrew/opt/socket_vmnet/bin/socket_vmnet /opt/socket_vmnet/bin/socket_vmnet
> limactl sudoers | sudo tee /etc/sudoers.d/lima
> ```

Instances then opt in with `--network=lima:shared`, and each receives a DHCP address on `192.168.105.0/24` via a `lima0` interface. Addresses are **assigned, not chosen** — `limactl create` has no `--ip` flag.

> **Single-VM setups** (see [Alternative: Single VM](#alternative-single-vm-all-in-one)) do not need any of this; everything talks over `localhost`.

---

## Setup

There are two ways to build these guests, and the guide covers both.

| | **Path A — Template files** | **Path B — `limactl` flags** |
| - | --------------------------- | ---------------------------- |
| Command | `limactl create --name=… lima/mshin-node.yaml` | `limactl create template:debian-13 --cpus=4 …` |
| Provisioning | Automatic, on first boot | You type every step inside the guest |
| Architecture | Host default — one file for Intel and Apple Silicon | You pass `--arch` yourself |
| Mounts, port forwards, probes | Available | No flags exist for them |
| Repeatable | Yes — the file is versioned in this repo | Only as far as you re-type it correctly |
| Good for | Anything you will rebuild | A one-off you plan to throw away |

**Path A is the shorter road**, and it is the one this repo maintains: `lima/mshin-node.yaml` and `lima/mshin-core.yaml` carry the resources, the shared network, and a `provision:` block that runs the same commands Path B asks you to type. Path B is kept in full because it shows what those blocks actually do — read it if you want to understand the guest, or if you are debugging a provisioning failure.

Both paths need the [shared networking](#shared-networking-required-for-two-vms) host setup first.

---

### Step 1: Create the Node VM

The Node VM runs **Debian with the offensive-security tools** and the **Machin Shin MCP server**.

> **Lima ships no Kali template** (`limactl create --list-templates`), and `limactl create` boots **cloud images**, not installer ISOs — so neither path boots Kali itself. Both install the tools Debian packages on top of a Debian base.

#### Path A: From the template file

```bash
# From your clone of this repo
limactl create --name=mshin-node lima/mshin-node.yaml
limactl start mshin-node
```

That is the whole step. On first boot the template:

1. Installs all thirteen tools — `nmap`, `nikto`, `whois`, `tshark`, `hydra`,
   `sqlmap`, `gobuster`, `masscan`, `dirb`, `arping` and `dnsenum` from Debian,
   `searchsploit` from exploit-db's git repo and `metasploit` from Rapid7's apt
   repo — plus `git` and Node.js 20, and warms metasploit's one-time setup.
2. Clones this repo to `/opt/mshin` and runs `npm install` for the MCP server.
3. Writes the `NOPASSWD` sudoers allowlist those tools need (all but `tshark`,
   which runs unprivileged).
4. Installs `configs/mcp-kali.service` as `mshin-node`, rewritten for the Lima
   login user, exposing all thirteen tools.

Lima then waits on a probe until `curl :3000/health` answers, so `limactl start` returning means the MCP server is up. It prints the command that reads the guest's address on the shared network.

> **The template sets no `arch`.** Lima defaults to the host architecture, so the same file gives an Intel Mac an x86_64 guest and an Apple Silicon Mac an aarch64 guest. Either way the tools run natively — see [Apple Silicon Notes](#apple-silicon-notes).

To point the guest at your working clone instead of a fresh GitHub checkout, uncomment the `mounts:` block at the top of the template and set `location` to your clone's path.

> **When provisioning fails**, `limactl start` reports a failed probe rather than the underlying error. The error is in the guest: `limactl shell mshin-node -- sudo journalctl -u mshin-node -n 50`, and `/var/log/cloud-init-output.log` for the provisioning scripts themselves. `limactl start --debug` is louder still.

#### Path B: From `limactl` flags, provisioned by hand

##### Create the VM

On an **Intel Mac**, build on an x86_64 base:

```bash
limactl create template:debian-13 \
  --name=mshin-node \
  --arch=x86_64 \
  --cpus=4 \
  --memory=4 \
  --disk=50 \
  --network=lima:shared
```

On **Apple Silicon**, build on an aarch64 base:

```bash
limactl create template:debian-13 \
  --name=mshin-node \
  --arch=aarch64 \
  --cpus=4 \
  --memory=4 \
  --disk=50 \
  --network=lima:shared
```

> **Flag notes:** the template is a **positional** argument (`template:<name>`; run `limactl create --list-templates` for the full list). `--memory` and `--disk` are plain numbers in GiB — `--memory=8GiB` fails to parse. There is no flag for mounts, port forwards, or provisioning; those need a template file.

```bash
limactl start mshin-node
limactl shell mshin-node
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

# Install the eleven tools Debian ships
sudo apt install -y nmap nikto whois tshark hydra sqlmap gobuster masscan dirb arping dnsenum

# searchsploit: a shell script over the exploit-db data repo. The clone is the
# install, and it is arch-independent. tools.js expects /usr/bin/searchsploit.
sudo git clone --depth 1 https://gitlab.com/exploit-database/exploitdb.git /opt/exploitdb
sudo ln -sf /opt/exploitdb/searchsploit /usr/bin/searchsploit

# metasploit: Rapid7's own apt repo, which publishes amd64 and arm64.
curl -fsSL https://apt.metasploit.com/metasploit-framework.gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/metasploit.gpg
echo "deb [signed-by=/usr/share/keyrings/metasploit.gpg] https://apt.metasploit.com lucid main" \
  | sudo tee /etc/apt/sources.list.d/metasploit.list
sudo apt update
sudo apt install -y metasploit-framework

# Warm metasploit's one-time Initial Setup once, as root (tools.js calls it via
# `sudo -n`), so the first real tool call is fast instead of hitting setup.
sudo msfconsole -q -x exit

# Verify installation
nmap --version
nikto -Version
searchsploit --version
hydra -h | head -1
sqlmap --version
gobuster --version
```

> **`nikto` needs `non-free`.** Debian 13's cloud image enables only the `main` component, and `nikto` is packaged in `non-free` — without the `sed` above, `apt install` fails with `E: Unable to locate package nikto` and takes the rest of the command down with it. Debian's `nikto` is also **1:2.1.5**, against Kali's 2.5.x: the plugin database is years older, so findings will differ from a real Node.

> **The last two tools come from upstream, not Kali.** `searchsploit` and `metasploit` are the tools Kali is known for, but neither is Kali-only: exploit-db publishes searchsploit as a git repo, and Rapid7 publishes metasploit through its own apt repo (with arm64 builds, so this works on Apple Silicon). Installing them this way keeps the guest on Debian without grafting Kali's repo onto it — which remains unsupported and can break the base. This is exactly what `lima/mshin-node.yaml` does; the manual steps above mirror it.

##### Set up the MCP server

```bash
# Option 1: Clone directly (if the VM has internet)
sudo git clone https://github.com/imagewize/mshin.git /opt/mshin
sudo chown -R "$(whoami)" /opt/mshin

# Option 2: Or mount your Mac clone into the VM instead — that needs a
# template file, so see Path A above

# Install MCP server dependencies
cd /opt/mshin/servers/src/kali
npm install
```

The server shells out as `sudo -n <tool>` whenever it is not running as root (`servers/src/kali/tools.js:90-92`), so it needs a passwordless allowlist or **every tool call fails** with `sudo: a password is required`:

```bash
# Mirror the allowlist that scripts/setup_mcp_server.sh installs. tshark is
# omitted because reading user-owned PCAP files as root triggers Wireshark's
# file-owner check; tshark needs no privileges to analyze existing captures.
sudo tee /etc/sudoers.d/mshin >/dev/null <<EOF
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/nikto, /usr/bin/whois, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/hydra, /usr/bin/sqlmap, /usr/bin/gobuster, /usr/bin/masscan, /usr/bin/dirb, /usr/bin/arping, /usr/bin/dnsenum
EOF
sudo chmod 440 /etc/sudoers.d/mshin
```

Test it in the foreground before daemonising:

```bash
node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum
# Expect: [INFO] Machin Shin Node listening on http://0.0.0.0:3000
# Ctrl-C to stop
```

Then install the unit the repo already ships:

```bash
sudo cp /opt/mshin/configs/mcp-kali.service /etc/systemd/system/mshin-node.service

# The shipped unit runs as a dedicated 'mshin' user. In a throwaway Lima VM,
# run as your own login user instead; the tool list is the same thirteen, since
# the steps above installed the other eleven from Debian and metasploit and
# searchsploit from upstream.
sudo sed -i "s|^User=.*|User=$(whoami)|" /etc/systemd/system/mshin-node.service
sudo sed -i "s|^ReadWritePaths=.*|ReadWritePaths=/opt/mshin $HOME|" /etc/systemd/system/mshin-node.service
sudo sed -i "s|^ExecStart=.*|ExecStart=/usr/bin/node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum|" /etc/systemd/system/mshin-node.service

sudo systemctl daemon-reload
sudo systemctl enable --now mshin-node
systemctl status mshin-node --no-pager
```

> **Use `$HOME`, not `/home/$(whoami)`.** Lima's guest home carries a suffix — `/home/<user>.linux` — so a hand-written `/home/<user>` path leaves `ReadWritePaths` pointing at a directory that does not exist.

> **Note:** Lima's Debian and Ubuntu guests boot standard cloud images and run **systemd**, so the packaged unit works as-is. Follow the logs with `journalctl -u mshin-node -f`.

---

### Step 2: Create the Core VM

The Core VM runs **Ollama** with your LLM and the **Machin Shin CLI client**.

#### Path A: From the template file

```bash
limactl create --name=mshin-core lima/mshin-core.yaml
limactl start mshin-core
```

On first boot the template installs Node.js 20 and Ollama, pulls the base model, clones this repo to `/opt/mshin`, installs the CLI's dependencies, symlinks it to `/usr/local/bin/mshin`, and builds the `mshin` persona. Expect the first start to take a while — most of it is the model download.

To build the persona on a different base model:

```bash
limactl create --name=mshin-core --param model=qwen2.5:7b lima/mshin-core.yaml
```

> **The template rewrites the Modelfile's `FROM` line.** `configs/ollama-modelfile` is `FROM mistral-small` (24B, ~15GB), sized for a real Core machine and far too large for a Lima guest. The template renders a copy with `FROM <param model>` into `/var/lib/mshin/Modelfile` and builds from that, leaving the repo copy untouched. **Path B must do the same** — see below.

#### Path B: From `limactl` flags, provisioned by hand

```bash
limactl create template:ubuntu \
  --name=mshin-core \
  --arch=aarch64 \
  --cpus=4 \
  --memory=10 \
  --disk=50 \
  --network=lima:shared

limactl start mshin-core
limactl shell mshin-core
```

Inside the Core VM:

```bash
# Update and install dependencies
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# The installer registers the systemd unit but does not reliably start it on a
# cloud image (on the Ubuntu 26.04 LTS guest the unit is left disabled/inactive),
# so start it explicitly — otherwise `ollama pull` below fails to reach the API.
sudo systemctl enable --now ollama

# Pull a model that fits in the VM's RAM
# Options that work well in Lima VMs:
# - mistral (7B, ~4GB) - Official Mistral AI 7B model
# - qwen2.5:7b (7B, ~4GB) - Fast and capable
# - phi3:3.8b (3.8B, ~2GB) - Very lightweight
ollama pull mistral

# Verify
ollama list
```

##### Create the Machin Shin persona model

```bash
# Clone Machin Shin repo (if not already present)
sudo git clone https://github.com/imagewize/mshin.git /opt/mshin
sudo chown -R "$(whoami)" /opt/mshin

# configs/ollama-modelfile is FROM mistral-small (24B, ~15GB) and will pull
# that model if you build it as-is. Render a copy on the small model instead.
sed 's|^FROM .*|FROM mistral|' /opt/mshin/configs/ollama-modelfile > ~/Modelfile.lima
ollama create mshin -f ~/Modelfile.lima

# Verify
ollama list
```

##### Install the Machin Shin CLI client

```bash
cd /opt/mshin/clients/mshin-cli
npm install
```

---

### Step 3: Configure Networking

Both VMs must have been created with `--network=lima:shared` (see [Shared networking](#shared-networking-required-for-two-vms)). Their addresses are assigned by DHCP, so read them rather than assuming them.

From the **Mac host**:

```bash
# Read each VM's address on the shared network
limactl shell mshin-node -- ip -4 -br addr show lima0
limactl shell mshin-core -- ip -4 -br addr show lima0
```

Note the Node's address (something in `192.168.105.0/24`) — it is `<NODE_IP>` throughout the rest of this guide. Then, from the **Core VM**:

```bash
# Reach the Node VM
ping -c 3 <NODE_IP>

# Test the MCP server
curl http://<NODE_IP>:3000/health
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
   # On Node VM, start the server manually
   cd /opt/mshin/servers/src/kali
   node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum
   ```

---

### Step 4: Connect and Test

From the **Core VM**, run the Machin Shin CLI:

```bash
# Start an interactive session
/opt/mshin/clients/mshin-cli/index.js --node http://<NODE_IP>:3000 --model mshin
```

Then, try a command:

```
"Machin Shin, run an Nmap scan on 127.0.0.1 and show me the results."
```

> **Note:** The first run may take a moment as the MCP server connects and validates available tools.

To check the two halves separately when something misbehaves:

```bash
# Is the Node reachable and serving tools?
curl http://<NODE_IP>:3000/health

# Is the model loaded and answering?
ollama run mshin
```

> **`ollama run` has no tools.** It is a plain chat session — Ollama is not an MCP client and reads no Node URL from the environment. The persona will happily *describe* an Nmap scan, but nothing executes. Only the Machin Shin CLI bridges the model to the Node.

---

## Usage

### Starting the Environment

```bash
# Start both VMs
limactl start mshin-node
limactl start mshin-core

# Shell into Core VM
limactl shell mshin-core

# Start the Machin Shin CLI
/opt/mshin/clients/mshin-cli/index.js --node http://<NODE_IP>:3000 --model mshin
```

### Stopping the Environment

```bash
# Stop both VMs
limactl stop mshin-node
limactl stop mshin-core
```

### Managing Models

To try different models in the Core VM:

```bash
# List available models
ollama list

# Pull a different model (if you have the RAM)
ollama pull qwen2.5:7b

# Recreate the mshin persona with a different base
sed 's|^FROM .*|FROM qwen2.5:7b|' /opt/mshin/configs/ollama-modelfile > ~/Modelfile.lima
ollama create mshin -f ~/Modelfile.lima

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
>
> **The agent loop needs a tool-calling model.** Machin Shin drives tools through Ollama's `tool_calls`; a model not trained for tool use will describe commands in prose instead of emitting a call, and the loop never fires a tool. Not every small model qualifies — `phi3` and `gemma` variants, for instance, are read-only. A companion repo, [`imagewize/ollama-opencode-setup`](https://github.com/imagewize/ollama-opencode-setup) (`~/code/ollama-opencode-setup` locally), carries tool-calling results measured on this hardware — on **M1 16GB**, `ministral-3:8b` and `qwen3:8b`/`qwen3:4b` tool-call reliably; on **Mac Mini M4 Pro 24GB**, `mistral-small3.2:24b` (the persona's base) runs 100% on GPU at 32k with tool use confirmed. Verify any candidate with that repo's `scripts/tool-call-test.sh` before building the persona on it.

---

## Alternative: Single VM (All-in-One)

For **maximum simplicity** (at the cost of isolation), you can run everything in **one Lima VM**:

```bash
# Create a single VM (no shared network needed - everything is on localhost)
limactl create template:ubuntu \
  --name=mshin-allinone \
  --arch=aarch64 \
  --cpus=8 \
  --memory=12 \
  --disk=80

limactl start mshin-allinone
limactl shell mshin-allinone
```

Inside the VM:

```bash
# Install all dependencies
sudo apt update && sudo apt upgrade -y
# nikto is in Ubuntu's multiverse component, not main or universe.
sudo add-apt-repository -y multiverse && sudo apt update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git curl nmap nikto whois tshark

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Start the daemon — the installer leaves the unit disabled/inactive on the
# Ubuntu cloud image, so the pull below would otherwise not reach the API.
sudo systemctl enable --now ollama

# Pull model
ollama pull mistral

# Clone Machin Shin
sudo git clone https://github.com/imagewize/mshin.git /opt/mshin
sudo chown -R "$(whoami)" /opt/mshin

# Create mshin model. configs/ollama-modelfile is FROM mistral-small
# (24B, ~15GB); render a copy on the small model instead of building it as-is.
sed 's|^FROM .*|FROM mistral|' /opt/mshin/configs/ollama-modelfile > ~/Modelfile.lima
ollama create mshin -f ~/Modelfile.lima

# Allow the tools to run without a password prompt. tshark is omitted
# because reading user-owned PCAP files as root triggers Wireshark's
# file-owner check; tshark needs no privileges to analyze captures.
sudo tee /etc/sudoers.d/mshin >/dev/null <<EOF
$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/nikto, /usr/bin/whois
EOF
sudo chmod 440 /etc/sudoers.d/mshin

# Start MCP server in background
cd /opt/mshin/servers/src/kali
npm install
node index.js --tools nmap,nikto,whois,tshark &

# Start Machin Shin CLI in another session
/opt/mshin/clients/mshin-cli/index.js --node http://localhost:3000 --model mshin
```

### Verifying the tools

With the CLI running, exercise the reconnaissance tools the Ubuntu image actually provides. Only point scanners at hosts you own or are authorised to test; `127.0.0.1` and the local MCP server are safe targets for this guest.

First, capture a tiny loopback PCAP so `tshark` has something to analyze. `tshark` needs to own the capture file (Wireshark's file-owner check rejects root-owned or foreign-owned files), so chown it to your user after capture:

```bash
sudo tcpdump -i any -w /tmp/localhost.pcap -c 50 &
TCPDUMP_PID=$!
ping -c 2 127.0.0.1 >/dev/null 2>&1 || true
curl -4 -fsS http://127.0.0.1:3000/health >/dev/null || true
sleep 2
sudo kill $TCPDUMP_PID 2>/dev/null || true
wait $TCPDUMP_PID 2>/dev/null || true
sudo chown "$(whoami):$(whoami)" /tmp/localhost.pcap
```

Then, in the CLI session:

```
"Run a Nikto scan against http://127.0.0.1 and report any findings."
"Use the tshark tool to read /tmp/localhost.pcap and summarize the traffic."
```

`metasploit` and `searchsploit` are **not** in the Ubuntu repositories used here, so the four-tool list above leaves them out. They are not Kali-only, though — to add them, use the same upstream sources the two-machine Node does (exploit-db's git repo and Rapid7's apt repo; see [Install the tools](#install-the-tools) in Step 1), then add `metasploit,searchsploit` to the `--tools` list and `/usr/bin/searchsploit`, `/usr/bin/msfconsole` to the sudoers allowlist.

This single-VM path stays deliberately light and doesn't provision the other seven tools (`hydra`, `sqlmap`, `gobuster`, `masscan`, `dirb`, `arping`, `dnsenum`) either — they're Ubuntu-packaged the same way Debian ships them, so add them with `sudo apt install -y hydra sqlmap gobuster masscan dirb arping dnsenum`, extend the sudoers line and `--tools` flag above accordingly.

> **`nikto` is in `multiverse` on Ubuntu.** The install block above enables it up front so the package resolves cleanly. On Debian, nikto lives in `non-free`; the fix for the Debian guest is in [Step 1](#step-1-create-the-node-vm).

> **Pros:** Simplest setup, single VM to manage
> **Cons:** Less isolation, tools and LLM share resources, MCP server runs on localhost

---

## Performance Considerations

### Resource Allocation

| VM | CPUs | Memory | Disk | Notes |
| ---- | ---- | ------ | ---- | ----- |
| mshin-node | 2-4 | **4GB** (template default) | 30-50GB | No model, no inference — a Node.js process and short-lived CLI tools |
| mshin-core | 4-8 | **10GB** (template default) | 30-50GB | Holds the model; raise it if you swap in a bigger one |

**Total:** 8 CPUs, 14GB RAM, 100GB disk — sized so both guests fit the 16GB Mac
this guide takes as its minimum.

Change either with `limactl edit <name> --memory=<GiB>` (the instance must be
stopped; `limactl create` snapshots the template, so editing `lima/*.yaml`
afterwards does not affect an instance that already exists).

> **Never give a guest all of your host's RAM.** Lima will accept
> `memory: "16GiB"` on a 16GB Mac and the guest will boot, but macOS is then
> swapping against it from the first byte, and the other guest cannot start at
> all. Leave the host at least a quarter of physical RAM.

**On a 32GB Mac**, 12GB to Core and 4GB to the Node runs both comfortably.

**On a 16GB Mac**, the 10GB + 4GB defaults do start together, but the Core's
inference is CPU-only and the host is left with ~2GB. Two lighter paths:

- **Host Ollama + Node guest.** Run [Ollama](https://ollama.com) natively on
  macOS and start only `mshin-node`. Nothing in the architecture requires the
  Core to be a VM — the CLI is the MCP client and simply needs an Ollama
  endpoint, so point it at the host: `node clients/mshin-cli/index.js --node
  http://<NODE_IP>:3000 --ollama http://localhost:11434 --model mshin`. Build
  the persona on the host first against a base that fits
  (`sed 's|^FROM .*|FROM qwen3:8b|' configs/ollama-modelfile > /tmp/Modelfile
  && ollama create mshin -f /tmp/Modelfile`). Inference runs on the Mac's GPU
  rather than an emulated CPU, so this is also the *fastest* option.
- **One guest at a time**, or the [all-in-one single VM](#alternative-single-vm-all-in-one).

### Apple Silicon Notes

1. **x86_64 emulation:** Running x86_64 Kali in qemu on M1/M2 Macs works but is **slow** (~10-20x slower than native).
2. **aarch64 Kali:** Kali Linux publishes ARM64 builds, but Lima ships **no Kali template** (`limactl create --list-templates`) and `limactl create` boots **cloud images**, not installer ISOs. Kali's ARM64 releases are installer ISOs and pre-built VM disks rather than cloud-init images, so there is no drop-in Lima equivalent. The practical ARM64 path is what both paths in [Step 1](#step-1-create-the-node-vm) do — a Debian base with Kali tooling installed on top. See the [Lima templates documentation](https://lima-vm.io/docs/templates/) if you want to try wiring up a custom image.

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
| MCP connection refused | `curl http://<NODE_IP>:3000/health` fails | Check the MCP server is running in the Node VM |
| Ollama model won't load | `ollama list` shows model, but `ollama run` fails | Check VRAM: `free -h`; model may be too large |
| Slow performance | VMs are responsive but slow | Reduce CPU/memory allocation or use smaller model |
| `limactl create` rejects a flag | `unknown flag: --os` / `--ip` | Those flags do not exist; pass a template positionally and use `--network=lima:shared` |
| `limactl create` rejects memory | `invalid argument "8GiB"` | `--memory` and `--disk` take plain GiB numbers: `--memory=8` |
| VMs cannot ping each other | No `lima0` interface in the VM | Instance was created without `--network=lima:shared`; recreate it, and check `socket_vmnet` is installed |
| Node tools not found | `nmap` command not found | Reinstall tools: `sudo apt install -y nmap` |
| `E: Unable to locate package nikto` | Debian cloud image enables only `main` | `nikto` is in `non-free`; add it to `Components:` in `/etc/apt/sources.list.d/debian.sources`, then `apt update` |
| Template edit has no effect | Guest still behaves the old way after editing `lima/*.yaml` | `limactl create` snapshotted the template; edit `~/.lima/<name>/lima.yaml` with `limactl edit`, or delete and recreate |
| `limactl start` fails on a probe | "mshin-node did not come up" / "the mshin model was never created" | The probe timed out; the real error is in the guest. See `journalctl -u mshin-node -n 50` and `/var/log/cloud-init-output.log` |
| Persona pulls a 15GB model | `ollama create` on the repo Modelfile as-is | `configs/ollama-modelfile` is `FROM mistral-small`; render a copy with `FROM mistral` first |
| Model pull times out during provisioning | `provision.system` step fails right after the API wait; `systemctl status ollama` shows `disabled`/`inactive` | The installer did not start the daemon (seen on the Ubuntu 26.04 cloud image). `sudo systemctl enable --now ollama`. The Core template now does this automatically |
| Both VMs sluggish or swapping on a 16GB Mac | Core inference crawls while the Node is also running | The 10GB + 4GB defaults fit, but CPU-only inference leaves the host little. Run [host Ollama with only the Node guest](#resource-allocation), or one guest at a time |
| `limactl start mshin-core` warns `bind: address already in use` on 11434 | Ollama is also running natively on the Mac | Lima cannot forward the guest's Ollama to a host port that Ollama.app already holds. Harmless — the in-guest CLI uses the guest's own `localhost:11434`. Quit Ollama.app first if you want to reach the guest's Ollama from the Mac |
| `limactl start` exits `did not receive an event with the running status` | The guest is still `Running` and cloud-init is mid-provision | On a loaded host the hostagent can time out while the guest is fine. Check inside with `limactl shell <name> -- sudo tail -f /var/log/cloud-init-output.log`; the pull/persona finish on their own. `limactl shell` reconnects once it is up |
| `failed to listen tcp: 127.0.0.1:11434 ... address already in use` | Ollama is running on the **host** (e.g. `brew` install) on the same port | Harmless — only the host-side port-forward fails; the guest's own Ollama is unaffected. Stop host Ollama (`brew services stop ollama`) if you want the forward |

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
limactl delete mshin-node
limactl delete mshin-core

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
| `lima/mshin-node.yaml` | Debian 13 + all thirteen tools + `mshin-node` MCP server |
| `lima/mshin-core.yaml` | Ubuntu LTS + Ollama + the `mshin` persona and CLI |

Copy one, edit it, and pass its **path** to `limactl create`. (`~/.lima/` holds created *instances*, not templates — a file dropped there is not picked up.)

```bash
cp lima/mshin-node.yaml ~/my-node.yaml
$EDITOR ~/my-node.yaml

# Check it before you build it
limactl template validate ~/my-node.yaml

# See exactly what Lima will run, with every {{.Var}} resolved
limactl template copy --fill ~/my-node.yaml -

limactl create --name=my-kali ~/my-node.yaml
```

What is worth changing:

- **`mounts:`** — uncomment the block to bind your Mac clone to `/opt/mshin`, so edits to `servers/src/kali` take effect without a `git pull` in the guest. The provisioning skips its `chown` when the path is a mount.
- **`param.model`** (Core only) — the base model the persona is built on, overridable per-instance with `limactl create --param model=…`.
- **`cpus` / `memory` / `disk`** — see [Resource Allocation](#resource-allocation). Unlike the CLI flags, these YAML fields **do** take unit suffixes.
- **`arch`** — unset on purpose, so the guest matches the host. Set it only if you deliberately want emulation.

> **Note:** the key is `networks` (plural), and its only supported forms are `lima: <name>` or `socket: <path>` — a template cannot invent its own gateway or CIDR.

> **Provisioning runs on every boot.** Lima installs the blocks as cloud-init per-boot scripts (`/var/lib/cloud/scripts/per-boot/00-lima.boot.sh`, reading `/mnt/lima-cidata/provision.system/`), so each script guards itself and exits early when its work is already done. Keep that property if you add steps, or every `limactl start` will re-run an `apt-get install`.

> **`limactl create` snapshots the template.** The instance keeps its own copy at `~/.lima/<name>/lima.yaml`, and that copy is what generates the cidata the guest reads — so **editing the file in this repo does nothing to a VM that already exists**. To pick up a template change, either edit the instance in place (`limactl edit <name>`, or `limactl edit <name> --set '<yq expression>'` for a single field), or delete and recreate:
>
> ```bash
> limactl delete mshin-node
> limactl create --name=mshin-node lima/mshin-node.yaml
> ```
>
> Recreating is cheap after the first run — the cloud image stays in `~/Library/Caches/lima`, so only provisioning repeats. Check which one you are actually running with `grep <something-you-changed> ~/.lima/<name>/lima.yaml`.

---

## Resources

- [Lima Documentation](https://github.com/lima-vm/lima)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Machin Shin Architecture](ARCHITECTURE.md)
- [Machin Shin Setup Guide](SETUP.md)
- [Kali Linux Tools](https://www.kali.org/tools/)

---

## Limitations

1. **No GPU acceleration:** Lima doesn't pass through Mac GPU, so Ollama runs on CPU only.
2. **x86_64 emulation overhead:** On Apple Silicon, x86_64 Kali runs in qemu emulation (~10-20x slower).
3. **Shared resources:** Both VMs compete for your Mac's CPU, RAM, and disk.
4. **Not for production:** This setup is for **learning and testing only**.
5. **Network isolation:** The virtual network is isolated from your physical LAN by default.

> **For production use:** Follow the [full setup guide](SETUP.md) with dedicated hardware.

---

## Changelog

| Date | Change | Author |
| ---- | ------ | ------ |
| 2026-09-06 | Initial version: Lima local development guide | Jasper Frumau |
| 2026-09-06 | Correct `limactl` syntax, document shared vmnet networking, systemd unit and sudoers allowlist | Jasper Frumau |
| 2026-09-06 | Add `lima/` templates and split Setup into template and flag paths | Jasper Frumau |
| 2026-09-06 | Enable Debian's `non-free` component so `nikto` installs | Jasper Frumau |

---

## The Machin Shin Philosophy (Local Edition)

> *"Even in a single dark corridor, the Black Wind is still the Black Wind. So too can this system run on a single machine, that you might learn its ways before loosing it across the full two-host Pattern."*

The Wheel weaves as the Wheel wills. With Lima, you weave a smaller Pattern — but a Pattern nonetheless.
