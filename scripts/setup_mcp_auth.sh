#!/bin/bash
#
# Machin Shin — MCP authentication setup
#
# Description: generate a single bearer token and write it to every place the
# Node and its clients expect it. This stops the "authentication keeps failing"
# dance that happens when Docker, Vibe and OpenCode end up with different
# tokens, or when OpenCode is left in OAuth mode for a server that uses a
# static bearer token.
#
# Usage:
#   scripts/setup_mcp_auth.sh              # generate a new token everywhere
#   scripts/setup_mcp_auth.sh --check      # verify existing tokens match
#   scripts/setup_mcp_auth.sh --token T    # use the token you already have
#   scripts/setup_mcp_auth.sh --url U      # Node URL for OpenCode (default
#                                          # http://localhost:3001/mcp, or
#                                          # $MSHIN_NODE_URL)
#
# The script writes:
#   - configs/mshin-node.env                (Docker Node)
#   - ~/.vibe/.env                          (Mistral Vibe)
#   - ~/.config/opencode/.env               (OpenCode, optional)
#   - ~/.config/opencode/opencode.jsonc     (OpenCode MCP server config)
# and prints the shell exports and restart command OpenCode needs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_ENV="${REPO_ROOT}/configs/mshin-node.env"
VIBE_ENV="${HOME}/.vibe/.env"
OPENCODE_ENV="${HOME}/.config/opencode/.env"

MODE="setup"
PROVIDED_TOKEN=""
NODE_URL="${MSHIN_NODE_URL:-http://localhost:3001/mcp}"
WRITE_OPENCODE_ENV="${WRITE_OPENCODE_ENV:-yes}"

mask_token() {
    local token="$1"
    if [ -z "$token" ]; then
        echo "<not set>"
    elif [ "${#token}" -le 8 ]; then
        echo "****"
    else
        echo "${token:0:4}...${token: -4}"
    fi
}

token_from_file() {
    local file="$1"
    local key="$2"
    if [ -f "$file" ]; then
        grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2- || true
    fi
}

update_env_file() {
    local file="$1"
    local key="$2"
    local value="$3"
    local comment="${4:-}"

    mkdir -p "$(dirname "$file")"
    chmod 700 "$(dirname "$file")" 2>/dev/null || true

    local tmp
    tmp="$(mktemp)"
    if [ -f "$file" ]; then
        grep -vE "^${key}=" "$file" > "$tmp" || true
    fi
    if [ -n "$comment" ]; then
        printf '# %s\n' "$comment" >> "$tmp"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
    mv "$tmp" "$file"
    chmod 600 "$file"
}

patch_opencode_config() {
    local token="$1"
    local node_url="$2"
    local config_file="${HOME}/.config/opencode/opencode.jsonc"

    mkdir -p "$(dirname "$config_file")"
    chmod 700 "$(dirname "$config_file")" 2>/dev/null || true

    python3 - "$config_file" "$token" "$node_url" <<'PYEOF'
import json, os, re, sys

config_file = sys.argv[1]
token = sys.argv[2]
node_url = sys.argv[3]

data = {}
if os.path.exists(config_file):
    with open(config_file, 'r') as f:
        text = f.read()
    # Strip // and /* */ comments so JSONC becomes parseable JSON.
    # The lookbehind keeps // inside URLs (e.g. https://...) intact.
    text = re.sub(r'(?<!\S)//.*', '', text)
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"[WARN] Could not parse {config_file}: {e}", file=sys.stderr)
        print("[WARN] Leaving OpenCode config unchanged; update it manually.", file=sys.stderr)
        sys.exit(0)

mcp = data.setdefault('mcp', {})
servers = mcp.setdefault('servers', {})
servers['mshin'] = {
    'type': 'remote',
    'url': node_url,
    'oauth': False,
    'headers': {
        'Authorization': f'Bearer {token}'
    }
}

with open(config_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
os.chmod(config_file, 0o600)
PYEOF
}

print_config_snippets() {
    local token="$1"

    echo
    echo "=== Docker / Linux Node ==="
    echo "Token written to: ${DOCKER_ENV}"
    echo "Restart the container to pick it up:"
    echo "  docker compose -f configs/compose.yaml -f configs/compose.local.yaml up -d --force-recreate"
    echo

    echo "=== Mistral Vibe ==="
    echo "Token written to: ${VIBE_ENV}"
    echo "Vibe reads MSHIN_NODE_TOKEN from ~/.vibe/.env on startup."
    echo "Restart Vibe if it is already running."
    echo

    echo "=== OpenCode ==="
    if [ -f "$OPENCODE_ENV" ]; then
        echo "Token written to: ${OPENCODE_ENV}"
    fi
    echo "Patched: ${HOME}/.config/opencode/opencode.jsonc"
    echo "OpenCode's documented {env:...} interpolation in remote MCP headers is"
    echo "currently broken (anomalyco/opencode#23664), so the bearer token is written"
    echo "literally into opencode.jsonc. Restart the service to pick it up:"
    echo "  opencode service restart"
    echo
    echo "Make sure your opencode.jsonc has:"
    cat <<EOF
  "mshin": {
    "type": "remote",
    "url": "${NODE_URL}",
    "oauth": false,
    "headers": {
      "Authorization": "Bearer ${token}"
    }
  }
EOF
    echo

    echo "=== Lima / bare-metal Node ==="
    echo "If the Node runs under systemd, add a drop-in:"
    echo "  sudo systemctl edit mshin-node"
    echo "  [Service]"
    echo "  Environment=MSHIN_NODE_TOKEN=${token}"
    echo "  Environment=MSHIN_ALLOWED_TARGETS=<scope>"
    echo "  sudo systemctl restart mshin-node"
    echo
}

check_tokens() {
    local docker_token=""
    local vibe_token=""
    local opencode_token=""
    local shell_token="${MSHIN_NODE_TOKEN:-}"

    docker_token="$(token_from_file "$DOCKER_ENV" MSHIN_NODE_TOKEN)"
    vibe_token="$(token_from_file "$VIBE_ENV" MSHIN_NODE_TOKEN)"
    opencode_token="$(token_from_file "$OPENCODE_ENV" MSHIN_NODE_TOKEN)"

    echo "Token sources (masked):"
    echo "  Docker env file:  $(mask_token "$docker_token")"
    echo "  Vibe env file:    $(mask_token "$vibe_token")"
    echo "  OpenCode env file:$(mask_token "$opencode_token")"
    echo "  Shell env:        $(mask_token "$shell_token")"

    local all="${docker_token}${vibe_token}${opencode_token}${shell_token}"
    if [ -z "$all" ]; then
        echo
        echo "[ERROR] No MSHIN_NODE_TOKEN found anywhere. Run without --check to create one." >&2
        exit 1
    fi

    local mismatches=0
    if [ -n "$docker_token" ] && [ -n "$vibe_token" ] && [ "$docker_token" != "$vibe_token" ]; then
        echo "  MISMATCH: Docker token != Vibe token" >&2
        mismatches=$((mismatches + 1))
    fi
    if [ -n "$docker_token" ] && [ -n "$opencode_token" ] && [ "$docker_token" != "$opencode_token" ]; then
        echo "  MISMATCH: Docker token != OpenCode env-file token" >&2
        mismatches=$((mismatches + 1))
    fi
    if [ -n "$docker_token" ] && [ -n "$shell_token" ] && [ "$docker_token" != "$shell_token" ]; then
        echo "  MISMATCH: Docker token != current shell MSHIN_NODE_TOKEN" >&2
        mismatches=$((mismatches + 1))
    fi

    if [ "$mismatches" -eq 0 ]; then
        echo
        echo "[OK] All visible tokens match."
        return 0
    fi
    echo
    echo "[ERROR] ${mismatches} mismatch(es) found. Re-run without --check to synchronize." >&2
    return 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check)
            MODE="check"
            shift
            ;;
        --token)
            PROVIDED_TOKEN="$2"
            shift 2
            ;;
        --url)
            NODE_URL="$2"
            shift 2
            ;;
        --help|-h)
            sed -n '2,18p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

if [ "$MODE" == "check" ]; then
    check_tokens
    exit $?
fi

if [ -n "$PROVIDED_TOKEN" ]; then
    TOKEN="$PROVIDED_TOKEN"
else
    if command -v openssl >/dev/null 2>&1; then
        TOKEN="$(openssl rand -hex 32)"
    else
        TOKEN="$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)"
    fi
fi

update_env_file "$DOCKER_ENV" MSHIN_NODE_TOKEN "$TOKEN" "Machin Shin Node bearer token — keep this out of git"
update_env_file "$VIBE_ENV" MSHIN_NODE_TOKEN "$TOKEN" "Machin Shin Node bearer token for Vibe"

if [ "$WRITE_OPENCODE_ENV" != "no" ]; then
    update_env_file "$OPENCODE_ENV" MSHIN_NODE_TOKEN "$TOKEN" "Machin Shin Node bearer token for OpenCode"
fi

patch_opencode_config "$TOKEN" "$NODE_URL"

echo "[OK] MSHIN_NODE_TOKEN synchronized."
print_config_snippets "$TOKEN"
