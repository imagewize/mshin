#!/bin/bash

# Avendesora Node Setup Script
#
# Description: Automates the setup of Kali Linux + MCP Server on the MINISFORUM mini PC.
#
# Usage: sudo bash setup_mcp_server.sh

set -e  # Exit on error

# --- Avendesora ASCII Art ---

cat <<'ART'

        .-.
      .' | '.
     /   |   \
    |   /|\   |
    |  / | \  |
    |    |    |
     \   |   /
      '. | .'
        '|'
         |
         |

       Setting up Avendesora Node...

ART

# --- Check for Root ---

if [ "$(id -u)" -ne 0 ]; then
    echo "[ERROR] This script must be run as root. Use 'sudo'."
    exit 1
fi

# --- Install Dependencies ---

echo "[+] Installing dependencies..."
apt-get update && apt-get upgrade -y
apt-get install -y \
    curl \
    wget \
    git \
    openssl \
    nodejs \
    nmap \
    metasploit-framework \
    searchsploit \
    nikto \
    whois \
    tshark \
    net-tools

# --- Clone MCP Servers Repository ---

echo "[+] Cloning MCP servers repository..."
if [ ! -d "/opt/avendesora" ]; then
    mkdir -p /opt/avendesora
fi
cd /opt/avendesora
git clone https://github.com/modelcontextprotocol/servers.git

# --- Set Up Avendesora User ---

echo "[+] Creating 'avendesora' user..."
if id "avendesora" &>/dev/null; then
    echo "[INFO] User 'avendesora' already exists. Leaving its password unchanged."
    AVENDESORA_PASSWORD=""
else
    # Generate a random password (24 url-safe chars) for the 'avendesora' user.
    AVENDESORA_PASSWORD="$(openssl rand -base64 18 | tr -d '\n')"
    useradd -m -s /bin/bash avendesora
    echo "avendesora:${AVENDESORA_PASSWORD}" | chpasswd
    usermod -aG sudo avendesora
fi

# --- Configure Sudoers for Avendesora User ---

echo "[+] Configuring sudoers for 'avendesora'..."
cat > /etc/sudoers.d/avendesora <<EOF
avendesora ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/metasploit-framework/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/tshark
EOF
chmod 440 /etc/sudoers.d/avendesora

# --- Set Up MCP Server as a Systemd Service ---

echo "[+] Setting up MCP server as a systemd service..."
cat > /etc/systemd/system/avendesora-node.service <<EOF
[Unit]
Description=Avendesora Node: MCP Server for Kali Tools
After=network.target

[Service]
User=avendesora
WorkingDirectory=/opt/avendesora/servers/src/kali
ExecStart=/usr/bin/node index.js --tools nmap,metasploit,searchsploit,nikto,whois,tshark
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable avendesora-node
systemctl start avendesora-node

# --- Assign Static IP (Optional) ---

read -p "[?] Assign static IP to Avendesora Node? (y/n): " assign_ip
if [ "$assign_ip" = "y" ]; then
    read -p "[?] Enter static IP (e.g., 192.168.1.100): " static_ip
    read -p "[?] Enter gateway (e.g., 192.168.1.1): " gateway

cat > /etc/netplan/00-avendesora-node.yaml <<EOF
network:
  version: 2
  ethernet:
    enp1s0:
      dhcp4: no
      addresses: [$static_ip/24]
      gateway4: $gateway
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
EOF

netplan apply
echo "[+] Static IP assigned: $static_ip"

fi

# --- Display Setup Summary ---

echo ""
echo "[+] Avendesora Node setup complete!"
echo ""
echo "   MCP Server: Running on port 3000"
if [ -n "$AVENDESORA_PASSWORD" ]; then
    echo "   User: avendesora (Password: $AVENDESORA_PASSWORD)"
    echo "         ^ Record this now — it is not stored anywhere and won't be shown again."
else
    echo "   User: avendesora (existing user; password unchanged)"
fi
echo "   Service: avendesora-node (enabled and started)"
echo "   Tools: nmap, metasploit, searchsploit, nikto, whois, tshark"
echo ""
echo "   To test the MCP server:"
echo "   curl -X POST http://localhost:3000/mcp \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"tool\": \"nmap\", \"args\": [\"-sV\", \"127.0.0.1\"]}'"
echo ""
echo "   Next steps:"
echo "   1. Note the IP of this machine (Avendesora Node)."
echo "   2. Set up Avendesora Core (GMKtec EVO-X2) with this IP."
echo ""
