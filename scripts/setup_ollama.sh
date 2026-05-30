#!/bin/bash

# Avendesora Core Setup Script
#
# Description: Automates the setup of Ollama + Mistral LLM on the GMKtec EVO-X2.
#
# Usage: bash setup_ollama.sh

set -e  # Exit on error

# --- Avendesora ASCII Art ---

cat <<'ART'

       \ | /
     \  \|/  /
   '-.\\\|///.-'
  '--._\\|//_.--'
      \\\|///
        \|/
         |
         |

       Setting up Avendesora Core...

ART

# --- Check for Root ---

if [ "$(id -u)" -ne 0 ]; then
    echo "[WARNING] This script is recommended to be run as root. Continuing as current user."
fi

# --- Install Dependencies ---

echo "[+] Installing dependencies..."
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y \
    curl \
    git \
    nodejs \
    net-tools

# --- Install Ollama ---

echo "[+] Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

# --- Pull Mistral 13B (Default) ---

echo "[+] Pulling Mistral 13B (Q4_K_M)..."
ollama pull mistral:13b

# --- Optional: Pull Mistral 70B ---

read -p "[?] Pull Mistral 70B as well? (y/n): " pull_70b
if [ "$pull_70b" = "y" ]; then
    echo "[+] Pulling Mistral 70B (Q4_K_M)..."
    ollama pull mistral:70b
fi

# --- Install MCP Client ---

echo "[+] Installing MCP client..."
npm install -g @modelcontextprotocol/client

# --- Assign Static IP (Optional) ---

read -p "[?] Assign static IP to Avendesora Core? (y/n): " assign_ip
if [ "$assign_ip" = "y" ]; then
    read -p "[?] Enter static IP (e.g., 192.168.1.200): " static_ip
    read -p "[?] Enter gateway (e.g., 192.168.1.1): " gateway

cat > /etc/netplan/00-avendesora-core.yaml <<EOF
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

sudo netplan apply
echo "[+] Static IP assigned: $static_ip"

fi

# --- Create a Wrapper Script for Avendesora ---

cat > /usr/local/bin/avendesora <<'EOF'
#!/bin/bash

# Avendesora Core Wrapper Script
#
# Usage: avendesora [AVENDESORA_NODE_IP]

NODE_IP=${1:-192.168.1.100}  # Default IP for Avendesora Node

echo "Starting Avendesora Core..."
echo "Connecting to Avendesora Node at $NODE_IP..."
echo ""

mcp-client \
  --llm cmd:ollama \
  --llm-args mistral:13b \
  --mcp-server http://$NODE_IP:3000
EOF

chmod +x /usr/local/bin/avendesora
sudo ln -s /usr/local/bin/avendesora /usr/bin/avendesora

# --- Display Setup Summary ---

echo ""
echo "[+] Avendesora Core setup complete!"
echo ""
echo "   Ollama: Installed"
echo "   Models: mistral:13b"
if [ "$pull_70b" = "y" ]; then
    echo "          mistral:70b"
fi
echo "   MCP Client: Installed"
echo ""
echo "   To start Avendesora:"
echo "   avendesora [AVENDESORA_NODE_IP]"
echo ""
echo "   Example:"
echo "   avendesora 192.168.1.100"
echo ""
echo "   Then enter prompts like:"
echo "   Avendesora, run an Nmap scan on 192.168.1.1."
echo ""
