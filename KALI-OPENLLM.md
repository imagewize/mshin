# Machin Shin: Wheel of Time-Inspired Cybersecurity AI

**Kali Linux MCP + Open LLM Setup Guide**  
*Named for the Black Wind of the Ways—the relentless hunter that finds what hides in the dark.*

---

## **Overview: The Machin Shin System**

> *"In the black corridors of the Ways, nothing moves that Machin Shin does not find. It hunts the dark without rest and lets nothing hide from it. So too does this system range the dark corners of your network, weaving the threads of what it finds into a single, clear account."*

**Machin Shin** is a **hybrid cybersecurity AI system** that combines:

- A **local, private LLM** (Mistral Small 3 / Llama 3.3 70B) for reasoning and analysis
- **Kali Linux tools** (Nmap, Metasploit, etc.) exposed via **Model Context Protocol (MCP)**
- A **two-machine architecture** for scalability and performance

This setup allows your LLM to **directly execute cybersecurity tools** in real-time, providing **augmented intelligence** for penetration testing, threat analysis, and incident response—**without fine-tuning or cloud dependencies**.

```
      ╭──────────────╮
 ─────╯              ╰───╮
 ────────────────────────╯
 ─────╮              ╭────
      ╰──────────────╯

        M A C H I N   S H I N
   ~ The Black Wind of the Ways ~
```

---

## **Hardware Architecture**

```
┌──────────────────────┐        ┌──────────────────────┐
│ Machin Shin Core     │        │ Kali Node (mini PC)  │
│ (32GB+ RAM, any box) │ <────> │ (Kali Linux + MCP)   │
│ - Runs Mistral Small │        │ - Runs Kali tools    │
│   24B (or larger)    │        │ - MCP Server         │
│ - Ollama             │        │ - Nmap, Metasploit,  │
│ - Handles inference  │        │   Searchsploit, etc. │
└──────────────────────┘        └──────────────────────┘
    MSHIN CORE                 MSHIN NODE
```


| Device                   | Role                                       | Specs                                 | Price (USD)  | Notes                               |
| ------------------------ | ------------------------------------------ | ------------------------------------- | ------------ | ----------------------------------- |
| **A machine you already own** | **Machin Shin Core** (LLM Inference Server) | 32GB+ RAM, any modern x86_64 or Apple Silicon | **$0**   | Runs Mistral Small 24B — the default, and enough for everything here |
| **Any x86_64 mini PC / SFF** | **Machin Shin Node** (Kali + MCP Server) | Intel N100/N150, Core i9-10980HK, Ryzen 7 5800U/7730U, etc. | $150–350     | Tool execution only; no inference   |
| **GMKtec EVO-X3** *(optional)* | Upgraded **Machin Shin Core**         | Ryzen AI Max+ 395, 128GB RAM, 2TB SSD | ~$3,800 (2026) | Only if you want 70B / 120B-class models locally |


**Total Cost:** **~$150–350** if you already have a 32GB machine for the Core — which
is the intended starting point. Add the EVO-X3 only when you have a concrete reason to
run a model that doesn't fit; see
[Sizing the Core](docs/architecture.md#sizing-the-core).

> **RAM does not buy speed.** It buys *capacity* — which models fit. A 32GB box and a
> 128GB box with the same memory bus run a 24B model at the same tokens/sec. Read the
> sizing section before spending anything.

---

## **Software Stack**


| Component       | Purpose                   | Version/Link                                                                               |
| --------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| Kali Linux      | Cybersecurity tools       | [kali.org](https://www.kali.org/)                                                          |
| MCP Server      | Exposes Kali tools to LLM | `servers/src/kali` (custom Machin Shin server) |
| Ollama          | LLM inference engine      | [ollama.com](https://ollama.com)                                                           |
| Mistral Small 3 / Llama 3.3 | Open-weight LLMs | [ollama.com/library](https://ollama.com/library)                                                          |
| Node.js         | Required for MCP server   | v20+                                                                                       |


---

## **Setup Instructions**

---

### **1. Machin Shin Node: Kali Linux + MCP Server**

#### **1.1 Install Kali Linux**

```bash
# Download Kali Linux ISO (minimal install, no GUI)
wget https://cdimage.kali.org/kali-2026.2/kali-linux-2026.2-installer-amd64.iso

# Install to the mini PC (use entire disk, ext4 filesystem)
# Select "Kali Linux (minimal)" during installation
```

#### **1.2 Install Dependencies**

```bash
# Update and install Node.js
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
```

#### **1.3 Install the Security Tools**

A minimal Kali install has no tool metapackages, so the thirteen tools the MCP
server wraps (`servers/src/kali/tools.js`) are not present yet — without this
step, every tool call fails with `Tool binary not found`. `exploitdb` is what
provides the `searchsploit` binary. This mirrors the package list in
`scripts/setup_mcp_server.sh` — keep the two in sync per the tool-list
invariant in `AGENTS.md`.

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
    net-tools
```

#### **1.4 Set Up MCP Server for Kali Tools**

Machin Shin ships its own Kali MCP server (the upstream `modelcontextprotocol/servers` repo does not include a Kali server).

```bash
# The server lives in the Machin Shin repository
cd /opt/mshin/servers/src/kali

# Install dependencies
npm install

# Start the MCP server (Machin Shin Node)
node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum &
```

#### **1.5 Create a `systemd` Service for MCP Server**

```ini
# /etc/systemd/system/mshin-node.service
[Unit]
Description=Machin Shin Node: MCP Server for Kali Tools
After=network.target

[Service]
User=mshin
WorkingDirectory=/opt/mshin/servers/src/kali
ExecStart=/usr/bin/node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum
Restart=always
RestartSec=5s
Environment=NODE_ENV=production

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

**Enable and start the service:**

```bash
sudo systemctl enable mshin-node
sudo systemctl start mshin-node
sudo systemctl status mshin-node  # Verify it's running
```

#### **1.6 Restrict `mshin` User Permissions**

`tools.js` runs every binary as `sudo -n <tool>` whenever the server is not
root, so without this allowlist every tool call fails with
`sudo: a password is required`:

```bash
sudo visudo
```

Add the following line. `tshark` is omitted: it does not need root to read
user-owned PCAP files, and running it as root triggers Wireshark's
file-owner check.

```
mshin ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/hydra, /usr/bin/sqlmap, /usr/bin/gobuster, /usr/bin/masscan, /usr/bin/dirb, /usr/bin/arping, /usr/bin/dnsenum
```

#### **1.7 Assign a Static IP**

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

Apply changes:

```bash
sudo netplan apply
```

---

### **2. Machin Shin Core: LLM Inference Server**

#### **2.1 Install Ollama**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

#### **2.2 Pull Your Model**

```bash
# Default: Mistral Small 3 24B (Q4_K_M, ~14GB) — fast, good tool-caller
ollama pull mistral-small

# Larger/more capable — only if the Core has the RAM (see Sizing the Core):
ollama pull qwen3:32b      # ~20GB
ollama pull llama3.3:70b   # ~40GB
ollama pull gpt-oss:120b   # ~65GB, MoE — fastest of the three despite its size
```

#### **2.3 Create the Machin Shin Persona Model**

```bash
ollama create mshin -f /opt/mshin/configs/ollama-modelfile
```

#### **2.4 Install the Machin Shin CLI Client**

```bash
cd /opt/mshin/clients/mshin-cli
npm install
```

#### **2.5 Connect to Machin Shin Node**

```bash
# Use the wrapper installed by setup_ollama.sh:
mshin 192.168.1.100

# Or run the client directly:
/opt/mshin/clients/mshin-cli/index.js --node http://192.168.1.100:3000 --model mshin
```

Replace `192.168.1.100` with the **IP of your Machin Shin Node**.

#### **2.6 Assign a Static IP**

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

Apply changes:

```bash
sudo netplan apply
```

---

## **Network Setup**

1. **Connect both devices to the same LAN** via Ethernet (recommended) or Wi-Fi.
2. **Verify connectivity** from Machin Shin Core:
  ```bash
   ping 192.168.1.100  # Machin Shin Node IP
   curl http://192.168.1.100:3000/health  # MCP server health check
  ```
3. **Test the connection** from Machin Shin Core:
  ```bash
   mshin 192.168.1.100
  ```

---

## **Example Workflows**

---

### **Workflow 1: Automated Vulnerability Scanning**

**User Prompt:**

```
"Machin Shin, run an Nmap scan on 192.168.1.1, then use Searchsploit to find exploits for any vulnerable services."
```

**Machin Shin Actions:**

1. Calls MCP `nmap` tool: `nmap -sV 192.168.1.1`
2. Parses output (e.g., finds `OpenSSH 8.9`)
3. Calls MCP `searchsploit` tool: `searchsploit openssh 8.9`
4. Returns:
  ```
   [MSHIN ANALYSIS]
   Found CVE-2026-1234 (CVSS 9.8) in OpenSSH 8.9.
   Exploit: exploit/linux/ssh/cve_2026_1234
   Metasploit command: msfconsole -x 'use exploit/linux/ssh/cve_2026_1234; set RHOSTS 192.168.1.1; run'
  ```

---

### **Workflow 2: Incident Response**

**User Prompt:**

```
"Machin Shin, analyze this suspicious IP: 203.0.113.45. Use WHOIS and check for known threats."
```

**Machin Shin Actions:**

1. Calls MCP `whois` tool: `whois 203.0.113.45`
2. Returns:
  ```
   [MSHIN INTEL]
   IP belongs to AS12345 (Malicious Hosting Inc.).
   Recommendation: Correlate with external threat intel (e.g., AbuseIPDB) and consider blocking at the firewall.
  ```

---

### **Workflow 3: Exploit Development**

**User Prompt:**

```
"Machin Shin, generate a Metasploit command to exploit CVE-2026-1234 on 192.168.1.1."
```

**Machin Shin Actions:**

1. Calls MCP `metasploit` tool to validate the exploit module
2. Returns:
  ```
   [MSHIN COMMAND]
   msfconsole -x 'use exploit/linux/ssh/cve_2026_1234; set RHOSTS 192.168.1.1; run'
  ```

---

## **Alternative: SSH Access (No MCP)**

If MCP is too experimental, let the LLM **SSH into the Machin Shin Node** and run commands directly.

#### **1. Set Up SSH Access**

On the Machin Shin Node:

```bash
# Create a dedicated user for the LLM
sudo adduser mshin
sudo usermod -aG sudo mshin

# Set up SSH keys (no password)
sudo mkdir -p /home/mshin/.ssh
sudo cp ~/.ssh/authorized_keys /home/mshin/.ssh/
sudo chown -R mshin:mshin /home/mshin/.ssh
```

#### **2. Restrict `mshin` to Specific Tools**

Edit `/etc/sudoers`:

```bash
sudo visudo
```

Add:

```
# tshark is omitted: it does not need root to read user-owned PCAP files, and
# running it as root triggers Wireshark's file-owner check.
mshin ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/hydra, /usr/bin/sqlmap, /usr/bin/gobuster, /usr/bin/masscan, /usr/bin/dirb, /usr/bin/arping, /usr/bin/dnsenum
```

#### **3. Test SSH Access**

From Machin Shin Core:

```bash
ssh mshin@192.168.1.100 "nmap -sV 192.168.1.1"
```

#### **4. Use with LLM**

Prompt the LLM to run SSH commands:

```
"Machin Shin, SSH into the Kali Node and run 'nmap -sV 192.168.1.1'."
```

#### **5. Verify Every MCP Tool**

With the CLI pointed at the Node, these prompts exercise all thirteen tools against safe targets. Only run scans against systems you own or are authorised to test.

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
```

> **`metasploit`, `hydra`, and `sqlmap` require approval.** They are the active tools in the approval gate; the CLI will prompt you before any of them runs.
>
> **`tshark` needs user-owned PCAP files.** The server runs `tshark` without `sudo`; capture files must be readable by the `mshin` user.

---

## **Tips and Best Practices**

### **1. Security**

- **Isolate the Machin Shin Node** on a separate VLAN if handling sensitive data.
- **Use SSH keys** (disable password authentication).
- **Restrict `mshin` user** to only necessary tools (via `sudoers`).

### **2. Performance**

- Use **Ethernet** for both devices to minimize latency.
- For **faster inference**, use `ollama run mistral-small` with `--num-gpu 100` (if GPU is available).
- For **MCP server**, run only the tools you need (e.g., `--tools nmap,metasploit`).

### **3. Maintenance**

- **Update Kali tools regularly:**
  ```bash
  sudo apt update && sudo apt upgrade -y
  ```
- **Backup your LLM models:**
  ```bash
  cp -r ~/.ollama /backup/ollama
  ```

---

## **Troubleshooting**


| Issue                     | Solution                                           |
| ------------------------- | -------------------------------------------------- |
| MCP server not running    | Check `sudo systemctl status mshin-node`      |
| Connection refused to MCP | Verify IP/port and firewall rules                  |
| LLM can't call MCP tools  | Check MCP server logs for errors                   |
| Slow tool execution       | Use lightweight tools (e.g., `nmap` not GUI tools) |
| Ollama fails to start     | Check `ollama serve` logs and GPU drivers          |


---

## **Resources**

- [MCP Documentation](https://github.com/modelcontextprotocol/specification)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Kali Linux Tools](https://www.kali.org/tools/)
- [Mistral AI Models](https://mistral.ai/models/)
- [Wheel of Time Wiki: Machin Shin](https://wot.fandom.com/wiki/Machin Shin)

---

## **Changelog**


| Date       | Change                                   | Author        |
| ---------- | ---------------------------------------- | ------------- |
| 2026-05-30 | Initial version: Machin Shin system setup | Jasper Frumau |


---

## **License**

This document is provided as-is for personal use. No warranty or liability is implied.

---

## **The Machin Shin Philosophy**

> *"Like the Black Wind in the Ways, this system ranges the dark corridors of your networks without rest. Nothing that hides there escapes it, and all that it finds it carries back to you. May it hunt for you as tirelessly as Machin Shin hunts the Ways."*

---

*"The Wheel weaves as the Wheel wills. With Machin Shin, you weave with it."*