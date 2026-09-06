#!/bin/bash
#
# Avendesora Node Setup Script
#
# Description: Automates the setup of Kali Linux + the Avendesora Kali MCP server.
#
# Usage: sudo bash setup_mcp_server.sh

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

       Setting up Avendesora Node...

ART

# --- Check for Root ---

if [ "$(id -u)" -ne 0 ]; then
    echo "[ERROR] This script must be run as root. Use 'sudo'."
    exit 1
fi

# --- Configuration ---

AVENDESORA_DIR="/opt/avendesora"
AVENDESORA_USER="avendesora"
TOOLS_LIST="nmap,metasploit,searchsploit,nikto,whois,tshark"
# Override to clone from somewhere else — an SSH URL, or a local path/bundle.
# Needed while the repository is private; the HTTPS default is correct once it
# is public. Pass it through sudo with -E: AVENDESORA_REPO=... sudo -E bash "$0"
AVENDESORA_REPO="${AVENDESORA_REPO:-https://github.com/imagewize/avendesora.git}"

# --- Install Dependencies ---

echo "[+] Installing dependencies..."
apt-get update && apt-get upgrade -y
apt-get install -y \
    curl \
    wget \
    git \
    openssl \
    nmap \
    metasploit-framework \
    exploitdb \
    nikto \
    whois \
    tshark \
    net-tools

# --- Install Node.js 20+ ---

echo "[+] Installing Node.js 20+..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
node --version
npm --version

# --- Clone / Refresh Avendesora Repository ---

echo "[+] Installing Avendesora Node code to ${AVENDESORA_DIR}..."
if [ -d "${AVENDESORA_DIR}/.git" ]; then
    cd "${AVENDESORA_DIR}"
    git pull
else
    # Clone into a staging directory first. Removing the destination up front
    # would destroy a working install whenever the clone fails.
    STAGE_DIR="$(mktemp -d)"
    export GIT_TERMINAL_PROMPT=0
    if ! git clone "${AVENDESORA_REPO}" "${STAGE_DIR}/avendesora"; then
        rm -rf "${STAGE_DIR}"
        cat >&2 <<EOF
[ERROR] Could not clone ${AVENDESORA_REPO}

The repository is private until v1.0, so an anonymous HTTPS clone fails with
"could not read Username for 'https://github.com'". Point the script at a
source this host can actually reach:

  # SSH, with a deploy key installed on this host
  AVENDESORA_REPO=git@github.com:imagewize/avendesora.git sudo -E bash "\$0"

  # A copy you transferred yourself (rsync, scp, USB)
  AVENDESORA_REPO=/root/avendesora sudo -E bash "\$0"
EOF
        exit 1
    fi
    rm -rf "${AVENDESORA_DIR}"
    mv "${STAGE_DIR}/avendesora" "${AVENDESORA_DIR}"
    rm -rf "${STAGE_DIR}"
fi

# --- Install MCP Server Dependencies ---

echo "[+] Installing MCP server dependencies..."
cd "${AVENDESORA_DIR}/servers/src/kali"
npm install

# --- Set Up Avendesora User ---

echo "[+] Creating '${AVENDESORA_USER}' user..."
if id "${AVENDESORA_USER}" &>/dev/null; then
    echo "[INFO] User '${AVENDESORA_USER}' already exists. Leaving its password unchanged."
    AVENDESORA_PASSWORD=""
else
    # Generate a random password (24 url-safe chars) for the 'avendesora' user.
    AVENDESORA_PASSWORD="$(openssl rand -base64 18 | tr -d '\n')"
    useradd -m -s /bin/bash "${AVENDESORA_USER}"
    echo "${AVENDESORA_USER}:${AVENDESORA_PASSWORD}" | chpasswd
    usermod -aG sudo "${AVENDESORA_USER}"
fi

# --- Configure Sudoers for Avendesora User ---

echo "[+] Configuring sudoers for '${AVENDESORA_USER}'..."
cat > /etc/sudoers.d/avendesora <<EOF
${AVENDESORA_USER} ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/tshark
EOF
chmod 440 /etc/sudoers.d/avendesora

# --- Set Up MCP Server as a Systemd Service ---

echo "[+] Setting up MCP server as a systemd service..."
cp "${AVENDESORA_DIR}/configs/mcp-kali.service" /etc/systemd/system/avendesora-node.service

systemctl daemon-reload
systemctl enable avendesora-node
systemctl start avendesora-node

# --- Assign Static IP (Optional) ---

read -r -p "[?] Assign static IP to Avendesora Node? (y/n): " assign_ip
if [ "$assign_ip" = "y" ]; then
    read -r -p "[?] Enter static IP (e.g., 192.168.1.100): " static_ip
    read -r -p "[?] Enter gateway (e.g., 192.168.1.1): " gateway

cat > /etc/netplan/00-avendesora-node.yaml <<EOF
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

netplan apply
echo "[+] Static IP assigned: ${static_ip}"
fi

# --- Display Setup Summary ---

echo ""
echo "[+] Avendesora Node setup complete!"
echo ""
echo "   MCP Server: Running on port 3000"
if [ -n "$AVENDESORA_PASSWORD" ]; then
    echo "   User: ${AVENDESORA_USER} (Password: ${AVENDESORA_PASSWORD})"
    echo "         ^ Record this now — it is not stored anywhere and won't be shown again."
else
    echo "   User: ${AVENDESORA_USER} (existing user; password unchanged)"
fi
echo "   Service: avendesora-node (enabled and started)"
echo "   Tools: ${TOOLS_LIST}"
echo ""
echo "   To test the MCP server:"
echo "   curl http://localhost:3000/health"
echo ""
echo "   Next steps:"
echo "   1. Note the IP of this machine (Avendesora Node)."
echo "   2. Set up Avendesora Core with this IP."
echo ""
