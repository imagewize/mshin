# Machin Shin Setup Guide

> *"The Way of the Leaf is not for all, but the Way of the Blade must be mastered. So too must you master the setup of Machin Shin, that it may serve you as the Aiel serve the Dragon."*

This guide will walk you through setting up **Machin Shin**, the **Wheel of Time-inspired cybersecurity AI system**. Follow the steps below to configure both the **Machin Shin Core** (LLM inference server) and the **Machin Shin Node** (Kali Linux + MCP server).

---

## **Prerequisites**

### **Hardware**


| Component           | Role                    | Minimum (start here)            | Optional ceiling                    |
| ------------------- | ----------------------- | ------------------------------- | ----------------------------------- |
| **Machin Shin Core** | LLM Inference Server    | 32GB RAM, ~50GB free disk, modern CPU | 128GB unified-memory APU (e.g. GMKtec EVO-X3) |
| **Machin Shin Node** | Kali Linux + MCP Server | 16GB RAM, 500GB SSD, x86_64 CPU | Any x86_64 mini PC / SFF            |

The 32GB minimum is a real minimum, not a polite one — it runs the default
`mistral-small` (24B) model and every workflow in this guide. **Use a machine you
already own before buying anything.** More RAM buys larger models, not faster ones;
[Sizing the Core](ARCHITECTURE.md#sizing-the-core) explains the trade-off and when the
128GB box is actually worth it.


### **Network**

- Both devices must be on the **same local network** (Ethernet recommended).
- Assign **static IPs** to both devices (see [Network Setup](#network-setup)).

### **Software Dependencies**

- **Machin Shin Node:** Kali Linux (minimal install), Node.js v20+, Git
- **Machin Shin Core:** Ubuntu/Debian, Ollama, Node.js v20+

---

## **Network Setup**

### **1. Assign Static IPs**

To ensure both devices can always communicate, assign static IPs.

#### **On Machin Shin Node:**

Create `/etc/netplan/00-mshin-node.yaml`:

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - 192.168.1.100/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
```

Apply the changes:

```bash
sudo netplan apply
```

#### **On Machin Shin Core:**

Create `/etc/netplan/00-mshin-core.yaml`:

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - 192.168.1.200/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
```

Apply the changes:

```bash
sudo netplan apply
```

### **2. Verify Connectivity**

From **Machin Shin Core**, test the connection to **Machin Shin Node**:

```bash
ping 192.168.1.100
```

If successful, you should see responses like:

```
64 bytes from 192.168.1.100: icmp_seq=1 ttl=64 time=0.456 ms
```

---

## **Step 1: Set Up Machin Shin Node (Kali Linux + MCP Server)**

### **1.1 Install Kali Linux**

1. Download the **Kali Linux minimal ISO** (no GUI):
  ```bash
   wget https://cdimage.kali.org/kali-2026.2/kali-linux-2026.2-installer-amd64.iso
  ```
2. Create a bootable USB drive (use **Rufus** or **Balena Etcher**).
3. Boot the mini PC from the USB and install Kali Linux:
  - Select **"Kali Linux (minimal)"** during installation.
  - Use the entire disk for installation.
  - Set a **strong root password** (you’ll disable root login later).

### **1.2 Update Kali Linux**

After installation, log in and run:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl wget
```

### **1.3 Install the Security Tools**

A minimal Kali install has no tool metapackages, so the sixteen tools the MCP
server wraps (`servers/src/kali/tools.js`) are not present yet — without this
step, every tool call fails with `Tool binary not found`:

```bash
sudo apt install -y \
    openssl \
    nmap \
    metasploit-framework \
    exploitdb \
    nikto \
    whois \
    tshark \
    hydra \
    sqlmap \
    gobuster \
    masscan \
    dirb \
    arping \
    dnsenum \
    enum4linux \
    ffuf \
    john \
    net-tools
```

`exploitdb` is what provides the `searchsploit` binary. This mirrors the
package list in `scripts/setup_mcp_server.sh` — keep the two in sync per the
tool-list invariant in `AGENTS.md`.

### **1.4 Install Node.js**

The MCP server requires Node.js v20+:

```bash
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node --version  # Should output v20.x.x
```

### **1.5 Set Up the MCP Server**

Machin Shin ships its own Kali MCP server at `servers/src/kali`.

1. Change to the server directory (adjust the path if you did not use `/opt/mshin`):
  ```bash
   cd /opt/mshin/servers/src/kali
  ```
2. Install dependencies:
  ```bash
   npm install
  ```
3. Test the MCP server manually:
  ```bash
   node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum,enum4linux,ffuf,john &
  ```
   This starts the server on `http://localhost:3000`.
4. Verify the server is running:
  ```bash
   curl http://localhost:3000/health
  ```
   You should see a JSON response listing the enabled tools.

### **1.6 Create a Dedicated User for Machin Shin**

For security, create a dedicated user (`mshin`) to run the MCP server:

```bash
sudo adduser mshin
sudo usermod -aG sudo mshin
```

### **1.7 Set Up SSH Access (Optional but Recommended)**

1. Switch to the `mshin` user:
  ```bash
   su - mshin
  ```
2. Generate SSH keys (if you want to access the node remotely):
  ```bash
   ssh-keygen -t ed25519
  ```
3. Copy the public key to `~/.ssh/authorized_keys`:
  ```bash
   mkdir -p ~/.ssh
   cp ~/.ssh/id_ed25519.pub ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
  ```

### **1.8 Create a `systemd` Service for the MCP Server**

To ensure the MCP server starts automatically on boot:

1. Create a service file:
  ```bash
   sudo nano /etc/systemd/system/mshin-node.service
  ```
2. Add the following configuration:
  ```ini
   [Unit]
   Description=Machin Shin Node: MCP Server for Kali Tools
   After=network.target

   [Service]
   User=mshin
   WorkingDirectory=/opt/mshin/servers/src/kali
    ExecStart=/usr/bin/node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum,enum4linux,ffuf,john
   Restart=always
   RestartSec=5s
   Environment=NODE_ENV=production
   # Optional: restrict which targets the Node will scan or attack. When set,
   # every network-facing tool argument is checked against this comma-separated
   # list of IPs, CIDR ranges, or hostnames before execution. Leave unset to
   # allow all targets (the legacy default).
   # Environment=MSHIN_ALLOWED_TARGETS="192.168.1.0/24,127.0.0.1,*.example.com"

   # Security settings
   # NoNewPrivileges is deliberately NOT set. tools.js runs most binaries as
   # `sudo -n <bin>` whenever the server is not root, and NoNewPrivileges=true
   # blocks exactly that: every tool call fails with "sudo: a password is
   # required". The sudoers allowlist constrains the service instead.
   PrivateTmp=true
   ProtectSystem=strict
   ProtectHome=read-only
   ReadWritePaths=/opt/mshin /home/mshin

   [Install]
   WantedBy=multi-user.target
  ```
3. Enable and start the service:
  ```bash
   sudo systemctl enable mshin-node
   sudo systemctl start mshin-node
   sudo systemctl status mshin-node  # Verify it's running
  ```
4. Check the logs if there are issues:
  ```bash
   sudo journalctl -u mshin-node -f
  ```

### **1.9 Restrict `mshin` User Permissions**

To limit the `mshin` user to only necessary tools, edit the sudoers file:

```bash
sudo visudo
```

Add the following line:

```
# tshark is omitted: it does not need root to read user-owned PCAP files, and
# running it as root triggers Wireshark's file-owner check.
mshin ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/hydra, /usr/bin/sqlmap, /usr/bin/gobuster, /usr/bin/masscan, /usr/bin/dirb, /usr/bin/arping, /usr/bin/dnsenum, /usr/bin/enum4linux, /usr/bin/ffuf, /usr/bin/john
```

### **1.10 Restrict Targets with `MSHIN_ALLOWED_TARGETS`**

By default the Node accepts any target the LLM passes to a tool. To constrain an engagement, set the `MSHIN_ALLOWED_TARGETS` environment variable to a comma-separated list of allowed IPs, CIDR ranges, and hostnames. The Node checks every network-facing tool argument against this list before execution.

Format:
```bash
MSHIN_ALLOWED_TARGETS="192.168.1.0/24,127.0.0.1,*.example.com"
```

Rules:
- Exact IPv4 match: `127.0.0.1`
- CIDR match: `192.168.1.0/24` matches `192.168.1.100`
- Exact hostname: `scanme.nmap.org`
- Subdomain wildcard: `*.example.com` matches `www.example.com` but not `example.com` itself
- URL targets are parsed for their hostname: `http://192.168.1.100/path` matches `192.168.1.0/24`

Apply it in the systemd unit (`/etc/systemd/system/mshin-node.service`) by uncommenting or adding:
```ini
Environment=MSHIN_ALLOWED_TARGETS="192.168.1.0/24,127.0.0.1,*.example.com"
```

Then reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart mshin-node
sudo journalctl -u mshin-node -f
```

You will see the active scope logged at startup:
```
[INFO] Target scope allowlist: 192.168.1.0/24, 127.0.0.1, *.example.com
```

### **1.11 Require Node Authentication with `MSHIN_NODE_TOKEN`**

The Node listens on `0.0.0.0:3000`, so any host on the LAN can reach `/mcp` and drive the tools — including the active ones (`metasploit`, `hydra`, `sqlmap`, `john`). The allowlist above constrains *which targets* the tools may touch; authentication constrains *who may call* the Node at all.

Generate a token:

```bash
openssl rand -hex 32
```

Set it in the systemd unit (`/etc/systemd/system/mshin-node.service`):

```ini
Environment=MSHIN_NODE_TOKEN="<output of openssl rand -hex 32>"
```

`scripts/setup_mcp_server.sh` does this for you: it generates a token, stores it root-only in `/etc/mshin-node-token`, and injects the `Environment=` line into the unit. Re-running the script reuses the stored token, so the Core never loses access.

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart mshin-node
sudo journalctl -u mshin-node -f
```

You will see the mode logged at startup:
```
[INFO] Bearer-token authentication: enabled (MSHIN_NODE_TOKEN set)
```

On the **Core**, pass the same token to the CLI — as a flag or an environment variable:

```bash
mshin --token "<token>" 192.168.1.100
# or
MSHIN_NODE_TOKEN="<token>" mshin 192.168.1.100
# or run the client directly:
/opt/mshin/clients/mshin-cli/index.js --node http://192.168.1.100:3000 --model mshin --token "<token>"
```

The evaluation harness takes it from the config file or the environment:

```json
{ "nodeToken": "<token>", "nodeUrl": "http://192.168.1.100:3000", "cases": [ ... ] }
```

Verify from the Node itself — without the token the MCP endpoint refuses, with it the handshake proceeds:

```bash
# 401 — rejected
curl -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' -d '{}'

# 200 — accepted
curl -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "Authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

`/health` stays open without a token so the documented health check and monitoring keep working; it reports only status and the tool list. Leave `MSHIN_NODE_TOKEN` unset to keep the legacy open behavior — not recommended for a Node reachable by other hosts.

> **The token is a credential.** Anyone who reads it can run every tool the Node exposes. Keep it out of shell history, the repo, and world-readable files; `/etc/mshin-node-token` is mode 600 for a reason.

### **1.12 Verify the Node Tools**

Once the Core is set up and the CLI is pointed at the Node (`http://192.168.1.100:3000`), use these prompts to exercise each tool against systems you own. `metasploit`, `hydra`, `sqlmap`, and `john` are destructive-by-default and the CLI will ask for approval before any of them runs; the rest are passive.

```
"Scan 127.0.0.1 with nmap and list the open ports."
"Whois example.com."
"Search searchsploit for openssh 8.9."
"Run nikto against http://127.0.0.1 and report any findings."
"Use tshark to read /home/mshin/capture.pcap and summarize the traffic."
"Run the metasploit auxiliary scanner http/http_version against 127.0.0.1."
"Test hydra with a service scan on 127.0.0.1 for ssh."
"Run sqlmap against http://127.0.0.1 with default settings."
"Use gobuster to brute-force directories on http://127.0.0.1."
"Run masscan on 127.0.0.0/8 with a fast scan."
"Use dirb to brute-force http://127.0.0.1."
"Run arping to discover hosts on the local network."
"Use dnsenum to enumerate example.com."
"Enumerate SMB shares on 127.0.0.1 with enum4linux."
"Fuzz directories on http://127.0.0.1 with ffuf."
"Crack the hashes in /home/mshin/hashes.txt with john."
```

> **PCAP ownership matters.** Capture files must be readable by the `mshin` user; `tshark` is run without `sudo` because Wireshark's file-owner check rejects root-owned captures.

---

## **Step 2: Set Up Machin Shin Core (LLM Inference Server)**

### **2.1 Install Ubuntu/Debian**

If your Core machine doesn’t already have Linux installed:

1. Download **Ubuntu 24.04 LTS** or **Debian 12**:
  ```bash
   wget https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso
  ```
2. Create a bootable USB and install Ubuntu/Debian.

### **2.2 Install Dependencies**

Update the system and install required packages:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git

# Node.js 20+ is required for the CLI client
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
```

### **2.3 Install Ollama**

Ollama is the easiest way to run LLMs locally:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### **2.4 Pull the LLM Model**

Pull **Mistral Small 3 (24B)** (recommended for balance of performance and capability):

```bash
ollama pull mistral-small
```

Larger models, **only if your Core has the memory for them** (see
[Sizing the Core](ARCHITECTURE.md#sizing-the-core)) — they are not required:

```bash
ollama pull qwen3:32b      # ~20GB, needs ~48GB+ RAM
ollama pull llama3.3:70b   # ~40GB, needs ~64GB+ RAM
ollama pull gpt-oss:120b   # ~65GB, needs 128GB — fastest of the three (MoE)
```

### **2.5 Create the Machin Shin Persona Model**

```bash
ollama create mshin -f /opt/mshin/configs/ollama-modelfile
```

### **2.6 Install the Machin Shin CLI Client**

```bash
cd /opt/mshin/clients/mshin-cli
npm install
```

### **2.7 Connect to Machin Shin Node**

Run the client, pointing it to the Machin Shin Node’s MCP server:

```bash
# Wrapper installed by setup_ollama.sh:
mshin 192.168.1.100

# Or directly:
/opt/mshin/clients/mshin-cli/index.js --node http://192.168.1.100:3000 --model mshin
```

Replace `192.168.1.100` with the **IP of your Machin Shin Node**.

### **2.8 Test the Connection**

Once connected, test the system with a prompt:

```
"Machin Shin, run an Nmap scan on 192.168.1.1 and analyze the results."
```

If everything is set up correctly, Machin Shin should:

1. Call the `nmap` tool on the Machin Shin Node.
2. Return the scan results.
3. Analyze the results and provide recommendations.

---

## **Troubleshooting**

### **MCP Server Not Running**

- **Check the service status:**
  ```bash
  sudo systemctl status mshin-node
  ```
- **Check the logs:**
  ```bash
  sudo journalctl -u mshin-node -f
  ```
- **Manual start:**
  ```bash
  cd /opt/mshin/servers/src/kali
  node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum,enum4linux,ffuf,john
  ```

### **Connection Refused to MCP Server**

- **Verify the IP and port:**
  ```bash
  curl http://192.168.1.100:3000/health
  ```
- **Check firewall rules:**
  ```bash
  sudo ufw status  # On Machin Shin Node
  ```
- **Temporarily disable the firewall for testing:**
  ```bash
  sudo ufw disable
  ```

### **Ollama Fails to Start**

- **Check GPU drivers (if using GPU acceleration):**
  ```bash
  nvidia-smi  # For NVIDIA GPUs
  ```
- **Reinstall Ollama:**
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ```
- **Check Ollama logs:**
  ```bash
  journalctl -u ollama -f
  ```

### **LLM Can’t Call MCP Tools**

- **Verify the CLI client can connect:**
  ```bash
  /opt/mshin/clients/mshin-cli/index.js --node http://192.168.1.100:3000 --model mshin
  ```
- **Check the MCP server logs for errors.**

---

## **Next Steps**

Once Machin Shin is set up, explore the following:

1. **Try the example workflows** in [docs/WORKFLOWS.md](mshin-workflows).
2. **Add more tools** to the MCP server (edit the `--tools` flag in the service file).
3. **Customize prompts** for your LLM (see [configs/ollama-modelfile](mshin-ollama-modelfile)).

---

## **Additional Resources**

- [MCP Documentation](https://github.com/modelcontextprotocol/specification)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Kali Linux Tools](https://www.kali.org/tools/)

---

*"The Flame of Tar Valon burns bright, but the light of Machin Shin guides your path through the shadows of the Ways."*