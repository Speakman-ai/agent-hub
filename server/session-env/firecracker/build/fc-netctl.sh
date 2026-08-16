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

# Refuse to claim ${SUBNET} when another route overlaps it. Deleting an
# address here would silently disconnect a live Docker, VPN, or host network;
# only that network's owner can safely reconfigure it.
#
# Docker's default address pools freely allocate 172.16.0.0/12. A compose
# network that lands on our SUBNET (observed: st-consent-net → 172.30.0.0/16)
# steals the kernel route from ahfc0 — guest pings blackhole and CLIs fail
# with "Unable to connect to API (ENOTIMP)".
ipv4_to_uint() {
  local ip=$1
  if [[ ! "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    return 1
  fi
  local a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  if ((10#$a > 255 || 10#$b > 255 || 10#$c > 255 || 10#$d > 255)); then
    return 1
  fi
  printf '%u' "$(((10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d))"
}

cidr_overlaps() {
  local left=$1 right=$2
  local left_ip left_prefix right_ip right_prefix
  if [[ "$left" == */* ]]; then
    left_ip=${left%/*}
    left_prefix=${left#*/}
  else
    left_ip=$left
    left_prefix=32
  fi
  if [[ "$right" == */* ]]; then
    right_ip=${right%/*}
    right_prefix=${right#*/}
  else
    right_ip=$right
    right_prefix=32
  fi
  if [[ ! "$left_prefix" =~ ^[0-9]+$ || ! "$right_prefix" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if ((10#$left_prefix > 32 || 10#$right_prefix > 32)); then
    return 1
  fi

  local left_uint right_uint
  left_uint=$(ipv4_to_uint "$left_ip") || return 1
  right_uint=$(ipv4_to_uint "$right_ip") || return 1
  local all=$((0xFFFFFFFF)) left_mask=0 right_mask=0
  if ((10#$left_prefix > 0)); then
    left_mask=$(((all << (32 - 10#$left_prefix)) & all))
  fi
  if ((10#$right_prefix > 0)); then
    right_mask=$(((all << (32 - 10#$right_prefix)) & all))
  fi
  local left_start=$((left_uint & left_mask))
  local left_end=$((left_start | (all ^ left_mask)))
  local right_start=$((right_uint & right_mask))
  local right_end=$((right_start | (all ^ right_mask)))
  ((left_start <= right_end && right_start <= left_end))
}

refuse_conflicting_subnet_routes() {
  local routes
  if ! routes="$(ip -o -4 route show table all 2>/dev/null)"; then
    echo "fc-netctl: could not inspect IPv4 routes before reserving ${SUBNET}; refusing to modify the Firecracker bridge or NAT. Verify iproute2 permissions and retry." >&2
    return 1
  fi

  local line prefix iface owner descriptor conflict_list=''
  local -a conflicts=()
  local -A seen=()
  local -a fields=()
  local i
  while IFS= read -r line; do
    read -r -a fields <<< "$line"
    [[ "${#fields[@]}" -gt 0 ]] || continue
    prefix=${fields[0]}
    case "$prefix" in
      default)
        continue
        ;;
      local | broadcast | multicast | unreachable | prohibit | blackhole | throw | nat | anycast)
        prefix=${fields[1]:-}
        ;;
    esac
    # A default route is expected and does not conflict with a more-specific
    # Firecracker route. Ignore either spelling of it.
    [[ "$prefix" != '0.0.0.0/0' ]] || continue
    iface=''
    for ((i = 0; i + 1 < ${#fields[@]}; i++)); do
      if [[ "${fields[$i]}" == dev ]]; then
        iface=${fields[$((i + 1))]}
        break
      fi
    done
    [[ "$iface" != "$BRIDGE" ]] || continue
    cidr_overlaps "$prefix" "$SUBNET" || continue
    owner=${iface:-${fields[0]}}
    descriptor="${prefix} via ${owner}"
    [[ -z "${seen[$descriptor]:-}" ]] || continue
    seen[$descriptor]=1
    conflicts+=("$descriptor")
  done <<< "$routes"

  if [[ "${#conflicts[@]}" -gt 0 ]]; then
    for descriptor in "${conflicts[@]}"; do
      conflict_list+="${conflict_list:+; }${descriptor}"
    done
    echo "fc-netctl: reserved Firecracker subnet ${SUBNET} overlaps existing route(s): ${conflict_list}; refusing to disrupt a live network. Stop or reconfigure the owning Docker/VPN/host network, then retry." >&2
    return 1
  fi
}

ensure_bridge() {
  refuse_conflicting_subnet_routes
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
  # Refuse conflicts before wiring NAT so the existing network is untouched.
  refuse_conflicting_subnet_routes
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
