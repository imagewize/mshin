# Avendesora Setup Guide 🛠️

> *"The Way of the Leaf is not for all, but the Way of the Blade must be mastered. So too must you master the setup of Avendesora, that it may serve you as the Aiel serve the Dragon."*

This guide will walk you through setting up **Avendesora**, the **Wheel of Time-inspired cybersecurity AI system**. Follow the steps below to configure both the **Avendesora Core** (LLM inference server) and the **Avendesora Node** (Kali Linux + MCP server).

---

## 📋 **Prerequisites**

### **Hardware**


| Component           | Role                    | Minimum Requirements            | Recommended Model         |
| ------------------- | ----------------------- | ------------------------------- | ------------------------- |
| **Avendesora Core** | LLM Inference Server    | 32GB RAM, 1TB SSD, modern CPU   | GMKtec EVO-X2 (128GB RAM) |
| **Avendesora Node** | Kali Linux + MCP Server | 16GB RAM, 500GB SSD, x86_64 CPU | MINISFORUM UM790 Pro      |


### **Network**

- Both devices must be on the **same local network** (Ethernet recommended).
- Assign **static IPs** to both devices (see [Network Setup](#network-setup)).

### **Software Dependencies**

- **Avendesora Node:** Kali Linux (minimal install), Node.js v20+, Git
- **Avendesora Core:** Ubuntu/Debian, Ollama, Node.js v20+

---

## 🌍 **Network Setup**

### **1. Assign Static IPs**

To ensure both devices can always communicate, assign static IPs.

#### **On Avendesora Node (MINISFORUM):**

Edit `/etc/netplan/00-installer-config.yaml`:

```yaml
network:
  ethernet:
    enp1s0:
      dhcp4: no
      addresses: [192.168.1.100/24]
      gateway4: 192.168.1.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
  version: 2
```

Apply the changes:

```bash
sudo netplan apply
```

#### **On Avendesora Core (GMKtec EVO-X2):**

Edit `/etc/netplan/00-installer-config.yaml`:

```yaml
network:
  ethernet:
    enp1s0:
      dhcp4: no
      addresses: [192.168.1.200/24]
      gateway4: 192.168.1.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
  version: 2
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

## 🖥️ **Step 1: Set Up Avendesora Node (Kali Linux + MCP Server)**

### **1.1 Install Kali Linux**

1. Download the **Kali Linux minimal ISO** (no GUI):
  ```bash
   wget https://cdimage.kali.org/kali-2026.2/kali-linux-2026.2-installer-amd64.iso
  ```
2. Create a bootable USB drive (use **Rufus** or **Balena Etcher**).
3. Boot the MINISFORUM from the USB and install Kali Linux:
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
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify the installation:

```bash
node --version  # Should output v20.x.x
```

### **1.4 Set Up the MCP Server**

1. Clone the MCP servers repository:
  ```bash
   git clone https://github.com/modelcontextprotocol/servers.git
   cd servers/src/kali
  ```
2. Install dependencies:
  ```bash
   npm install
  ```
3. Test the MCP server manually:
  ```bash
   node index.js --tools nmap,metasploit,searchsploit,nikto,whois &
  ```
   This starts the server on `http://localhost:3000`.
4. Verify the server is running:
  ```bash
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -d '{"tool": "nmap", "args": ["-sV", "127.0.0.1"]}'
  ```
   You should see a JSON response with the Nmap scan results.

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
   WorkingDirectory=/home/avendesora/servers/src/kali
   ExecStart=/usr/bin/node index.js --tools nmap,metasploit,searchsploit,nikto,whois
   Restart=always
   Environment=NODE_ENV=production

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
avendesora ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/metasploit-framework/msfconsole, /usr/bin/nikto, /usr/bin/whois
```

---

## 🧠 **Step 2: Set Up Avendesora Core (LLM Inference Server)**

### **2.1 Install Ubuntu/Debian**

If your GMKtec EVO-X2 doesn’t already have Linux installed:

1. Download **Ubuntu 24.04 LTS** or **Debian 12**:
  ```bash
   wget https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso
  ```
2. Create a bootable USB and install Ubuntu/Debian.

### **2.2 Install Dependencies**

Update the system and install required packages:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nodejs
```

### **2.3 Install Ollama**

Ollama is the easiest way to run LLMs locally:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### **2.4 Pull the LLM Model**

Pull **Mistral 13B** (recommended for balance of performance and capability):

```bash
ollama pull mistral:13b
```

For **Mistral 70B** (requires more RAM):

```bash
ollama pull mistral:70b
```

### **2.5 Install the MCP Client**

```bash
npm install -g @modelcontextprotocol/client
```

### **2.6 Connect to Avendesora Node**

Run the MCP client, pointing it to the Avendesora Node’s MCP server:

```bash
mcp-client \
  --llm cmd:ollama \
  --llm-args mistral:13b \
  --mcp-server http://192.168.1.100:3000
```

Replace `192.168.1.100` with the **IP of your Avendesora Node**.

### **2.7 Test the Connection**

Once connected, test the system with a prompt:

```
"Avendesora, run an Nmap scan on 192.168.1.1 and analyze the results."
```

If everything is set up correctly, Avendesora should:

1. Call the `nmap` tool on the Avendesora Node.
2. Return the scan results.
3. Analyze the results and provide recommendations.

---

## 🔧 **Troubleshooting**

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
  cd /home/avendesora/servers/src/kali
  node index.js --tools nmap,metasploit,searchsploit,nikto,whois
  ```

### **Connection Refused to MCP Server**

- **Verify the IP and port:**
  ```bash
  curl http://192.168.1.100:3000
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

- **Verify the MCP client is connected:**
  ```bash
  mcp-client --llm cmd:ollama --llm-args mistral:13b --mcp-server http://192.168.1.100:3000
  ```
- **Check the MCP server logs for errors.**

---

## 🎯 **Next Steps**

Once Avendesora is set up, explore the following:

1. **Try the example workflows** in [docs/workflows.md](avendesora-workflows).
2. **Add more tools** to the MCP server (edit the `--tools` flag in the service file).
3. **Customize prompts** for your LLM (see [configs/ollama-modelfile](avendesora-ollama-modelfile)).

---

## 📚 **Additional Resources**

- [MCP Documentation](https://github.com/modelcontextprotocol/specification)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [Kali Linux Tools](https://www.kali.org/tools/)

---

*"The Flame of Tar Valon burns bright, but the light of Avendesora guides your path through the shadows of the Ways."*