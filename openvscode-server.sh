#!/usr/bin/env bash
# OpenVSCode Server bootstrapper
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
DATA_DIR="${SCRIPT_DIR}/.openvscode-server"
ENV_FILE="${DATA_DIR}/env"
DEFAULT_RELEASE_URL_LINUX_X64="https://github.com/Itexoft/openvscode-server/releases/latest/download/openvscode-server-linux-x64-web.tar.gz"
DEFAULT_RELEASE_URL_LINUX_ARM64=""
DEFAULT_RELEASE_URL_DARWIN_X64=""
DEFAULT_RELEASE_URL_DARWIN_ARM64=""
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

remove_unit_file() {
	local unit_path="$1"
	if rm -f "$unit_path" 2>/dev/null; then
		return 0
	fi
	if command -v sudo >/dev/null 2>&1; then
		sudo rm -f "$unit_path" 2>/dev/null || true
	fi
}

resolve_path() {
    local raw="$1"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$SCRIPT_DIR" "$raw" <<'PY'
import os
import sys

base, target = sys.argv[1], sys.argv[2]
expanded = os.path.expanduser(target)
if not os.path.isabs(expanded):
    expanded = os.path.join(base, expanded)
print(os.path.abspath(expanded))
PY
        return
    fi

    if command -v python >/dev/null 2>&1; then
        python - "$SCRIPT_DIR" "$raw" <<'PY'
import os
import sys

base, target = sys.argv[1], sys.argv[2]
expanded = os.path.expanduser(target)
if not os.path.isabs(expanded):
    expanded = os.path.join(base, expanded)
print(os.path.abspath(expanded))
PY
        return
    fi

    local expanded="$raw"
    case "$expanded" in
        ~)
            if [[ -n "${HOME-}" ]]; then
                expanded="$HOME"
            fi
            ;;
        ~/*)
            if [[ -n "${HOME-}" ]]; then
                expanded="${HOME}${expanded:1}"
            fi
            ;;
    esac

    if command -v realpath >/dev/null 2>&1; then
        realpath -m "$expanded"
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
    if ! curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$tmp_archive"; then
        rm -f "$tmp_archive"
        error "Failed to download release."
        exit 1
    fi

    if [[ -d "$DIST_DIR" ]]; then
        local backup
        backup="${DIST_DIR}-$(date +%Y%m%d-%H%M%S)"
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
		result=${result//$'\r'/}
		result=$(printf '%s' "$result" | LC_ALL=C tr -cd '\11\12\40-\176')
		printf "%s" "$result"
	fi
}

prompt_path() {
    local prompt="$1"
    local default="$2"
	local input
	input=$(prompt_default "$prompt" "$default")
	input=${input//$'\r'/}
	input=$(printf '%s' "$input" | LC_ALL=C tr -cd '\11\12\40-\176')
	local resolved
	if ! resolved=$(resolve_path "$input"); then
		error "Failed to resolve path: $input"
		exit 1
	fi
	printf "%s" "$resolved"
}

prompt_yes_no() {
	local prompt="$1"
	local reply
	while true; do
		read -rp "${prompt} [y/n]: " reply || true
		reply=${reply//$'\r'/}
		reply=$(printf '%s' "$reply" | LC_ALL=C tr -d ' \t')
		case "${reply,,}" in
			y|yes) return 0 ;;
			n|no) return 1 ;;
			*) warn "Please answer with y or n." ;;
		esac
	done
}

port_in_use() {
	local port="$1"
	if command -v ss >/dev/null 2>&1; then
		if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[\.:]${port}\$"; then
			return 0
		fi
	elif command -v netstat >/dev/null 2>&1; then
		if netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[\.:]${port}\$"; then
			return 0
		fi
	elif command -v lsof >/dev/null 2>&1; then
		if lsof -nPi TCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
			return 0
		fi
	fi
	return 1
}

describe_port_usage() {
	local port="$1"
	if command -v ss >/dev/null 2>&1; then
		ss -ltnp 2>/dev/null | grep -E "[\.:]${port}\$" || true
	elif command -v netstat >/dev/null 2>&1; then
		netstat -ltnp 2>/dev/null | grep -E "[\.:]${port}\$" || true
	elif command -v lsof >/dev/null 2>&1; then
		lsof -nPi TCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || true
	else
		warn "Cannot display details for port ${port}; install 'ss' or 'netstat' to inspect conflicts."
	fi
}

list_listen_pids() {
	local port="$1"
	if command -v lsof >/dev/null 2>&1; then
		lsof -nPi TCP:"$port" -sTCP:LISTEN -Fp 2>/dev/null | sed 's/^p//' | sort -u
		return
	fi
	if command -v ss >/dev/null 2>&1; then
		ss -ltnp 2>/dev/null | awk -v port="$port" '
			($4 ~ ":" port "$") {
				while (match($0, /pid=([0-9]+)/, m)) {
					print m[1];
					$0 = substr($0, RSTART + RLENGTH);
				}
			}
		' | sort -u
		return
	fi
	if command -v netstat >/dev/null 2>&1; then
		netstat -ltnp 2>/dev/null | awk -v port="$port" '
			($4 ~ ":" port "$") {
				split($7, arr, "/");
				if (arr[1] != "-") print arr[1];
			}
		' | sort -u
	fi
}

stop_pid_if_matches_install() {
	local pid="$1"
	[[ -n "$pid" ]] || return 1
	if [[ ! -r "/proc/$pid/cmdline" ]]; then
		return 1
	fi
	local cmdline
	cmdline=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null)
	if [[ -z "$cmdline" || "$cmdline" != *"$SCRIPT_DIR"* ]]; then
		return 1
	fi

	info "Stopping existing process $pid associated with ${SCRIPT_DIR}"
	kill "$pid" 2>/dev/null || true
	for _ in {1..10}; do
		if ! kill -0 "$pid" 2>/dev/null; then
			return 0
		fi
		sleep 0.2
	done
	warn "Process $pid did not exit after SIGTERM, sending SIGKILL"
	kill -KILL "$pid" 2>/dev/null || true
}

stop_existing_instance() {
	load_env_file
	local service_name="${OVS_SYSTEMD_SERVICE_NAME:-}"
	local port="${OVS_PORT:-}"

	if systemd_ready; then
		local service_candidates=()
		if [[ -n "$service_name" ]]; then
			service_candidates+=("$service_name")
		fi
		local generated_service
		generated_service="$(generate_service_name "$SCRIPT_DIR")"
		if [[ -z "$service_name" || "$service_name" != "$generated_service" ]]; then
			service_candidates+=("$generated_service")
		fi
		local svc
		for svc in "${service_candidates[@]}"; do
			if [[ -z "$svc" ]]; then
				continue
			fi
			if systemctl_cmd is-active "$svc" >/dev/null 2>&1; then
				info "Stopping existing systemd service ${svc}"
				systemctl_cmd stop "$svc" >/dev/null 2>&1 || warn "Failed to stop ${svc}"
			fi
		done
	fi

	if [[ -n "$port" ]]; then
		local pid stopped=0
		while read -r pid; do
			[[ -z "$pid" ]] && continue
			if stop_pid_if_matches_install "$pid"; then
				stopped=1
			fi
		done < <(list_listen_pids "$port")
		if (( stopped )); then
			info "Waiting for port ${port} to become free..."
			for _ in {1..10}; do
				if ! port_in_use "$port"; then
					break
				fi
				sleep 0.2
			done
		fi
	fi

	stop_runtime_processes_for_install
}

stop_listeners_for_port() {
	local port="$1"
	[[ -n "$port" ]] || return 0
	local pid stopped=0
	while read -r pid; do
		[[ -z "$pid" ]] && continue
		if stop_pid_if_matches_install "$pid"; then
			stopped=1
		fi
	done < <(list_listen_pids "$port")
	if (( stopped )); then
		info "Stopped existing processes bound to port ${port}."
		for _ in {1..10}; do
			if ! port_in_use "$port"; then
				break
			fi
			sleep 0.2
		done
	fi
}

list_runtime_pids_for_install() {
	if [[ -d "$DIST_DIR" ]]; then
		if command -v pgrep >/dev/null 2>&1; then
			pgrep -f "$DIST_DIR" 2>/dev/null | sort -u || true
			return
		fi
	fi
	ps -eo pid=,args= 2>/dev/null | awk -v dir="$DIST_DIR" '
		dir != "" && index($0, dir) { print $1 }
	' | sort -u
}

stop_runtime_processes_for_install() {
	local pid stopped=0
	while read -r pid; do
		[[ -z "$pid" ]] && continue
		if [[ "$pid" == "$$" || "$pid" == "${BASHPID:-}" ]]; then
			continue
		fi
		if stop_pid_if_matches_install "$pid"; then
			stopped=1
		fi
	done < <(list_runtime_pids_for_install)
	if (( stopped )); then
		info "Stopped lingering processes from previous run in ${SCRIPT_DIR}"
	fi
}

generate_service_name() {
	local path="$1"
	if command -v sha1sum >/dev/null 2>&1; then
		printf 'openvscode-%s' "$(printf '%s' "$path" | sha1sum | awk '{print $1}' | cut -c1-12)"
	elif command -v md5sum >/dev/null 2>&1; then
		printf 'openvscode-%s' "$(printf '%s' "$path" | md5sum | awk '{print $1}' | cut -c1-12)"
	else
		# Fallback: strip non-word characters
		local sanitized
		sanitized=$(printf '%s' "$path" | LC_ALL=C tr -cd '[:alnum:]\n' | cut -c1-12)
		printf 'openvscode-%s' "${sanitized:-srv}"
	fi
}

service_exists() {
	local service_name="$1"
	if ! command -v systemctl >/dev/null 2>&1; then
		return 1
	fi
	local listed
	listed=$(systemctl list-unit-files "${service_name}.service" 2>/dev/null | awk 'NR>1 && $1 ~ /\.service$/ {print $1}')
	if [[ "$listed" == "${service_name}.service" ]]; then
		return 0
	fi
	if systemctl status "${service_name}.service" >/dev/null 2>&1; then
		return 0
	fi
	if [[ -f "/etc/systemd/system/${service_name}.service" ]]; then
		return 0
	fi
	return 1
}

ensure_service_available() {
	local service_name="$1"
	if ! service_exists "$service_name"; then
		return 0
	fi
	warn "Service ${service_name}.service already exists."
	if prompt_yes_no "Stop and disable existing ${service_name}.service?"; then
		systemctl_cmd stop "$service_name" >/dev/null 2>&1 || true
		systemctl_cmd disable "$service_name" >/dev/null 2>&1 || true
		rm -f "/etc/systemd/system/${service_name}.service" 2>/dev/null || sudo rm -f "/etc/systemd/system/${service_name}.service" 2>/dev/null || true
		systemctl_cmd daemon-reload >/dev/null 2>&1 || true
		return 0
	fi
	info "Keeping existing ${service_name}.service; skipping recreation."
	return 2
}

handle_service_migration() {
	local expected_name="$1"
	local previous_name="${OVS_SYSTEMD_SERVICE_NAME:-}"
	local previous_root="${OVS_PREVIOUS_INSTALL_ROOT:-}"

	if [[ -n "$previous_name" && "$previous_name" != "$expected_name" ]]; then
		if service_exists "$previous_name"; then
			warn "Found legacy service ${previous_name}.service from previous location ${previous_root:-unknown}."
			if prompt_yes_no "Disable and remove legacy service ${previous_name}.service?"; then
				systemctl_cmd stop "$previous_name" >/dev/null 2>&1 || true
				systemctl_cmd disable "$previous_name" >/dev/null 2>&1 || true
				rm -f "/etc/systemd/system/${previous_name}.service" 2>/dev/null || sudo rm -f "/etc/systemd/system/${previous_name}.service" 2>/dev/null || true
				systemctl_cmd daemon-reload >/dev/null 2>&1 || true
			else
				error "Installation aborted due to conflicting legacy service."
				exit 1
			fi
		fi
	fi
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
	local env_service="${7:-}"
	local env_ca="${8:-}"
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
OVS_SYSTEMD_SERVICE_NAME=${env_service}
OVS_TLS_CA=${env_ca}
OVS_INSTALL_ROOT=${SCRIPT_DIR}
OVS_EXPECTED_SERVICE_NAME=${OVS_EXPECTED_SERVICE_NAME:-${env_service}}
EOF

	export OVS_PORT="$env_port"
	export OVS_HOST="0.0.0.0"
	export OVS_DATA_DIR="$DATA_DIR"
	export OVS_TOKEN="$env_token"
	export OVS_TLS_MODE="$env_tls_mode"
	export OVS_TLS_CERT="$env_cert"
	export OVS_TLS_KEY="$env_key"
	export OVS_WORKSPACE_ROOT="$env_workspace"
	export OVS_EXTRA_ARGS="--enable-proposed-api=*"
	export OVS_SYSTEMD_SERVICE_NAME="$env_service"
	export OVS_TLS_CA="$env_ca"
	export OVS_INSTALL_ROOT="$SCRIPT_DIR"
	export OVS_EXPECTED_SERVICE_NAME="${OVS_EXPECTED_SERVICE_NAME:-$env_service}"
	export OVS_DEFAULT_PORT="$env_port"
	export OVS_DEFAULT_WORKSPACE="$env_workspace"
	export OVS_DEFAULT_TOKEN="$env_token"
	export OVS_DEFAULT_TLS_MODE="$env_tls_mode"
	export OVS_DEFAULT_TLS_CERT="$env_cert"
	export OVS_DEFAULT_TLS_KEY="$env_key"
	export OVS_DEFAULT_TLS_CA="$env_ca"
	if [[ -n "$env_service" ]]; then
		export OVS_DEFAULT_SYSTEMD_SERVICE_NAME="$env_service"
	fi
}

load_env_file() {
	[[ -f "$ENV_FILE" ]] || return 0
	while IFS='=' read -r key value; do
		[[ -z "$key" || "$key" == \#* ]] && continue
		export "$key=$value"
	done <"$ENV_FILE"
}

apply_env_defaults() {
	load_env_file
	if [[ -n "${OVS_PORT:-}" && -z "${OVS_DEFAULT_PORT:-}" ]]; then
		export OVS_DEFAULT_PORT="$OVS_PORT"
	fi
	if [[ -n "${OVS_WORKSPACE_ROOT:-}" && -z "${OVS_DEFAULT_WORKSPACE:-}" ]]; then
		export OVS_DEFAULT_WORKSPACE="$OVS_WORKSPACE_ROOT"
	fi
	if [[ -n "${OVS_TOKEN:-}" && -z "${OVS_DEFAULT_TOKEN:-}" ]]; then
		export OVS_DEFAULT_TOKEN="$OVS_TOKEN"
	fi
	if [[ -n "${OVS_TLS_MODE:-}" && -z "${OVS_DEFAULT_TLS_MODE:-}" ]]; then
		export OVS_DEFAULT_TLS_MODE="$OVS_TLS_MODE"
	fi
	if [[ -n "${OVS_TLS_CERT:-}" && -z "${OVS_DEFAULT_TLS_CERT:-}" ]]; then
		export OVS_DEFAULT_TLS_CERT="$OVS_TLS_CERT"
	fi
	if [[ -n "${OVS_TLS_KEY:-}" && -z "${OVS_DEFAULT_TLS_KEY:-}" ]]; then
		export OVS_DEFAULT_TLS_KEY="$OVS_TLS_KEY"
	fi
	if [[ -n "${OVS_TLS_CA:-}" && -z "${OVS_DEFAULT_TLS_CA:-}" ]]; then
		export OVS_DEFAULT_TLS_CA="$OVS_TLS_CA"
	fi
	if [[ -n "${OVS_SYSTEMD_SERVICE_NAME:-}" && -z "${OVS_DEFAULT_SYSTEMD_SERVICE_NAME:-}" ]]; then
		export OVS_DEFAULT_SYSTEMD_SERVICE_NAME="$OVS_SYSTEMD_SERVICE_NAME"
	fi
	if [[ -n "${OVS_EXPECTED_SERVICE_NAME:-}" && -z "${OVS_DEFAULT_SYSTEMD_SERVICE_NAME:-}" ]]; then
		export OVS_DEFAULT_SYSTEMD_SERVICE_NAME="$OVS_EXPECTED_SERVICE_NAME"
	fi
	if [[ -n "${OVS_INSTALL_ROOT:-}" ]]; then
		export OVS_PREVIOUS_INSTALL_ROOT="$OVS_INSTALL_ROOT"
	fi
}

create_systemd_unit() {
	local service_name="$1"
	local env_abs="$ENV_FILE"
	local unit_path="/etc/systemd/system/${service_name}.service"
	local workspace="${OVS_WORKSPACE_ROOT:-${HOME:-$SCRIPT_DIR}/dev}"
	workspace="$(resolve_path "$workspace")"

	if ! systemd_ready; then
		warn "systemd does not appear to be active; skipping service creation."
		return 1
	fi

	cat <<EOF | tee_cmd "$unit_path" >/dev/null
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

	if ! systemctl_cmd daemon-reload >/dev/null 2>&1; then
		warn "systemctl daemon-reload failed; skipping service creation."
		return 1
	fi
	if ! systemctl_cmd enable "$service_name" >/dev/null 2>&1; then
		warn "systemctl enable ${service_name} failed; skipping service creation."
		return 1
	fi
	if ! systemctl_cmd start "$service_name" >/dev/null 2>&1; then
		warn "systemctl start ${service_name} failed; check the service status manually."
		return 1
	fi
	info "systemd unit ${service_name}.service created and started."
    return 0
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
	info "dist/ directory not found - downloading release."
	local default_url
	default_url=$(default_release_url)
	local release_url
	release_url=$(prompt_default "Release URL (press Enter for latest)" "$default_url")
	download_release "$release_url"
}

systemctl_cmd() {
	if command -v sudo >/dev/null 2>&1; then
		sudo systemctl "$@"
	else
		systemctl "$@"
	fi
}

systemd_ready() {
	if ! command -v systemctl >/dev/null 2>&1; then
		return 1
	fi
	if systemctl show-environment >/dev/null 2>&1; then
		return 0
	fi
	return 1
}

tee_cmd() {
	if command -v sudo >/dev/null 2>&1; then
		sudo tee "$@"
	else
		ee "$@"
	fi
}

run_system_service() {
	load_env_file
	local service_name="${OVS_SYSTEMD_SERVICE_NAME:-}"
	if [[ -n "$service_name" ]] && systemd_ready; then
		info "Starting systemd service ${service_name}"
		if systemctl_cmd start "$service_name" >/dev/null 2>&1; then
			systemctl_cmd status "$service_name" --no-pager || true
			return
		fi
		warn "Failed to start ${service_name}. Falling back to foreground mode."
	elif [[ -n "$service_name" ]]; then
		warn "systemd is not available in this environment; running foreground server instead."
	else
		warn "No systemd service configured; running foreground server instead."
	fi
	run_server
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

	export OVS_PORT="$port"
	info "Using port ${port} (host ${host})."
	if port_in_use "$port"; then
		warn "Port ${port} is already in use. Attempting to stop existing instance from ${SCRIPT_DIR}."
		stop_runtime_processes_for_install
		if port_in_use "$port"; then
			error "Port ${port} is already in use. Stop the conflicting service or choose another port."
			describe_port_usage "$port"
			exit 1
		fi
		info "Port ${port} cleared; continuing startup."
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

	local tls_args=()
	case "$tls_mode" in
		none|"")
			;;
		self-signed|custom)
			if [[ -z "$cert" || -z "$key" ]]; then
				error "TLS is enabled but certificate/key paths are missing."
				exit 1
			fi
			if [[ ! -f "$cert" || ! -f "$key" ]]; then
				error "TLS certificate or key file does not exist."
				exit 1
			fi
			tls_args+=("--tls-cert" "$cert" "--tls-key" "$key")
			if [[ -n "${OVS_TLS_CA:-}" ]]; then
				IFS=':' read -r -a _tls_ca_array <<< "${OVS_TLS_CA}"
				for _tls_ca in "${_tls_ca_array[@]}"; do
					[[ -z "$_tls_ca" ]] && continue
					if [[ ! -f "$_tls_ca" ]]; then
						warn "TLS CA bundle not found: $_tls_ca"
						continue
					fi
					tls_args+=("--tls-ca" "$_tls_ca")
				done
			fi
			;;
		*)
			warn "Unknown TLS mode '${tls_mode}', continuing without TLS."
			;;
	esac
	unset _tls_ca_array _tls_ca

	if [[ -n "${tls_args[*]}" ]]; then
		cmd+=("${tls_args[@]}")
	fi

	if [[ -n "$extra" ]]; then
		IFS=' ' read -r -a _extra_args <<< "$extra"
		for _extra_arg in "${_extra_args[@]}"; do
			cmd+=("$_extra_arg")
		done
		unset _extra_args _extra_arg
	fi

	info "Starting openvscode-server on ${host}:${port}"
	exec "${cmd[@]}"
}

interactive_setup() {
	ensure_dirs
	stop_existing_instance
	apply_env_defaults

	local expected_service="${OVS_EXPECTED_SERVICE_NAME:-$(generate_service_name "$SCRIPT_DIR")}"
	handle_service_migration "$expected_service"
	export OVS_EXPECTED_SERVICE_NAME="$expected_service"
	export OVS_DEFAULT_SYSTEMD_SERVICE_NAME="$expected_service"

	if [[ -d "$DIST_DIR" ]]; then
		info "Existing binaries detected in $DIST_DIR"
		if prompt_yes_no "Download latest OpenVSCode Server binaries?" ; then
			cmd_download "$(default_release_url)"
		fi
	else
		ensure_dist
	fi

	info "OpenVSCode Server setup"
	local port token workspace_root tls_mode cert_dir cert_path key_path ca_path service_name="" launchd_label
	local port_default
	port_default="${OVS_DEFAULT_PORT:-3000}"
	port=$(prompt_default "HTTP(S) port" "$port_default")
	local workspace_default
	if [[ -n "${OVS_DEFAULT_WORKSPACE:-}" ]]; then
		workspace_default="${OVS_DEFAULT_WORKSPACE}"
	else
		workspace_default="${HOME:-$SCRIPT_DIR}/dev"
	fi
	workspace_root=$(prompt_path "Workspace directory" "$workspace_default")
	if ! mkdir -p "$workspace_root"; then
		error "Failed to create workspace directory: $workspace_root"
		exit 1
	fi
	info "Workspace root: $workspace_root"
	local token_default
	token_default="${OVS_DEFAULT_TOKEN:-}"
	token=$(prompt_default "Authentication token (leave empty to disable)" "$token_default")

	local tls_mode_default
	tls_mode_default="${OVS_DEFAULT_TLS_MODE:-self-signed}"
	tls_mode=$(prompt_default "TLS mode [none/self-signed/custom]" "$tls_mode_default")
	cert_dir="${SCRIPT_DIR}/certs"
	mkdir -p "$cert_dir"
	ca_path=""

	case "$tls_mode" in
	self-signed)
		cert_path="${cert_dir}/openvscode.crt"
		key_path="${cert_dir}/openvscode.key"
		if [[ -f "$cert_path" && -f "$key_path" ]]; then
			info "Existing self-signed certificate detected: $cert_path"
			if prompt_yes_no "Regenerate self-signed certificate?"; then
				generate_self_signed_cert "$cert_path" "$key_path"
				info "Self-signed certificate saved to $cert_path (import it in the browser)"
			else
				info "Reusing existing certificate."
			fi
		else
			generate_self_signed_cert "$cert_path" "$key_path"
			info "Self-signed certificate saved to $cert_path (import it in the browser)"
		fi
		ca_path="$cert_path"
		;;
		custom)
			local cert_default key_default
			cert_default="${OVS_DEFAULT_TLS_CERT:-${cert_dir}/server.crt}"
			key_default="${OVS_DEFAULT_TLS_KEY:-${cert_dir}/server.key}"
			cert_path=$(prompt_default "Path to .crt" "$cert_default")
			key_path=$(prompt_default "Path to .key" "$key_default")
			local resolved_cert
			if ! resolved_cert=$(resolve_path "$cert_path"); then
				error "Failed to resolve certificate path"
				exit 1
			fi
			cert_path="$resolved_cert"
			local resolved_key
			if ! resolved_key=$(resolve_path "$key_path"); then
				error "Failed to resolve key path"
				exit 1
			fi
			key_path="$resolved_key"
			if [[ ! -f "$cert_path" || ! -f "$key_path" ]]; then
				error "Certificate or key file not found."
				exit 1
			fi
			local ca_input=""
			if [[ -n "${OVS_DEFAULT_TLS_CA:-}" ]]; then
				read -rp "Optional path to CA bundle (leave empty to skip) [${OVS_DEFAULT_TLS_CA}]: " ca_input || true
			else
				read -rp "Optional path to CA bundle (leave empty to skip): " ca_input || true
			fi
			ca_input=${ca_input//$'\r'/}
			ca_input=$(printf '%s' "$ca_input" | LC_ALL=C tr -cd '\11\12\40-\176')
			if [[ -z "$ca_input" && -n "${OVS_DEFAULT_TLS_CA:-}" ]]; then
				ca_input="${OVS_DEFAULT_TLS_CA}"
			fi
			if [[ -n "$ca_input" ]]; then
				local resolved_ca
				if ! resolved_ca=$(resolve_path "$ca_input"); then
					error "Failed to resolve CA path"
					exit 1
				fi
				if [[ ! -f "$resolved_ca" ]]; then
					error "CA bundle not found: $resolved_ca"
					exit 1
				fi
				ca_path="$resolved_ca"
			fi
			;;
	*)
		tls_mode="none"
		cert_path=""
		key_path=""
		;;
	esac

	export OVS_PORT="$port"
	export OVS_WORKSPACE_ROOT="$workspace_root"
	export OVS_TOKEN="$token"
	export OVS_TLS_MODE="$tls_mode"
	export OVS_TLS_CERT="$cert_path"
	export OVS_TLS_KEY="$key_path"
	export OVS_TLS_CA="$ca_path"
	export OVS_DEFAULT_PORT="$port"
	export OVS_DEFAULT_WORKSPACE="$workspace_root"
	export OVS_DEFAULT_TOKEN="$token"
	export OVS_DEFAULT_TLS_MODE="$tls_mode"
	export OVS_DEFAULT_TLS_CERT="$cert_path"
	export OVS_DEFAULT_TLS_KEY="$key_path"
	export OVS_DEFAULT_TLS_CA="$ca_path"

	write_env_file "$port" "$token" "$tls_mode" "$cert_path" "$key_path" "$workspace_root" "$service_name" "$ca_path"
	load_env_file

	if [[ "$OS_NAME" == Darwin* ]] && command -v launchctl >/dev/null 2>&1; then
		if prompt_yes_no "Create launchd agent?"; then
            launchd_label=$(prompt_default "Launchd label" "com.${USER:-openvscode}.openvscode-server")
            create_launchd_plist "$launchd_label"
            info "Check status: launchctl list | grep $launchd_label"
        else
            info "launchd setup skipped. Start manually with ./openvscode-server.sh --run-only"
        fi
	elif command -v systemctl >/dev/null 2>&1; then
		if prompt_yes_no "Create systemd unit?"; then
			service_name="${OVS_DEFAULT_SYSTEMD_SERVICE_NAME:-$expected_service}"
			local ensure_status
			if ensure_service_available "$service_name"; then
				ensure_status=0
			else
				ensure_status=$?
			fi
			if (( ensure_status == 0 )); then
				if create_systemd_unit "$service_name"; then
					if command -v sudo >/dev/null 2>&1; then
						info "Check status: sudo systemctl status ${service_name}"
					else
	                    info "Check status: systemctl status ${service_name}"
					fi
					write_env_file "$port" "$token" "$tls_mode" "$cert_path" "$key_path" "$workspace_root" "$service_name" "$ca_path"
					load_env_file
				else
					service_name=""
					write_env_file "$port" "$token" "$tls_mode" "$cert_path" "$key_path" "$workspace_root" "" "$ca_path"
					load_env_file
				fi
			elif (( ensure_status == 2 )); then
				info "Reusing existing systemd service ${service_name}.service."
				write_env_file "$port" "$token" "$tls_mode" "$cert_path" "$key_path" "$workspace_root" "$service_name" "$ca_path"
				load_env_file
			else
				warn "Skipping systemd unit creation."
				service_name=""
				write_env_file "$port" "$token" "$tls_mode" "$cert_path" "$key_path" "$workspace_root" "" "$ca_path"
				load_env_file
			fi
		else
			info "systemd setup skipped. Start manually with ./openvscode-server.sh --run-only"
		fi
	else
        warn "systemctl not found; skipping service creation."
    fi

    if prompt_yes_no "Start OpenVSCode Server now?"; then
        run_system_service
    else
        info "Skipping start. Run ./openvscode-server.sh run when ready."
    fi
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
	write_env_file "${OVS_PORT:-3000}" "$new_token" "${OVS_TLS_MODE:-none}" "${OVS_TLS_CERT:-}" "${OVS_TLS_KEY:-}" "$workspace" "${OVS_SYSTEMD_SERVICE_NAME:-}" "${OVS_TLS_CA:-}"
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
TLS CA             : ${OVS_TLS_CA:-}
Systemd service    : ${OVS_SYSTEMD_SERVICE_NAME:-<not set>}
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

cmd_service_start() {
	load_env_file
	run_system_service
}

cmd_service_stop() {
	load_env_file
	local service_name="${OVS_SYSTEMD_SERVICE_NAME:-}"
	if [[ -z "$service_name" ]]; then
		warn "No systemd service configured."
		return 1
	fi
	if ! systemd_ready; then
		warn "systemd not available; stop manually."
		return 1
	fi
	info "Stopping ${service_name}.service"
	systemctl_cmd stop "$service_name" >/dev/null 2>&1 || true
}

cmd_service_restart() {
	load_env_file
	local service_name="${OVS_SYSTEMD_SERVICE_NAME:-}"
	if [[ -z "$service_name" ]]; then
		warn "No systemd service configured."
		return 1
	fi
	if ! systemd_ready; then
		warn "systemd not available; restart manually."
		return 1
	fi
	info "Restarting ${service_name}.service"
	systemctl_cmd restart "$service_name" >/dev/null 2>&1 || true
}

cmd_service_status() {
	load_env_file
	local service_name="${OVS_SYSTEMD_SERVICE_NAME:-}"
	if [[ -z "$service_name" ]]; then
		warn "No systemd service configured."
		return 1
	fi
	if ! systemd_ready; then
		warn "systemd not available; check status manually."
		return 1
	fi
	systemctl_cmd status "$service_name" --no-pager || true
}

usage() {
cat <<EOF
Usage: $(basename "$SCRIPT_PATH") [options]
  (no args)          interactive mode: download, configure, run
  run                start configured service or run foreground server
  --run-only         start existing installation with current settings
  --download [URL]   download/update release (URL optional)
  --set-token TOKEN  update connection token in .env
  --status           show current configuration
  --service-start    start configured systemd service (or foreground server)
  --service-stop     stop configured systemd service
  --service-restart  restart systemd service
  --service-status   show systemd service status
  --help             show this help
EOF
}

main() {
	if [[ $# -eq 0 ]]; then
		interactive_setup
		return
	fi

	case "$1" in
		run)
			shift
			run_system_service
			;;
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
	--service-start)
		cmd_service_start
		;;
	--service-stop)
		cmd_service_stop
		;;
	--service-restart)
		cmd_service_restart
		;;
	--service-status)
		cmd_service_status
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
