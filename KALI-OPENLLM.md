# Avendesora: Wheel of Time-Inspired Cybersecurity AI

**Kali Linux MCP + Open LLM Setup Guide**  
*Inspired by the enduring Avendesora tree—rooted in stability, branching into wisdom.*

---

## **Overview: The Avendesora System**

> *"When the Breaking shattered the world, Avendesora endured—carried to safety as a cutting by the Aiel and rooted anew, its branches reaching toward the future. So too does this system stand resilient against the storms of cyber threats, weaving the threads of knowledge into a lasting shield."*

**Avendesora** is a **hybrid cybersecurity AI system** that combines:

- A **local, private LLM** (Mistral Small 3 / Llama 3.3 70B) for reasoning and analysis
- **Kali Linux tools** (Nmap, Metasploit, etc.) exposed via **Model Context Protocol (MCP)**
- A **two-machine architecture** for scalability and performance

This setup allows your LLM to **directly execute cybersecurity tools** in real-time, providing **augmented intelligence** for penetration testing, threat analysis, and incident response—**without fine-tuning or cloud dependencies**.

```
       \ | /
     \  \|/  /
   '-.\\\|///.-'
  '--._\\|//_.--'
      \\\|///
        \|/
         |
         |

        A V E N D E S O R A
   ~ The Enduring Security AI ~
```

---

## **Hardware Architecture**

```
┌──────────────────────┐        ┌──────────────────────┐
│ Avendesora Core      │        │ Kali Node (mini PC)  │
│ (32GB+ RAM, any box) │ <────> │ (Kali Linux + MCP)   │
│ - Runs Mistral Small │        │ - Runs Kali tools    │
│   24B (or larger)    │        │ - MCP Server         │
│ - Ollama             │        │ - Nmap, Metasploit,  │
│ - Handles inference  │        │   Searchsploit, etc. │
└──────────────────────┘        └──────────────────────┘
    AVENDESORA CORE                 AVENDESORA NODE
```


| Device                   | Role                                       | Specs                                 | Price (USD)  | Notes                               |
| ------------------------ | ------------------------------------------ | ------------------------------------- | ------------ | ----------------------------------- |
| **A machine you already own** | **Avendesora Core** (LLM Inference Server) | 32GB+ RAM, any modern x86_64 or Apple Silicon | **$0**   | Runs Mistral Small 24B — the default, and enough for everything here |
| **Any x86_64 mini PC / SFF** | **Avendesora Node** (Kali + MCP Server) | Intel N100/N150, Core i9-10980HK, Ryzen 7 5800U/7730U, etc. | $150–350     | Tool execution only; no inference   |
| **GMKtec EVO-X3** *(optional)* | Upgraded **Avendesora Core**         | Ryzen AI Max+ 395, 128GB RAM, 2TB SSD | ~$3,800 (2026) | Only if you want 70B / 120B-class models locally |


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
| MCP Server      | Exposes Kali tools to LLM | `servers/src/kali` (custom Avendesora server) |
| Ollama          | LLM inference engine      | [ollama.com](https://ollama.com)                                                           |
| Mistral Small 3 / Llama 3.3 | Open-weight LLMs | [ollama.com/library](https://ollama.com/library)                                                          |
| Node.js         | Required for MCP server   | v20+                                                                                       |


---

## **Setup Instructions**

---

### **1. Avendesora Node: Kali Linux + MCP Server**

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

#### **1.3 Set Up MCP Server for Kali Tools**

Avendesora ships its own Kali MCP server (the upstream `modelcontextprotocol/servers` repo does not include a Kali server).

```bash
# The server lives in the Avendesora repository
cd /opt/avendesora/servers/src/kali

# Install dependencies
npm install

# Start the MCP server (Avendesora Node)
node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark &
```

#### **1.4 Create a `systemd` Service for MCP Server**

```ini
# /etc/systemd/system/avendesora-node.service
[Unit]
Description=Avendesora Node: MCP Server for Kali Tools
After=network.target

[Service]
User=avendesora
WorkingDirectory=/opt/avendesora/servers/src/kali
ExecStart=/usr/bin/node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark
Restart=always
RestartSec=5s
Environment=NODE_ENV=production

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/avendesora /home/avendesora

[Install]
WantedBy=multi-user.target
```

**Enable and start the service:**

```bash
sudo systemctl enable avendesora-node
sudo systemctl start avendesora-node
sudo systemctl status avendesora-node  # Verify it's running
```

#### **1.5 Assign a Static IP**

Create `/etc/netplan/00-avendesora-node.yaml`:

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

### **2. Avendesora Core: LLM Inference Server**

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

#### **2.3 Create the Avendesora Persona Model**

```bash
ollama create avendesora -f /opt/avendesora/configs/ollama-modelfile
```

#### **2.4 Install the Avendesora CLI Client**

```bash
cd /opt/avendesora/clients/avendesora-cli
npm install
```

#### **2.5 Connect to Avendesora Node**

```bash
# Use the wrapper installed by setup_ollama.sh:
avendesora 192.168.1.100

# Or run the client directly:
/opt/avendesora/clients/avendesora-cli/index.js --node http://192.168.1.100:3000 --model avendesora
```

Replace `192.168.1.100` with the **IP of your Avendesora Node**.

#### **2.6 Assign a Static IP**

Create `/etc/netplan/00-avendesora-core.yaml`:

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
2. **Verify connectivity** from Avendesora Core:
  ```bash
   ping 192.168.1.100  # Avendesora Node IP
   curl http://192.168.1.100:3000/health  # MCP server health check
  ```
3. **Test the connection** from Avendesora Core:
  ```bash
   avendesora 192.168.1.100
  ```

---

## **Example Workflows**

---

### **Workflow 1: Automated Vulnerability Scanning**

**User Prompt:**

```
"Avendesora, run an Nmap scan on 192.168.1.1, then use Searchsploit to find exploits for any vulnerable services."
```

**Avendesora Actions:**

1. Calls MCP `nmap` tool: `nmap -sV 192.168.1.1`
2. Parses output (e.g., finds `OpenSSH 8.9`)
3. Calls MCP `searchsploit` tool: `searchsploit openssh 8.9`
4. Returns:
  ```
   [AVENDESORA ANALYSIS]
   Found CVE-2026-1234 (CVSS 9.8) in OpenSSH 8.9.
   Exploit: exploit/linux/ssh/cve_2026_1234
   Metasploit command: msfconsole -x 'use exploit/linux/ssh/cve_2026_1234; set RHOSTS 192.168.1.1; run'
  ```

---

### **Workflow 2: Incident Response**

**User Prompt:**

```
"Avendesora, analyze this suspicious IP: 203.0.113.45. Use WHOIS and check for known threats."
```

**Avendesora Actions:**

1. Calls MCP `whois` tool: `whois 203.0.113.45`
2. Returns:
  ```
   [AVENDESORA INTEL]
   IP belongs to AS12345 (Malicious Hosting Inc.).
   Recommendation: Correlate with external threat intel (e.g., AbuseIPDB) and consider blocking at the firewall.
  ```

---

### **Workflow 3: Exploit Development**

**User Prompt:**

```
"Avendesora, generate a Metasploit command to exploit CVE-2026-1234 on 192.168.1.1."
```

**Avendesora Actions:**

1. Calls MCP `metasploit` tool to validate the exploit module
2. Returns:
  ```
   [AVENDESORA COMMAND]
   msfconsole -x 'use exploit/linux/ssh/cve_2026_1234; set RHOSTS 192.168.1.1; run'
  ```

---

## **Alternative: SSH Access (No MCP)**

If MCP is too experimental, let the LLM **SSH into the Avendesora Node** and run commands directly.

#### **1. Set Up SSH Access**

On the Avendesora Node:

```bash
# Create a dedicated user for the LLM
sudo adduser avendesora
sudo usermod -aG sudo avendesora

# Set up SSH keys (no password)
sudo mkdir -p /home/avendesora/.ssh
sudo cp ~/.ssh/authorized_keys /home/avendesora/.ssh/
sudo chown -R avendesora:avendesora /home/avendesora/.ssh
```

#### **2. Restrict `avendesora` to Specific Tools**

Edit `/etc/sudoers`:

```bash
sudo visudo
```

Add:

```
# tshark is omitted: it does not need root to read user-owned PCAP files, and
# running it as root triggers Wireshark's file-owner check.
avendesora ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois
```

#### **3. Test SSH Access**

From Avendesora Core:

```bash
ssh avendesora@192.168.1.100 "nmap -sV 192.168.1.1"
```

#### **4. Use with LLM**

Prompt the LLM to run SSH commands:

```
"Avendesora, SSH into the Kali Node and run 'nmap -sV 192.168.1.1'."
```

#### **5. Verify Every MCP Tool**

With the CLI pointed at the Node, these prompts exercise all six tools against safe targets. Only run scans against systems you own or are authorised to test.

```
"Scan 127.0.0.1 with nmap and list the open ports."
"Whois example.com."
"Search searchsploit for openssh 8.9."
"Run nikto against http://127.0.0.1 and report any findings."
"Use tshark to read /home/avendesora/capture.pcap and summarize the traffic."
"Run the metasploit auxiliary scanner http/http_version against 127.0.0.1."
```

> **`metasploit` requires approval.** It is the only active tool in the approval gate; the CLI will prompt you before it runs.
>
> **`tshark` needs user-owned PCAP files.** The server runs `tshark` without `sudo`; capture files must be readable by the `avendesora` user.

---

## **Tips and Best Practices**

### **1. Security**

- **Isolate the Avendesora Node** on a separate VLAN if handling sensitive data.
- **Use SSH keys** (disable password authentication).
- **Restrict `avendesora` user** to only necessary tools (via `sudoers`).

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
| MCP server not running    | Check `sudo systemctl status avendesora-node`      |
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
- [Wheel of Time Wiki: Avendesora](https://wot.fandom.com/wiki/Avendesora)

---

## **Changelog**


| Date       | Change                                   | Author        |
| ---------- | ---------------------------------------- | ------------- |
| 2026-05-30 | Initial version: Avendesora system setup | Jasper Frumau |


---

## **License**

This document is provided as-is for personal use. No warranty or liability is implied.

---

## **The Avendesora Philosophy**

> *"Like the Avendesora tree, this system stands as a beacon of resilience and wisdom. Its roots delve deep into the data of your networks, while its branches extend toward the future of cybersecurity. May it serve you as steadfastly as the tree served the Aiel."*

---

*"The Wheel weaves as the Wheel wills. With Avendesora, you weave with it."*