#!/bin/bash
#
# Machin Shin Core Setup Script
#
# Description: Automates the setup of Ollama + the Machin Shin CLI harness.
#
# Usage: bash setup_ollama.sh

set -e

# --- Machin Shin ASCII Art ---

cat <<'ART'

       \ | /
     \  \|/  /
   '-.\\\|///.-'
  '--._\\|//_.--'
      \\\|///
        \|/
         |
         |

       Setting up Machin Shin Core...

ART

# --- Configuration ---

MSHIN_DIR="/opt/mshin"
# Override to clone from somewhere else — an SSH URL, or a local path/bundle.
# Needed while the repository is private; the HTTPS default is correct once it
# is public.
MSHIN_REPO="${MSHIN_REPO:-https://github.com/imagewize/mshin.git}"

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

# --- Clone / Refresh Machin Shin Repository ---

echo "[+] Installing Machin Shin Core code to ${MSHIN_DIR}..."
if [ -d "${MSHIN_DIR}/.git" ]; then
    cd "${MSHIN_DIR}"
    sudo git pull
else
    # Clone into a staging directory first. Removing the destination up front
    # would destroy a working install whenever the clone fails.
    STAGE_DIR="$(mktemp -d)"
    if ! GIT_TERMINAL_PROMPT=0 git clone "${MSHIN_REPO}" "${STAGE_DIR}/mshin"; then
        rm -rf "${STAGE_DIR}"
        cat >&2 <<EOF
[ERROR] Could not clone ${MSHIN_REPO}

The repository is private until v1.0, so an anonymous HTTPS clone fails with
"could not read Username for 'https://github.com'". Point the script at a
source this host can actually reach:

  # SSH, with your key loaded in an agent
  MSHIN_REPO=git@github.com:imagewize/mshin.git bash "\$0"

  # A copy you transferred yourself (rsync, scp, USB)
  MSHIN_REPO=\$HOME/mshin bash "\$0"
EOF
        exit 1
    fi
    sudo rm -rf "${MSHIN_DIR}"
    sudo mv "${STAGE_DIR}/mshin" "${MSHIN_DIR}"
    rm -rf "${STAGE_DIR}"
fi

# --- Install Ollama ---

echo "[+] Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

# --- Pull Mistral Small 3 24B (Default) ---

echo "[+] Pulling Mistral Small 3 24B (Q4_K_M)..."
ollama pull mistral-small

# --- Create Machin Shin Persona Model ---

echo "[+] Creating Machin Shin Ollama model from Modelfile..."
ollama create mshin -f "${MSHIN_DIR}/configs/ollama-modelfile"

# --- Optional: Pull Llama 3.3 70B ---

read -r -p "[?] Pull Llama 3.3 70B as well? (y/n): " pull_70b
if [ "$pull_70b" = "y" ]; then
    echo "[+] Pulling Llama 3.3 70B (Q4_K_M)..."
    ollama pull llama3.3:70b
fi

# --- Install Machin Shin CLI Client ---

echo "[+] Installing Machin Shin CLI client..."
cd "${MSHIN_DIR}/clients/mshin-cli"
sudo npm install

# --- Assign Static IP (Optional) ---

read -r -p "[?] Assign static IP to Machin Shin Core? (y/n): " assign_ip
if [ "$assign_ip" = "y" ]; then
    read -r -p "[?] Enter static IP (e.g., 192.168.1.200): " static_ip
    read -r -p "[?] Enter gateway (e.g., 192.168.1.1): " gateway

sudo tee /etc/netplan/00-mshin-core.yaml <<EOF
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

# --- Create a Wrapper Script for Machin Shin ---

sudo tee /usr/local/bin/mshin <<'EOF'
#!/bin/bash
#
# Machin Shin Core Wrapper Script
#
# Usage:
#   mshin [NODE_IP_OR_URL]
#   mshin --node http://192.168.1.100:3000 --model mshin

NODE_URL=""
MODEL="mshin"
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
            echo "Usage: mshin [NODE_IP_OR_URL] [--node URL] [--model MODEL]"
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

echo "Starting Machin Shin Core..."
echo "Connecting to Machin Shin Node at ${NODE_URL}..."
echo ""

exec /opt/mshin/clients/mshin-cli/index.js --node "${NODE_URL}" --model "${MODEL}"
EOF

sudo chmod +x /usr/local/bin/mshin
if [ ! -e /usr/bin/mshin ]; then
    sudo ln -s /usr/local/bin/mshin /usr/bin/mshin
fi

# --- Display Setup Summary ---

echo ""
echo "[+] Machin Shin Core setup complete!"
echo ""
echo "   Ollama: Installed"
echo "   Models: mistral-small, mshin (custom persona)"
if [ "$pull_70b" = "y" ]; then
    echo "          llama3.3:70b"
fi
echo "   CLI Client: Installed at /opt/mshin/clients/mshin-cli"
echo ""
echo "   To start Machin Shin:"
echo "   mshin [MSHIN_NODE_IP]"
echo ""
echo "   Example:"
echo "   mshin 192.168.1.100"
echo ""
echo "   Then enter prompts like:"
echo "   Machin Shin, run an Nmap scan on 192.168.1.1."
echo ""
