#!/usr/bin/env bash
# OpenVSCode Server bootstrapper
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
DATA_DIR="${SCRIPT_DIR}/.openvscode-server"
ENV_FILE="${DATA_DIR}/env"
DEFAULT_RELEASE_URL_LINUX_X64="https://github.com/gitpod-io/openvscode-server/releases/latest/download/openvscode-server-linux-x64.tar.gz"
DEFAULT_RELEASE_URL_LINUX_ARM64="https://github.com/gitpod-io/openvscode-server/releases/latest/download/openvscode-server-linux-arm64.tar.gz"
DEFAULT_RELEASE_URL_DARWIN_X64="https://github.com/gitpod-io/openvscode-server/releases/latest/download/openvscode-server-darwin-x64.tar.gz"
DEFAULT_RELEASE_URL_DARWIN_ARM64="https://github.com/gitpod-io/openvscode-server/releases/latest/download/openvscode-server-darwin-arm64.tar.gz"
MACHINE_ARCH="$(uname -m 2>/dev/null || echo unknown)"
OS_NAME="$(uname -s 2>/dev/null || echo Unknown)"

color_info="\033[1;34m"
color_warn="\033[1;33m"
color_error="\033[1;31m"
color_reset="\033[0m"

info()  { printf "%b[INFO ]%b %s\n"  "$color_info"  "$color_reset" "$*"; }
warn()  { printf "%b[WARN ]%b %s\n"  "$color_warn"  "$color_reset" "$*"; }
error() { printf "%b[ERROR]%b %s\n" "$color_error" "$color_reset" "$*" >&2; }

default_release_url() {
    case "$OS_NAME" in
        Linux*)
            case "$MACHINE_ARCH" in
                aarch64|arm64)
                    echo "$DEFAULT_RELEASE_URL_LINUX_ARM64" ;;
                *)
                    echo "$DEFAULT_RELEASE_URL_LINUX_X64" ;;
            esac
            ;;
        Darwin*)
            case "$MACHINE_ARCH" in
                arm64)
                    echo "$DEFAULT_RELEASE_URL_DARWIN_ARM64" ;;
                *)
                    echo "$DEFAULT_RELEASE_URL_DARWIN_X64" ;;
            esac
            ;;
        *)
            echo "$DEFAULT_RELEASE_URL_LINUX_X64"
            ;;
    esac
}

ensure_dirs() {
	mkdir -p "$DATA_DIR"
	chmod 700 "$DATA_DIR"
}

expand_path() {
    local path="$1"
    [[ -z "$path" ]] && return
    if [[ "$path" == ~* ]]; then
        eval "echo ${path}"
    else
        echo "$path"
    fi
}

resolve_path() {
    local raw="$1"
    local expanded
    expanded="$(expand_path "$raw")"
    if command -v realpath >/dev/null 2>&1; then
        realpath -m "$expanded"
        return
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$SCRIPT_DIR" "$expanded" <<'PY'
import os, sys
base, target = sys.argv[1], sys.argv[2]
if not os.path.isabs(target):
    target = os.path.join(base, target)
print(os.path.abspath(target))
PY
        return
    fi
    if [[ "$expanded" == /* ]]; then
        printf '%s' "$expanded"
    else
        printf '%s/%s' "$SCRIPT_DIR" "$expanded"
    fi
}

download_release() {
    local url="${1:-$(default_release_url)}"
    if ! command -v curl >/dev/null 2>&1; then
        error "curl is required. Please install curl and try again."
        exit 1
    fi
    if ! command -v tar >/dev/null 2>&1; then
        error "tar is required. Please install tar and try again."
        exit 1
    fi

    local tmp_archive
    tmp_archive="$(mktemp)"
    info "Downloading openvscode-server from ${url}"
    if ! curl -fL "$url" -o "$tmp_archive"; then
        rm -f "$tmp_archive"
        error "Failed to download release."
        exit 1
    fi

    if [[ -d "$DIST_DIR" ]]; then
        local backup="${DIST_DIR}-$(date +%Y%m%d-%H%M%S)"
        mv "$DIST_DIR" "$backup"
        info "Existing dist/ moved to ${backup}"
    fi

    mkdir -p "$DIST_DIR"
    if ! tar -xzf "$tmp_archive" --strip-components=1 -C "$DIST_DIR"; then
        rm -f "$tmp_archive"
        error "Failed to extract archive."
        exit 1
    fi
    rm -f "$tmp_archive"
    chmod +x "$DIST_DIR/bin/openvscode-server"
}

prompt_default() {
	local prompt="$1"
	local default="$2"
	local result
	read -rp "${prompt} [${default}]: " result || true
	if [[ -z "$result" ]]; then
		printf "%s" "$default"
	else
		printf "%s" "$result"
	fi
}

prompt_path() {
    local prompt="$1"
    local default="$2"
    local input
    input=$(prompt_default "$prompt" "$default")
    local resolved
    resolved=$(resolve_path "$input") || {
        error "Failed to resolve path: $input"
        exit 1
    }
    printf "%s" "$resolved"
}

generate_self_signed_cert() {
	local cert_path="$1"
	local key_path="$2"
	local cn="${3:-$(hostname -f 2>/dev/null || echo localhost)}"

	if ! command -v openssl >/dev/null 2>&1; then
		error "openssl is required to generate a self-signed certificate."
		return 1
	fi

	info "Generating self-signed certificate for CN=${cn}"
	mkdir -p "$(dirname "$cert_path")"
	openssl req -x509 -nodes -newkey rsa:4096 \
		-keyout "$key_path" \
		-out "$cert_path" \
		-days 365 \
		-subj "/CN=${cn}" \
		-addext "subjectAltName=DNS:${cn},DNS:localhost"
}

write_env_file() {
	local env_port="$1"
	local env_token="$2"
	local env_tls_mode="$3"
	local env_cert="$4"
	local env_key="$5"
	local env_workspace="$6"
	cat >"$ENV_FILE" <<EOF
OVS_PORT=${env_port}
OVS_HOST=0.0.0.0
OVS_DATA_DIR=${DATA_DIR}
OVS_TOKEN=${env_token}
OVS_TLS_MODE=${env_tls_mode}
OVS_TLS_CERT=${env_cert}
OVS_TLS_KEY=${env_key}
OVS_WORKSPACE_ROOT=${env_workspace}
OVS_EXTRA_ARGS=--enable-proposed-api=*
EOF
}

load_env_file() {
	[[ -f "$ENV_FILE" ]] || return 0
	while IFS='=' read -r key value; do
		[[ -z "$key" || "$key" == \#* ]] && continue
		if [[ -z "${!key-}" ]]; then
			export "$key=$value"
		fi
	done <"$ENV_FILE"
}

create_systemd_unit() {
	local service_name="$1"
	local env_abs="$ENV_FILE"
	local unit_path="/etc/systemd/system/${service_name}.service"
	local workspace="${OVS_WORKSPACE_ROOT:-${HOME:-$SCRIPT_DIR}/dev}"
	workspace="$(resolve_path "$workspace")"
	workspace="$(resolve_path "$workspace")"

	cat <<EOF | sudo tee "$unit_path" >/dev/null
[Unit]
Description=OpenVSCode Server (${service_name})
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
EnvironmentFile=${env_abs}
Environment="OPENVSCODE_SERVER_ROOT=${workspace}"
Environment="HOME=${SCRIPT_DIR}"
Environment="VSCODE_SKIP_GETUNIXSHELLENV=1"
Environment="VSCODE_AGENT_DISABLE_VSDA=1"
ExecStart=${SCRIPT_DIR}/openvscode-server.sh --run-only
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

	sudo systemctl daemon-reload
	sudo systemctl enable "$service_name"
sudo systemctl start "$service_name"
info "systemd unit ${service_name}.service created and started."
}

create_launchd_plist() {
	local label="$1"
	local workspace="${OVS_WORKSPACE_ROOT:-${HOME:-$SCRIPT_DIR}/dev}"
	local plist_dir="${HOME}/Library/LaunchAgents"
	local plist_path="${plist_dir}/${label}.plist"
	local log_dir="${DATA_DIR}/logs"
	mkdir -p "$plist_dir" "$log_dir"

	cat >"$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${SCRIPT_DIR}/openvscode-server.sh</string>
        <string>--run-only</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENVSCODE_SERVER_ROOT</key>
        <string>${workspace}</string>
        <key>HOME</key>
        <string>${SCRIPT_DIR}</string>
        <key>VSCODE_SKIP_GETUNIXSHELLENV</key>
        <string>1</string>
        <key>VSCODE_AGENT_DISABLE_VSDA</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/launchd.err.log</string>
</dict>
</plist>
EOF

	launchctl unload "$plist_path" 2>/dev/null || true
	launchctl load -w "$plist_path"
	info "launchd agent ${label} created and loaded."
}

ensure_dist() {
	if [[ -x "$DIST_DIR/bin/openvscode-server" ]]; then
		return
	fi
    info "dist/ directory not found – downloading release."
	local default_url
	default_url=$(default_release_url)
	local release_url
    release_url=$(prompt_default "Release URL (press Enter for latest)" "$default_url")
	download_release "$release_url"
}

run_server() {
	load_env_file

	local port="${OVS_PORT:-3000}"
	local host="${OVS_HOST:-0.0.0.0}"
	local data_dir="${OVS_DATA_DIR:-$DATA_DIR}"
	local token="${OVS_TOKEN:-}"
	local tls_mode="${OVS_TLS_MODE:-none}"
	local cert="${OVS_TLS_CERT:-}"
	local key="${OVS_TLS_KEY:-}"
	local extra="${OVS_EXTRA_ARGS:-}"
	if [[ -z "$extra" ]]; then
		extra="--enable-proposed-api=*"
	elif [[ "$extra" != *"--enable-proposed-api"* ]]; then
		extra+=" --enable-proposed-api=*"
	fi
	local workspace="${OVS_WORKSPACE_ROOT:-${HOME:-$SCRIPT_DIR}/dev}"
	workspace="$(resolve_path "$workspace")"

	ensure_dirs
	mkdir -p "$data_dir"
    if ! mkdir -p "$workspace"; then
        error "Failed to create workspace directory: $workspace"
        exit 1
    fi

	export OPENVSCODE_SERVER_ROOT="$workspace"
	export VSCODE_SKIP_GETUNIXSHELLENV="${VSCODE_SKIP_GETUNIXSHELLENV:-1}"
	export VSCODE_AGENT_DISABLE_VSDA="${VSCODE_AGENT_DISABLE_VSDA:-1}"

	local cmd=("$DIST_DIR/bin/openvscode-server"
		"--host" "$host"
		"--port" "$port"
		"--user-data-dir" "$data_dir"
		"--default-workspace" "$workspace"
		)

	if [[ -n "$token" ]]; then
		cmd+=("--connection-token" "$token")
	else
		cmd+=("--without-connection-token")
	fi

	case "$tls_mode" in
		none|"")
			;;
		self-signed|custom)
			if [[ -z "$cert" || -z "$key" ]]; then
                error "TLS is enabled but certificate/key paths are missing."
                exit 1
            fi
            cmd+=("--cert" "$cert" "--cert-key" "$key")
            ;;
        *)
            warn "Unknown TLS mode '${tls_mode}', continuing without TLS."
            ;;
    esac

	if [[ -n "$extra" ]]; then
		# shellcheck disable=SC2206
		cmd+=($extra)
	fi

    info "Starting openvscode-server on ${host}:${port}"
	exec "${cmd[@]}"
}

interactive_setup() {
	ensure_dirs
	ensure_dist

    info "OpenVSCode Server setup"
	local port token workspace_root tls_mode cert_dir cert_path key_path service_choice service_name create_unit launchd_choice launchd_label
    port=$(prompt_default "HTTP(S) port" "3000")
	local workspace_default
	workspace_default="${HOME:-$SCRIPT_DIR}/dev"
    workspace_root=$(prompt_path "Workspace directory" "$workspace_default")
	if ! mkdir -p "$workspace_root"; then
        error "Failed to create workspace directory: $workspace_root"
        exit 1
    fi
    info "Workspace root: $workspace_root"
    token=$(prompt_default "Authentication token (leave empty to disable)" "")

    tls_mode=$(prompt_default "TLS mode [none/self-signed/custom]" "self-signed")
	cert_dir="${SCRIPT_DIR}/certs"
	mkdir -p "$cert_dir"

	case "$tls_mode" in
		self-signed)
			cert_path="${cert_dir}/openvscode.crt"
			key_path="${cert_dir}/openvscode.key"
			generate_self_signed_cert "$cert_path" "$key_path"
		info "Self-signed certificate saved to $cert_path (import it in the browser)"
			;;
		custom)
            cert_path=$(prompt_default "Path to .crt" "${cert_dir}/server.crt")
            key_path=$(prompt_default "Path to .key" "${cert_dir}/server.key")
			;;
		*)
			tls_mode="none"
			cert_path=""
			key_path=""
			;;
	esac

	write_env_file "$port" "$token" "$tls_mode" "$cert_path" "$key_path" "$workspace_root"
	load_env_file

	if [[ "$OS_NAME" == Darwin* ]] && command -v launchctl >/dev/null 2>&1; then
        read -rp "Create launchd agent? [Y/n]: " launchd_choice || true
        if [[ "${launchd_choice^^}" != "N" ]]; then
            launchd_label=$(prompt_default "Launchd label" "com.${USER:-openvscode}.openvscode-server")
            create_launchd_plist "$launchd_label"
            info "Check status: launchctl list | grep $launchd_label"
        else
            info "launchd setup skipped. Start manually with ./openvscode-server.sh --run-only"
        fi
elif command -v systemctl >/dev/null 2>&1; then
        read -rp "Create systemd unit? [Y/n]: " service_choice || true
        if [[ "${service_choice^^}" != "N" ]]; then
            service_name=$(prompt_default "Service name" "openvscode-server")
            create_systemd_unit "$service_name"
            info "Check status: sudo systemctl status ${service_name}"
        else
            info "systemd setup skipped. Start manually with ./openvscode-server.sh --run-only"
        fi
else
        warn "systemctl not found; skipping service creation."
fi

	run_server
}

cmd_download() {
	local url="${1:-$(default_release_url)}"
	download_release "$url"
}

cmd_set_token() {
	local new_token="$1"
    if [[ -z "$new_token" ]]; then
        error "Usage: --set-token <value>"
        exit 1
    fi
	ensure_dirs
	load_env_file
	local workspace="${OVS_WORKSPACE_ROOT:-${HOME:-$SCRIPT_DIR}/dev}"
	workspace="$(resolve_path "$workspace")"
	write_env_file "${OVS_PORT:-3000}" "$new_token" "${OVS_TLS_MODE:-none}" "${OVS_TLS_CERT:-}" "${OVS_TLS_KEY:-}" "$workspace"
info "Token updated. Restart the service or process to apply changes."
}

cmd_status() {
	load_env_file
cat <<EOF
Install directory : $SCRIPT_DIR
DIST               : $DIST_DIR
ENV file           : $ENV_FILE
Data dir           : ${OVS_DATA_DIR:-$DATA_DIR}
Workspace root     : ${OVS_WORKSPACE_ROOT:-${HOME:-$SCRIPT_DIR}/dev}
Port               : ${OVS_PORT:-3000}
Token              : ${OVS_TOKEN:-<not set>}
TLS mode           : ${OVS_TLS_MODE:-none}
TLS cert           : ${OVS_TLS_CERT:-}
TLS key            : ${OVS_TLS_KEY:-}
EOF
	if command -v systemctl >/dev/null 2>&1; then
		echo
		echo "Active openvscode-server units (systemd):"
		systemctl list-units --type=service | grep -E 'openvscode-server' || true
	fi
	if [[ "$OS_NAME" == Darwin* ]]; then
		echo
		echo "Launchd agents matching openvscode-server:"
		launchctl list | grep -E 'openvscode' || true
	fi
}

usage() {
cat <<EOF
Usage: $(basename "$SCRIPT_PATH") [options]
  (no args)          interactive mode: download, configure, run
  --run-only         start existing installation with current settings
  --download [URL]   download/update release (URL optional)
  --set-token TOKEN  update connection token in .env
  --status           show current configuration
  --help             show this help
EOF
}

main() {
	if [[ $# -eq 0 ]]; then
		interactive_setup
		return
	fi

	case "$1" in
		--run-only)
			shift
			ensure_dist
			run_server
			;;
	--download)
		shift
		cmd_download "${1:-$(default_release_url)}"
		;;
		--set-token)
			shift
			cmd_set_token "${1:-}"
			;;
		--status)
			cmd_status
			;;
		--help|-h)
			usage
			;;
	*)
		error "Unknown option: $1"
			usage
			exit 1
			;;
	esac
}

main "$@"
