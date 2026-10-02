#!/bin/bash
# Prepare a bind-mounted /data, then hand over to startup.sh.
#
# Everything here is idempotent: the container is expected to be recreated
# often (image updates, stack restarts) against a persistent appdata share.
set -euo pipefail

ANKICONNECT_ID=2055492159
ANKIMCP_ID=124672614

ADDON_SOURCE="${ANKI_ADDON_SOURCE:-/opt/anki-addons}"
DATA="${ANKI_DATA:-/data}"
ADDON_DIR="${DATA}/addons21"

log() { echo "[entrypoint] $*"; }

# --- /data layout ----------------------------------------------------------
mkdir -p "${ADDON_DIR}"

# Anki shows a first-run profile wizard unless prefs21.db exists. The upstream
# image bakes one in; a bind mount hides it, so seed it once.
if [ ! -f "${DATA}/prefs21.db" ] && [ -f /opt/anki-seed/prefs21.db ]; then
    log "Seeding prefs21.db (fresh /data)"
    cp /opt/anki-seed/prefs21.db "${DATA}/prefs21.db"
fi

# --- addons ----------------------------------------------------------------
# Copy image addon code over whatever is in /data. Files the image does not
# carry — user_files/, the addon's _cache/ (pydantic_core, downloaded once) —
# are left untouched, so the image stays the source of truth for code while
# runtime state survives.
if [ -d "${ADDON_SOURCE}" ]; then
    for src in "${ADDON_SOURCE}"/*; do
        [ -d "${src}" ] || continue
        id="$(basename "${src}")"
        log "Syncing addon ${id}"
        mkdir -p "${ADDON_DIR}/${id}"
        cp -a "${src}/." "${ADDON_DIR}/${id}/"
    done
fi

# csv_to_json_array "a, b" -> ["a","b"];  "" -> []
# Built with -n/--arg rather than -R: jq -R emits nothing at all for empty
# input, which would feed an empty string to --argjson below.
csv_to_json_array() {
    jq -nc --arg s "${1:-}" '$s
        | split(",")
        | map(gsub("^\\s+|\\s+$"; ""))
        | map(select(length > 0))'
}

# Force our keys into config.json (the addon default) and, when Anki has
# already written one, into meta.json's .config (the user override that would
# otherwise win). Keys we do not name are left alone, so anything configured
# through the Anki GUI survives a restart.
apply_addon_config() {
    local addon_id="$1" filter="$2"; shift 2
    local dir="${ADDON_DIR}/${addon_id}"
    local cfg="${dir}/config.json" meta="${dir}/meta.json" tmp

    [ -d "${dir}" ] || { log "Addon ${addon_id} not present, skipping config"; return 0; }

    if [ -f "${cfg}" ]; then
        tmp="$(mktemp)"
        jq "$@" "${filter}" "${cfg}" > "${tmp}" && mv "${tmp}" "${cfg}"
    fi

    if [ -f "${meta}" ] && jq -e 'has("config")' "${meta}" >/dev/null 2>&1; then
        tmp="$(mktemp)"
        jq "$@" ".config |= (${filter})" "${meta}" > "${tmp}" && mv "${tmp}" "${meta}"
    fi
}

# --- config validation -----------------------------------------------------
# The MCP addon surfaces config mistakes through showWarning(), a MODAL Qt
# dialog raised on profile open. Headless there is nobody to dismiss it, and
# the addon raises it *before* starting the server: the container comes up,
# Anki runs, AnkiConnect answers — and port 3141 stays shut forever with no
# error anywhere. Refuse to start instead, so the reason is in the log.
# Rules mirror the addon's own validators (http_auth.py, transport_security_config.py).
MIN_API_KEY_LENGTH=16
config_errors=0

fail_config() { echo "[entrypoint] CONFIG ERROR: $*" >&2; config_errors=$((config_errors + 1)); }

if [ -n "${ANKI_MCP_API_KEY:-}" ]; then
    trimmed="$(printf '%s' "${ANKI_MCP_API_KEY}" | tr -d '[:space:]')"
    if [ "${trimmed}" != "${ANKI_MCP_API_KEY}" ]; then
        fail_config "ANKI_MCP_API_KEY has surrounding whitespace. It could never authenticate."
    elif [ "${#ANKI_MCP_API_KEY}" -lt "${MIN_API_KEY_LENGTH}" ]; then
        fail_config "ANKI_MCP_API_KEY is ${#ANKI_MCP_API_KEY} characters; the addon wants at least ${MIN_API_KEY_LENGTH}."
    fi
fi

# Host entries carry no scheme; origin entries must carry one.
IFS=',' read -ra _hosts <<< "${ANKI_MCP_ALLOWED_HOSTS:-}"
for h in "${_hosts[@]:-}"; do
    case "${h}" in
        *://*) fail_config "ANKI_MCP_ALLOWED_HOSTS entry '${h}' has a scheme; use host:port only." ;;
    esac
done
IFS=',' read -ra _origins <<< "${ANKI_MCP_ALLOWED_ORIGINS:-}"
for o in "${_origins[@]:-}"; do
    o="$(printf '%s' "${o}" | tr -d '[:space:]')"
    [ -z "${o}" ] && continue
    case "${o}" in
        *://*) ;;
        *) fail_config "ANKI_MCP_ALLOWED_ORIGINS entry '${o}' has no scheme; use e.g. http://host:port." ;;
    esac
done

if [ "${config_errors}" -gt 0 ]; then
    echo "[entrypoint] Refusing to start: ${config_errors} config error(s) above would open a" >&2
    echo "[entrypoint] modal dialog inside Anki and silently prevent the MCP server from starting." >&2
    exit 1
fi

# --- AnkiMCP server (port 3141) --------------------------------------------
mcp_hosts="$(csv_to_json_array "${ANKI_MCP_ALLOWED_HOSTS:-}")"
mcp_origins="$(csv_to_json_array "${ANKI_MCP_ALLOWED_ORIGINS:-}")"

apply_addon_config "${ANKIMCP_ID}" \
    '.http_enabled = true
     | .http_host = $host
     | .http_port = ($port | tonumber)
     | .http_api_key = $key
     | .http_allowed_hosts = $hosts
     | .http_allowed_origins = $origins
     | .disabled_tools = $disabled' \
    --arg host "${ANKI_MCP_HOST:-0.0.0.0}" \
    --arg port "${ANKI_MCP_PORT:-3141}" \
    --arg key "${ANKI_MCP_API_KEY:-}" \
    --argjson hosts "${mcp_hosts}" \
    --argjson origins "${mcp_origins}" \
    --argjson disabled "$(csv_to_json_array "${ANKI_MCP_DISABLED_TOOLS:-}")"

# The MCP addon has DNS-rebinding protection with a loopback-only allowlist.
# Bound to 0.0.0.0 without an allowlist it answers 421 to every remote call —
# the container looks healthy and every agent request fails.
if [ "${ANKI_MCP_HOST:-0.0.0.0}" != "127.0.0.1" ] && [ "${mcp_hosts}" = "[]" ]; then
    log "WARNING: ANKI_MCP_ALLOWED_HOSTS is empty while the MCP server listens on"
    log "WARNING: ${ANKI_MCP_HOST:-0.0.0.0}. Remote clients will be rejected with HTTP 421."
    log "WARNING: Set it to the host:port agents dial, e.g. 10.0.0.5:3141"
fi

# --- AnkiConnect (port 8765) -----------------------------------------------
ankiconnect_cors="$(csv_to_json_array "${ANKICONNECT_CORS:-http://localhost}")"

apply_addon_config "${ANKICONNECT_ID}" \
    '.webBindAddress = $bind
     | .webBindPort = ($port | tonumber)
     | .apiKey = (if $key == "" then null else $key end)
     | .webCorsOriginList = $cors' \
    --arg bind "${ANKICONNECT_BIND:-0.0.0.0}" \
    --arg port "${ANKICONNECT_PORT:-8765}" \
    --arg key "${ANKICONNECT_API_KEY:-}" \
    --argjson cors "${ankiconnect_cors}"

# --- VNC password ----------------------------------------------------------
# Upstream runs -SecurityTypes None. If VNCPASSWORD is set, build a TigerVNC
# password file and startup.sh switches to VncAuth.
if [ -n "${VNCPASSWORD:-}" ]; then
    mkdir -p /run/vnc
    if [ "${#VNCPASSWORD}" -gt 8 ]; then
        log "NOTE: VNC auth truncates the password to 8 characters (protocol limit)."
    fi
    vncpasswd_bin="$(command -v vncpasswd || command -v tigervncpasswd)"
    printf '%s' "${VNCPASSWORD}" | "${vncpasswd_bin}" -f > /run/vnc/passwd
    chmod 600 /run/vnc/passwd
    log "VNC password authentication enabled"
else
    log "WARNING: VNCPASSWORD is unset — port 5900 accepts anyone who can reach it."
fi

# --- privilege drop --------------------------------------------------------
# Default is upstream behaviour (root), which always works. Set PUID to run as
# an unprivileged user; 99:100 is nobody:users on Unraid.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

if [ -n "${PUID:-}" ] && [ "${PUID}" != "0" ]; then
    PGID="${PGID:-${PUID}}"
    log "Running as PUID=${PUID} PGID=${PGID}"

    groupmod -o -g "${PGID}" anki 2>/dev/null || true
    usermod  -o -u "${PUID}" -g "${PGID}" anki 2>/dev/null || true

    # chown -R over a large media collection is slow; only do it when the mount
    # is not already owned correctly. Addons are re-copied as root every start,
    # so those always need fixing.
    if [ "$(stat -c %u "${DATA}")" != "${PUID}" ]; then
        log "Adjusting ownership of ${DATA} (one-time, may take a moment)"
        chown -R "${PUID}:${PGID}" "${DATA}"
    else
        chown -R "${PUID}:${PGID}" "${ADDON_DIR}"
    fi
    chown -R "${PUID}:${PGID}" /home/anki /run/vnc 2>/dev/null || true

    export HOME=/home/anki
    export XDG_RUNTIME_DIR=/tmp/runtime-anki
    mkdir -p "${XDG_RUNTIME_DIR}" && chmod 700 "${XDG_RUNTIME_DIR}"
    chown "${PUID}:${PGID}" "${XDG_RUNTIME_DIR}"

    exec gosu anki "$@"
fi

log "Running as root (set PUID/PGID to drop privileges)"
exec "$@"
