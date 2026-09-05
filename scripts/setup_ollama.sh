#!/bin/bash
#
# Avendesora Core Setup Script
#
# Description: Automates the setup of Ollama + the Avendesora CLI harness.
#
# Usage: bash setup_ollama.sh

set -e

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

# --- Configuration ---

AVENDESORA_DIR="/opt/avendesora"
DEFAULT_NODE_IP="192.168.1.100"

# --- Check for Root (recommended) ---

if [ "$(id -u)" -ne 0 ]; then
    echo "[WARNING] This script is recommended to be run as root. Continuing as current user."
fi

# --- Install Dependencies ---

echo "[+] Installing dependencies..."
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y \
    curl \
    git \
    net-tools

# --- Install Node.js 20+ ---

echo "[+] Installing Node.js 20+..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
node --version
npm --version

# --- Clone / Refresh Avendesora Repository ---

echo "[+] Installing Avendesora Core code to ${AVENDESORA_DIR}..."
if [ -d "${AVENDESORA_DIR}/.git" ]; then
    cd "${AVENDESORA_DIR}"
    sudo git pull
else
    sudo rm -rf "${AVENDESORA_DIR}"
    sudo git clone https://github.com/imagewize/avendesora.git "${AVENDESORA_DIR}"
fi

# --- Install Ollama ---

echo "[+] Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

# --- Pull Mistral Small 3 24B (Default) ---

echo "[+] Pulling Mistral Small 3 24B (Q4_K_M)..."
ollama pull mistral-small

# --- Create Avendesora Persona Model ---

echo "[+] Creating Avendesora Ollama model from Modelfile..."
ollama create avendesora -f "${AVENDESORA_DIR}/configs/ollama-modelfile"

# --- Optional: Pull Llama 3.3 70B ---

read -p "[?] Pull Llama 3.3 70B as well? (y/n): " pull_70b
if [ "$pull_70b" = "y" ]; then
    echo "[+] Pulling Llama 3.3 70B (Q4_K_M)..."
    ollama pull llama3.3:70b
fi

# --- Install Avendesora CLI Client ---

echo "[+] Installing Avendesora CLI client..."
cd "${AVENDESORA_DIR}/clients/avendesora-cli"
sudo npm install

# --- Assign Static IP (Optional) ---

read -p "[?] Assign static IP to Avendesora Core? (y/n): " assign_ip
if [ "$assign_ip" = "y" ]; then
    read -p "[?] Enter static IP (e.g., 192.168.1.200): " static_ip
    read -p "[?] Enter gateway (e.g., 192.168.1.1): " gateway

sudo tee /etc/netplan/00-avendesora-core.yaml <<EOF
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: no
      addresses:
        - ${static_ip}/24
      routes:
        - to: default
          via: ${gateway}
      nameservers:
        addresses:
          - 8.8.8.8
          - 8.8.4.4
EOF

sudo netplan apply
echo "[+] Static IP assigned: ${static_ip}"
fi

# --- Create a Wrapper Script for Avendesora ---

sudo tee /usr/local/bin/avendesora <<'EOF'
#!/bin/bash
#
# Avendesora Core Wrapper Script
#
# Usage:
#   avendesora [NODE_IP_OR_URL]
#   avendesora --node http://192.168.1.100:3000 --model avendesora

NODE_URL=""
MODEL="avendesora"
POSITIONAL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --node)
            NODE_URL="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: avendesora [NODE_IP_OR_URL] [--node URL] [--model MODEL]"
            exit 0
            ;;
        --*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            if [ -z "$POSITIONAL" ]; then
                POSITIONAL="$1"
            fi
            shift
            ;;
    esac
done

if [ -z "$NODE_URL" ]; then
    NODE_ARG="${POSITIONAL:-192.168.1.100}"
    if [[ "$NODE_ARG" == http* ]]; then
        NODE_URL="$NODE_ARG"
    else
        NODE_URL="http://${NODE_ARG}:3000"
    fi
fi

echo "Starting Avendesora Core..."
echo "Connecting to Avendesora Node at ${NODE_URL}..."
echo ""

exec /opt/avendesora/clients/avendesora-cli/index.js --node "${NODE_URL}" --model "${MODEL}"
EOF

sudo chmod +x /usr/local/bin/avendesora
if [ ! -e /usr/bin/avendesora ]; then
    sudo ln -s /usr/local/bin/avendesora /usr/bin/avendesora
fi

# --- Display Setup Summary ---

echo ""
echo "[+] Avendesora Core setup complete!"
echo ""
echo "   Ollama: Installed"
echo "   Models: mistral-small, avendesora (custom persona)"
if [ "$pull_70b" = "y" ]; then
    echo "          llama3.3:70b"
fi
echo "   CLI Client: Installed at /opt/avendesora/clients/avendesora-cli"
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
