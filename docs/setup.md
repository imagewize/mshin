# Avendesora Setup Guide

> *"The Way of the Leaf is not for all, but the Way of the Blade must be mastered. So too must you master the setup of Avendesora, that it may serve you as the Aiel serve the Dragon."*

This guide will walk you through setting up **Avendesora**, the **Wheel of Time-inspired cybersecurity AI system**. Follow the steps below to configure both the **Avendesora Core** (LLM inference server) and the **Avendesora Node** (Kali Linux + MCP server).

---

## **Prerequisites**

### **Hardware**


| Component           | Role                    | Minimum (start here)            | Optional ceiling                    |
| ------------------- | ----------------------- | ------------------------------- | ----------------------------------- |
| **Avendesora Core** | LLM Inference Server    | 32GB RAM, ~50GB free disk, modern CPU | 128GB unified-memory APU (e.g. GMKtec EVO-X3) |
| **Avendesora Node** | Kali Linux + MCP Server | 16GB RAM, 500GB SSD, x86_64 CPU | Any x86_64 mini PC / SFF            |

The 32GB minimum is a real minimum, not a polite one — it runs the default
`mistral-small` (24B) model and every workflow in this guide. **Use a machine you
already own before buying anything.** More RAM buys larger models, not faster ones;
[Sizing the Core](architecture.md#sizing-the-core) explains the trade-off and when the
128GB box is actually worth it.


### **Network**

- Both devices must be on the **same local network** (Ethernet recommended).
- Assign **static IPs** to both devices (see [Network Setup](#network-setup)).

### **Software Dependencies**

- **Avendesora Node:** Kali Linux (minimal install), Node.js v20+, Git
- **Avendesora Core:** Ubuntu/Debian, Ollama, Node.js v20+

---

## **Network Setup**

### **1. Assign Static IPs**

To ensure both devices can always communicate, assign static IPs.

#### **On Avendesora Node:**

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

Apply the changes:

```bash
sudo netplan apply
```

#### **On Avendesora Core:**

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

Apply the changes:

```bash
sudo netplan apply
```

### **2. Verify Connectivity**

From **Avendesora Core**, test the connection to **Avendesora Node**:

```bash
ping 192.168.1.100
```

If successful, you should see responses like:

```
64 bytes from 192.168.1.100: icmp_seq=1 ttl=64 time=0.456 ms
```

---

## **Step 1: Set Up Avendesora Node (Kali Linux + MCP Server)**

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

### **1.3 Install Node.js**

The MCP server requires Node.js v20+:

```bash
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi
node --version  # Should output v20.x.x
```

### **1.4 Set Up the MCP Server**

Avendesora ships its own Kali MCP server at `servers/src/kali`.

1. Change to the server directory (adjust the path if you did not use `/opt/avendesora`):
  ```bash
   cd /opt/avendesora/servers/src/kali
  ```
2. Install dependencies:
  ```bash
   npm install
  ```
3. Test the MCP server manually:
  ```bash
   node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark &
  ```
   This starts the server on `http://localhost:3000`.
4. Verify the server is running:
  ```bash
   curl http://localhost:3000/health
  ```
   You should see a JSON response listing the enabled tools.

### **1.5 Create a Dedicated User for Avendesora**

For security, create a dedicated user (`avendesora`) to run the MCP server:

```bash
sudo adduser avendesora
sudo usermod -aG sudo avendesora
```

### **1.6 Set Up SSH Access (Optional but Recommended)**

1. Switch to the `avendesora` user:
  ```bash
   su - avendesora
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

### **1.7 Create a `systemd` Service for the MCP Server**

To ensure the MCP server starts automatically on boot:

1. Create a service file:
  ```bash
   sudo nano /etc/systemd/system/avendesora-node.service
  ```
2. Add the following configuration:
  ```ini
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
3. Enable and start the service:
  ```bash
   sudo systemctl enable avendesora-node
   sudo systemctl start avendesora-node
   sudo systemctl status avendesora-node  # Verify it's running
  ```
4. Check the logs if there are issues:
  ```bash
   sudo journalctl -u avendesora-node -f
  ```

### **1.8 Restrict `avendesora` User Permissions**

To limit the `avendesora` user to only necessary tools, edit the sudoers file:

```bash
sudo visudo
```

Add the following line:

```
avendesora ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/tshark
```

---

## **Step 2: Set Up Avendesora Core (LLM Inference Server)**

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
[Sizing the Core](architecture.md#sizing-the-core)) — they are not required:

```bash
ollama pull qwen3:32b      # ~20GB, needs ~48GB+ RAM
ollama pull llama3.3:70b   # ~40GB, needs ~64GB+ RAM
ollama pull gpt-oss:120b   # ~65GB, needs 128GB — fastest of the three (MoE)
```

### **2.5 Create the Avendesora Persona Model**

```bash
ollama create avendesora -f /opt/avendesora/configs/ollama-modelfile
```

### **2.6 Install the Avendesora CLI Client**

```bash
cd /opt/avendesora/clients/avendesora-cli
npm install
```

### **2.7 Connect to Avendesora Node**

Run the client, pointing it to the Avendesora Node’s MCP server:

```bash
# Wrapper installed by setup_ollama.sh:
avendesora 192.168.1.100

# Or directly:
/opt/avendesora/clients/avendesora-cli/index.js --node http://192.168.1.100:3000 --model avendesora
```

Replace `192.168.1.100` with the **IP of your Avendesora Node**.

### **2.8 Test the Connection**

Once connected, test the system with a prompt:

```
"Avendesora, run an Nmap scan on 192.168.1.1 and analyze the results."
```

If everything is set up correctly, Avendesora should:

1. Call the `nmap` tool on the Avendesora Node.
2. Return the scan results.
3. Analyze the results and provide recommendations.

---

## **Troubleshooting**

### **MCP Server Not Running**

- **Check the service status:**
  ```bash
  sudo systemctl status avendesora-node
  ```
- **Check the logs:**
  ```bash
  sudo journalctl -u avendesora-node -f
  ```
- **Manual start:**
  ```bash
  cd /opt/avendesora/servers/src/kali
  node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark
  ```

### **Connection Refused to MCP Server**

- **Verify the IP and port:**
  ```bash
  curl http://192.168.1.100:3000/health
  ```
- **Check firewall rules:**
  ```bash
  sudo ufw status  # On Avendesora Node
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
  /opt/avendesora/clients/avendesora-cli/index.js --node http://192.168.1.100:3000 --model avendesora
  ```
- **Check the MCP server logs for errors.**

---

## **Next Steps**

Once Avendesora is set up, explore the following:

1. **Try the example workflows** in [docs/workflows.md](avendesora-workflows).
2. **Add more tools** to the MCP server (edit the `--tools` flag in the service file).
3. **Customize prompts** for your LLM (see [configs/ollama-modelfile](avendesora-ollama-modelfile)).

---

## **Additional Resources**

- [MCP Documentation](https://github.com/modelcontextprotocol/specification)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Kali Linux Tools](https://www.kali.org/tools/)

---

*"The Flame of Tar Valon burns bright, but the light of Avendesora guides your path through the shadows of the Ways."*