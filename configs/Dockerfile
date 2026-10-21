# Machin Shin Node — the MCP server and its Kali tools, sandboxed in a container.
#
# Build from the repo root (configs/compose.yaml does this):
#   docker compose -f configs/compose.yaml build
#
# This image is only the "what runs" half of the sandbox. The "what it may
# touch" half — host networking for raw sockets, the capability drop, the
# read-only rootfs, resource limits — lives in configs/compose.yaml, because a
# Dockerfile cannot set any of that.
#
# kalilinux/kali-rolling is a moving tag (Kali has no versioned releases). Pin
# by digest for a reproducible build: `docker pull kalilinux/kali-rolling` and
# copy the digest into the FROM line.

FROM kalilinux/kali-rolling

# One tool list to keep in sync. It is the image-side counterpart of TOOL_PATHS
# in servers/src/kali/config.js, and the counterpart of the --tools flag in
# configs/mcp-kali.service. See the tool-list invariant in AGENTS.md: under
# Docker, the setup script's apt list *and* its sudoers allowlist both
# collapse into this one list — the container needs no sudo at all, so the
# "entry people forget" no longer exists.
ARG KALI_TOOLS="nmap metasploit-framework exploitdb nikto whois tshark hydra sqlmap gobuster masscan dirb arping dnsenum enum4linux ffuf john"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssl net-tools nodejs npm ${KALI_TOOLS} \
    && rm -rf /var/lib/apt/lists/*

# Kali ships nmap's real binary (/usr/lib/nmap/nmap) with file capabilities
# (cap_net_bind_service,cap_net_admin,cap_net_raw=eip). no-new-privileges
# (compose.yaml) makes any privilege-gaining exec fail with EPERM — verified:
# the first nmap tool call died with "Operation not permitted" until this line
# existed. The container grants NET_RAW/NET_ADMIN process-wide, so the file
# capabilities are redundant inside the jail. Stripping them is safe for the
# same reason: getcap -r / over the whole image finds capabilities on this one
# file only.
RUN setcap -r /usr/lib/nmap/nmap

# tools.js runs each binary through `sudo -n` when the server process is not
# root. Here the server runs as root *inside* the container, so that branch
# never fires, no sudoers allowlist is needed, and the exceptions for tshark,
# dirb and ffuf are moot: one user, one jail. What constrains the tools
# instead is the capability set and the read-only rootfs set in compose.yaml.

WORKDIR /opt/mshin/servers/src/kali

# Dependencies first, so a code-only change does not re-run npm install.
# The build context is the repo root; .dockerignore keeps the host's
# node_modules out (wrong platform, stale deps).
COPY servers/src/kali/package.json servers/src/kali/package-lock.json ./
RUN npm install --omit=dev

COPY servers/src/kali/ ./

# Everything the tools write at runtime lands in $HOME: msfconsole's first-run
# init, sqlmap's output, ffuf's config, dirb's resume dumps, john's pot files.
# The rootfs is read-only (compose.yaml), so point HOME at the /tmp tmpfs
# instead of /root. The cost: msfconsole's one-time init runs once per
# container start, not once per image build — first metasploit call after a
# restart is slower, same trade the Lima provisioner makes when it pre-warms
# /root/.msf4 that a tmpfs would mask.
ENV HOME=/tmp

# Keep this identical to the --tools flag in configs/mcp-kali.service.
CMD ["node", "index.js", "--tools", "nmap,metasploit,searchsploit,nikto,whois,tshark,hydra,sqlmap,gobuster,masscan,dirb,arping,dnsenum,enum4linux,ffuf,john"]
