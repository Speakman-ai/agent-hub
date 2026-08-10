#!/usr/bin/env bash
# Shared path allowlist for Firecracker root helpers.
#
# Sourced by fc-prepare-disks / fc-jail-manage / fc-launch-vmm. Paths the Hub
# passes must resolve under a fixed configured root — never arbitrary host
# locations chosen by a compromised agent process.
#
# Config file (written by ops/scripts/setup-firecracker-host.sh):
#   /etc/agent-hub/firecracker-roots.conf
# Keys: ARTIFACT_DIR RUN_DIR JAILER_DIR WORKTREE_ROOTS (colon-separated)

FC_ROOTS_CONF="${AGENT_HUB_FC_ROOTS_CONF:-/etc/agent-hub/firecracker-roots.conf}"

fc_load_roots() {
  ARTIFACT_DIR="${ARTIFACT_DIR:-/var/lib/agent-hub/firecracker}"
  RUN_DIR="${RUN_DIR:-/var/lib/agent-hub/firecracker/vms}"
  JAILER_DIR="${JAILER_DIR:-/var/lib/agent-hub/firecracker/jailer}"
  WORKTREE_ROOTS="${WORKTREE_ROOTS:-/home/node/.agent-hub/workspaces:/var/lib/agent-hub/workspaces}"
  if [[ -f "${FC_ROOTS_CONF}" ]]; then
    # shellcheck disable=SC1090
    source "${FC_ROOTS_CONF}"
  fi
}

fc_assert_safe_abs_path() {
  local label=$1 path=$2
  if [[ -z "$path" || "$path" != /* ]]; then
    echo "fc-path-guard: $label must be an absolute path: ${path:-"(empty)"}" >&2
    exit 2
  fi
  case "$path" in
    *..*|*$'\n'*|*$'\r'*|*' '*)
      echo "fc-path-guard: refused unclean path ($label): $path" >&2
      exit 2
      ;;
  esac
}

# True when $1 is exactly $2 or a descendant of $2/.
fc_path_under() {
  local path=$1 root=$2
  [[ "$path" == "$root" || "$path" == "$root"/* ]]
}

fc_assert_under_roots() {
  local label=$1 path=$2
  fc_assert_safe_abs_path "$label" "$path"
  fc_load_roots
  local root
  local IFS=':'
  # shellcheck disable=SC2086
  for root in ${ARTIFACT_DIR} ${RUN_DIR} ${JAILER_DIR} ${WORKTREE_ROOTS}; do
    [[ -n "$root" ]] || continue
    if fc_path_under "$path" "$root"; then
      return 0
    fi
  done
  echo "fc-path-guard: $label outside configured Firecracker roots: $path" >&2
  echo "fc-path-guard: allowed prefixes: ARTIFACT_DIR=${ARTIFACT_DIR} RUN_DIR=${RUN_DIR} JAILER_DIR=${JAILER_DIR} WORKTREE_ROOTS=${WORKTREE_ROOTS}" >&2
  exit 2
}

# Validate every absolute-path token in "$@".
fc_assert_argv_paths_under_roots() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" == /* ]]; then
      fc_assert_under_roots 'argv path' "$arg"
    fi
  done
}
