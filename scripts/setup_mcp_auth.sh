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
#
# The script writes:
#   - configs/mshin-node.env                (Docker Node)
#   - ~/.vibe/.env                          (Mistral Vibe)
#   - ~/.config/opencode/.env               (OpenCode, optional)
# and prints the shell exports and macOS launchctl command OpenCode needs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_ENV="${REPO_ROOT}/configs/mshin-node.env"
VIBE_ENV="${HOME}/.vibe/.env"
OPENCODE_ENV="${HOME}/.config/opencode/.env"

MODE="setup"
PROVIDED_TOKEN=""
WRITE_OPENCODE_ENV="${WRITE_OPENCODE_ENV:-yes}"

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
    echo "OpenCode interpolates {env:MSHIN_NODE_TOKEN} from the environment that"
    echo "launches it. For this terminal:"
    echo "  export MSHIN_NODE_TOKEN=${token}"
    echo "For OpenCode's background service on macOS:"
    echo "  launchctl setenv MSHIN_NODE_TOKEN ${token}"
    echo "Then restart the service:"
    echo "  opencode service restart"
    echo
    echo "Make sure your opencode.jsonc has:"
    cat <<'EOF'
  "mshin": {
    "type": "remote",
    "url": "http://localhost:3000/mcp",
    "oauth": false,
    "headers": {
      "Authorization": "Bearer {env:MSHIN_NODE_TOKEN}"
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

    echo "Token sources:"
    echo "  Docker env file:  ${docker_token:-<not set>}"
    echo "  Vibe env file:    ${vibe_token:-<not set>}"
    echo "  OpenCode env file:${opencode_token:-<not set>}"
    echo "  Shell env:        ${shell_token:-<not set>}"

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
        --help|-h)
            sed -n '2,14p' "$0"
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

echo "[OK] MSHIN_NODE_TOKEN synchronized."
print_config_snippets "$TOKEN"
