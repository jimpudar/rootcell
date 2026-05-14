#!/usr/bin/env bash
set -euo pipefail

SOCKET_VMNET="/opt/socket_vmnet/bin/socket_vmnet"
ROOT="/private/var/run/rootcell"
runtime_dir=""
socket_path=""
pid_path=""
log_path=""

usage() {
  echo "usage: rootcell-vmnet {start INSTANCE UUID|status INSTANCE|stop INSTANCE}" >&2
}

die() {
  echo "rootcell-vmnet: $*" >&2
  exit 2
}

validate_instance() {
  local name="$1"
  [[ "$name" =~ ^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$ ]] || die "invalid instance name: $name"
}

validate_uuid() {
  local uuid="$1"
  [[ "$uuid" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$ ]] || die "invalid UUID: $uuid"
}

sudo_uid() {
  [[ "${SUDO_UID:-}" =~ ^[0-9]+$ ]] || die "must be run through sudo with SUDO_UID set"
  echo "$SUDO_UID"
}

paths_for() {
  local instance="$1"
  local uid
  uid="$(sudo_uid)"
  runtime_dir="$ROOT/$uid"
  socket_path="$runtime_dir/$instance.sock"
  pid_path="$runtime_dir/$instance.pid"
  log_path="$runtime_dir/$instance.log"
}

pid_matches() {
  local pid="$1"
  local socket="$2"
  local command
  command="$(ps -ww -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$SOCKET_VMNET"* && "$command" == *"$socket"* ]]
}

running_pid() {
  local pid=""
  if [[ -f "$pid_path" ]]; then
    pid="$(tr -d '[:space:]' < "$pid_path")"
  fi
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && pid_matches "$pid" "$socket_path"; then
    echo "$pid"
    return 0
  fi
  return 1
}

cleanup_stale() {
  local pid=""
  if [[ -f "$pid_path" ]]; then
    pid="$(tr -d '[:space:]' < "$pid_path")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      if pid_matches "$pid" "$socket_path"; then
        die "socket_vmnet is running but the socket is not ready: $pid"
      fi
      die "pidfile points at an unexpected process: $pid"
    fi
  fi
  rm -f "$pid_path" "$socket_path"
}

start_instance() {
  local instance="$1"
  local uuid="$2"
  validate_instance "$instance"
  validate_uuid "$uuid"
  paths_for "$instance"
  install -d -m 0755 "$ROOT" "$runtime_dir"
  if running_pid >/dev/null; then
    if [[ -S "$socket_path" ]]; then
      exit 0
    fi
    die "socket_vmnet is running but the socket is not ready"
  fi
  cleanup_stale
  nohup "$SOCKET_VMNET" \
    --vmnet-mode=host \
    --vmnet-network-identifier="$uuid" \
    --pidfile="$pid_path" \
    "$socket_path" \
    >"$log_path" 2>&1 &

  for _ in $(seq 1 50); do
    if running_pid >/dev/null && [[ -S "$socket_path" ]]; then
      exit 0
    fi
    sleep 0.1
  done

  echo "rootcell-vmnet: socket_vmnet did not become ready" >&2
  if [[ -f "$log_path" ]]; then
    tail -n 40 "$log_path" >&2 || true
  fi
  exit 1
}

status_instance() {
  local instance="$1"
  validate_instance "$instance"
  paths_for "$instance"
  if running_pid >/dev/null && [[ -S "$socket_path" ]]; then
    echo "running"
    exit 0
  fi
  echo "stopped"
  exit 1
}

stop_instance() {
  local instance="$1"
  local pid
  validate_instance "$instance"
  paths_for "$instance"
  if pid="$(running_pid)"; then
    kill "$pid"
    for _ in $(seq 1 50); do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pid_path" "$socket_path"
        exit 0
      fi
      sleep 0.1
    done
    die "socket_vmnet did not stop: $pid"
  fi
  cleanup_stale
}

command="${1:-}"
case "$command" in
  start)
    [[ "$#" -eq 3 ]] || { usage; exit 2; }
    start_instance "$2" "$3"
    ;;
  status)
    [[ "$#" -eq 2 ]] || { usage; exit 2; }
    status_instance "$2"
    ;;
  stop)
    [[ "$#" -eq 2 ]] || { usage; exit 2; }
    stop_instance "$2"
    ;;
  *)
    usage
    exit 2
    ;;
esac
