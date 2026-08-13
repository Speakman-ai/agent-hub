#!/usr/bin/env bash
# Closed root helper for Firecracker host networking.
#
# The Hub never receives passwordless sudo for raw `ip` / `modprobe` /
# `sysctl` / `iptables`. All of those operations go through this script with a
# fixed bridge/subnet and a validated tap-name pattern.
#
#   fc-netctl.sh ensure-bridge
#   fc-netctl.sh ensure-nat
#   fc-netctl.sh reconcile          # bridge + nat + delete stale ahfct* taps
#   fc-netctl.sh tap-create <name>  # name must match ^ahfct[0-9]+$
#   fc-netctl.sh tap-delete <name>
#   fc-netctl.sh list-taps          # prints ahfct* names, one per line
#
# Config (optional /etc/agent-hub/firecracker-roots.conf):
#   BRIDGE BRIDGE_CIDR SUBNET GATEWAY_IP

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/fc-path-guard.sh" 2>/dev/null || true
if [[ -f /usr/local/lib/agent-hub/fc-path-guard.sh ]]; then
  # shellcheck disable=SC1091
  source /usr/local/lib/agent-hub/fc-path-guard.sh
fi

fc_load_net_conf() {
  BRIDGE="${BRIDGE:-ahfc0}"
  BRIDGE_CIDR="${BRIDGE_CIDR:-172.30.0.1/16}"
  SUBNET="${SUBNET:-172.30.0.0/16}"
  GATEWAY_IP="${GATEWAY_IP:-172.30.0.1}"
  if [[ -f "${FC_ROOTS_CONF:-/etc/agent-hub/firecracker-roots.conf}" ]]; then
    # shellcheck disable=SC1090
    source "${FC_ROOTS_CONF:-/etc/agent-hub/firecracker-roots.conf}"
  fi
}

assert_tap_name() {
  local name=$1
  if [[ ! "$name" =~ ^ahfct[0-9]+$ ]]; then
    echo "fc-netctl: refused tap name '$name' (must match ^ahfct[0-9]+\$)" >&2
    exit 2
  fi
}

cmd=${1:?command required}
shift || true
fc_load_net_conf

ensure_bridge() {
  ip link add "${BRIDGE}" type bridge 2>/dev/null || true
  ip addr add "${BRIDGE_CIDR}" dev "${BRIDGE}" 2>/dev/null || true
  ip link set "${BRIDGE}" up
}

parse_uplink() {
  local out
  out="$(ip -o route get 1.1.1.1 2>/dev/null || true)"
  if [[ "$out" =~ [[:space:]]dev[[:space:]]([^[:space:]]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

ensure_iptables_pair() {
  local -a check_argv=("$@")
  # Split on the sentinel --- into check vs add.
  local -a check=() add=()
  local side=check
  local a
  for a in "${check_argv[@]}"; do
    if [[ "$a" == '---' ]]; then
      side=add
      continue
    fi
    if [[ "$side" == check ]]; then
      check+=("$a")
    else
      add+=("$a")
    fi
  done
  if iptables "${check[@]}" >/dev/null 2>&1; then
    return 0
  fi
  iptables "${add[@]}"
}

ensure_nat() {
  local uplink
  uplink="$(parse_uplink)"
  if [[ -z "$uplink" ]]; then
    echo "fc-netctl: no uplink (ip route get 1.1.1.1 failed)" >&2
    return 1
  fi

  sysctl -qw net.ipv4.ip_forward=1

  # Guest isolation on the shared bridge requires br_netfilter.
  local modprobe_ok=0
  for bin in /usr/sbin/modprobe /sbin/modprobe modprobe; do
    if "$bin" br_netfilter 2>/dev/null; then
      modprobe_ok=1
      break
    fi
  done
  if [[ "$modprobe_ok" -eq 0 ]] && [[ ! -d /sys/module/br_netfilter ]]; then
    echo "fc-netctl: br_netfilter unavailable" >&2
    return 1
  fi
  sysctl -qw net.bridge.bridge-nf-call-iptables=1
  local verify
  verify="$(sysctl -n net.bridge.bridge-nf-call-iptables 2>/dev/null || true)"
  if [[ "$verify" != "1" ]]; then
    echo "fc-netctl: bridge-nf-call-iptables not enabled (got ${verify})" >&2
    return 1
  fi

  ensure_iptables_pair -C FORWARD -i "${BRIDGE}" -o "${BRIDGE}" -j DROP --- \
    -I FORWARD -i "${BRIDGE}" -o "${BRIDGE}" -j DROP
  ensure_iptables_pair -t nat -C POSTROUTING -s "${SUBNET}" -o "${uplink}" -j MASQUERADE --- \
    -t nat -A POSTROUTING -s "${SUBNET}" -o "${uplink}" -j MASQUERADE
  ensure_iptables_pair -C FORWARD -i "${BRIDGE}" -o "${uplink}" -j ACCEPT --- \
    -A FORWARD -i "${BRIDGE}" -o "${uplink}" -j ACCEPT
  ensure_iptables_pair -C FORWARD -i "${uplink}" -o "${BRIDGE}" -m state --state RELATED,ESTABLISHED -j ACCEPT --- \
    -A FORWARD -i "${uplink}" -o "${BRIDGE}" -m state --state RELATED,ESTABLISHED -j ACCEPT

  # DOCKER-USER is best-effort (absent when Docker is not installed).
  ensure_iptables_pair -C DOCKER-USER -i "${BRIDGE}" -o "${uplink}" -j ACCEPT --- \
    -I DOCKER-USER -i "${BRIDGE}" -o "${uplink}" -j ACCEPT 2>/dev/null || true
  ensure_iptables_pair -C DOCKER-USER -i "${uplink}" -o "${BRIDGE}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT --- \
    -I DOCKER-USER -i "${uplink}" -o "${BRIDGE}" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
}

list_taps() {
  local line name
  while IFS= read -r line; do
    if [[ "$line" =~ ^[0-9]+:[[:space:]]+([^:@[:space:]]+) ]]; then
      name="${BASH_REMATCH[1]}"
      if [[ "$name" =~ ^ahfct[0-9]+$ ]]; then
        printf '%s\n' "$name"
      fi
    fi
  done < <(ip -o link show)
}

case "$cmd" in
  ensure-bridge)
    ensure_bridge
    ;;
  ensure-nat)
    ensure_nat
    ;;
  reconcile)
    ensure_bridge
    ensure_nat
    while IFS= read -r tap; do
      [[ -n "$tap" ]] || continue
      ip link del "$tap" || true
    done < <(list_taps)
    ;;
  tap-create)
    name=${1:?tap name required}
    assert_tap_name "$name"
    ip tuntap add "$name" mode tap
    ip link set "$name" master "${BRIDGE}"
    ip link set "$name" up
    ;;
  tap-delete)
    name=${1:?tap name required}
    assert_tap_name "$name"
    ip link del "$name"
    ;;
  list-taps)
    list_taps
    ;;
  *)
    echo "fc-netctl: unknown command: $cmd" >&2
    exit 2
    ;;
esac
