#!/bin/bash
#
# Machin Shin Node Setup Script
#
# Description: Automates the setup of Kali Linux + the Machin Shin Kali MCP server.
#
# Usage: sudo bash setup_mcp_server.sh

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

       Setting up Machin Shin Node...

ART

# --- Check for Root ---

if [ "$(id -u)" -ne 0 ]; then
    echo "[ERROR] This script must be run as root. Use 'sudo'."
    exit 1
fi

# --- Configuration ---

MSHIN_DIR="/opt/mshin"
MSHIN_USER="mshin"
TOOLS_LIST="nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum,enum4linux,ffuf,john"
# Override to clone from somewhere else — an SSH URL, or a local path/bundle.
# Pass it through sudo with -E: MSHIN_REPO=... sudo -E bash "$0"
MSHIN_REPO="${MSHIN_REPO:-https://github.com/imagewize/mshin.git}"

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

# --- Install Node.js 20+ ---

echo "[+] Installing Node.js 20+..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
node --version
npm --version

# --- Clone / Refresh Machin Shin Repository ---

echo "[+] Installing Machin Shin Node code to ${MSHIN_DIR}..."
if [ -d "${MSHIN_DIR}/.git" ]; then
    cd "${MSHIN_DIR}"
    git pull
else
    # Clone into a staging directory first. Removing the destination up front
    # would destroy a working install whenever the clone fails.
    STAGE_DIR="$(mktemp -d)"
    export GIT_TERMINAL_PROMPT=0
    if ! git clone "${MSHIN_REPO}" "${STAGE_DIR}/mshin"; then
        rm -rf "${STAGE_DIR}"
        cat >&2 <<EOF
[ERROR] Could not clone ${MSHIN_REPO}

Point the script at a source this host can actually reach:

  # SSH, with a deploy key installed on this host
  MSHIN_REPO=git@github.com:imagewize/mshin.git sudo -E bash "\$0"

  # A copy you transferred yourself (rsync, scp, USB)
  MSHIN_REPO=/root/mshin sudo -E bash "\$0"
EOF
        exit 1
    fi
    rm -rf "${MSHIN_DIR}"
    mv "${STAGE_DIR}/mshin" "${MSHIN_DIR}"
    rm -rf "${STAGE_DIR}"
fi

# --- Install MCP Server Dependencies ---

echo "[+] Installing MCP server dependencies..."
cd "${MSHIN_DIR}/servers/src/kali"
npm install

# --- Set Up Machin Shin User ---

echo "[+] Creating '${MSHIN_USER}' user..."
if id "${MSHIN_USER}" &>/dev/null; then
    echo "[INFO] User '${MSHIN_USER}' already exists. Leaving its password unchanged."
    MSHIN_PASSWORD=""
else
    # Generate a random password (24 url-safe chars) for the 'mshin' user.
    MSHIN_PASSWORD="$(openssl rand -base64 18 | tr -d '\n')"
    useradd -m -s /bin/bash "${MSHIN_USER}"
    echo "${MSHIN_USER}:${MSHIN_PASSWORD}" | chpasswd
    usermod -aG sudo "${MSHIN_USER}"
fi

# --- Configure Sudoers for Machin Shin User ---

echo "[+] Configuring sudoers for '${MSHIN_USER}'..."
# tshark is intentionally omitted: reading user-owned PCAP files as root
# triggers Wireshark's file-owner check, and tshark needs no privileges to
# analyze existing captures.
cat > /etc/sudoers.d/mshin <<EOF
${MSHIN_USER} ALL=(ALL) NOPASSWD: /usr/bin/nmap, /usr/bin/searchsploit, /usr/bin/msfconsole, /usr/bin/nikto, /usr/bin/whois, /usr/bin/hydra, /usr/bin/sqlmap, /usr/bin/gobuster, /usr/bin/masscan, /usr/bin/dirb, /usr/bin/arping, /usr/bin/dnsenum, /usr/bin/enum4linux, /usr/bin/ffuf, /usr/bin/john
EOF
chmod 440 /etc/sudoers.d/mshin

# --- Set Up MCP Server as a Systemd Service ---

echo "[+] Setting up MCP server as a systemd service..."
cp "${MSHIN_DIR}/configs/mcp-kali.service" /etc/systemd/system/mshin-node.service

systemctl daemon-reload
systemctl enable mshin-node
systemctl start mshin-node

# --- Assign Static IP (Optional) ---

read -r -p "[?] Assign static IP to Machin Shin Node? (y/n): " assign_ip
if [ "$assign_ip" = "y" ]; then
    read -r -p "[?] Enter static IP (e.g., 192.168.1.100): " static_ip
    read -r -p "[?] Enter gateway (e.g., 192.168.1.1): " gateway

    # Detect a sensible default interface: the first non-loopback ethernet
    # device that is currently up. Fall back to enp1s0 if detection fails.
    default_iface="$(ip -4 -o link show up 2>/dev/null | awk -F': ' '/^[0-9]+: lo/ {next} {print $2; exit}')"
    default_iface="${default_iface:-enp1s0}"
    read -r -p "[?] Enter network interface (default: ${default_iface}): " iface
    iface="${iface:-${default_iface}}"

cat > /etc/netplan/00-mshin-node.yaml <<EOF
network:
  version: 2
  ethernets:
    ${iface}:
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
echo "[+] Static IP assigned: ${static_ip} on ${iface}"
fi

# --- Display Setup Summary ---

echo ""
echo "[+] Machin Shin Node setup complete!"
echo ""
echo "   MCP Server: Running on port 3000"
if [ -n "$MSHIN_PASSWORD" ]; then
    echo "   User: ${MSHIN_USER} (Password: ${MSHIN_PASSWORD})"
    echo "         ^ Record this now — it is not stored anywhere and won't be shown again."
else
    echo "   User: ${MSHIN_USER} (existing user; password unchanged)"
fi
echo "   Service: mshin-node (enabled and started)"
echo "   Tools: ${TOOLS_LIST}"
echo ""
echo "   To test the MCP server:"
echo "   curl http://localhost:3000/health"
echo ""
echo "   Next steps:"
echo "   1. Note the IP of this machine (Machin Shin Node)."
echo "   2. Set up Machin Shin Core with this IP."
echo ""
