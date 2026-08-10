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

# Pinned VMM binaries the launch helper may name in argv. Exempt from the
# artifact/worktree root check (they live under /usr/bin by design).
FC_PINNED_BINS="/usr/bin/firecracker /usr/bin/jailer"

fc_load_roots() {
  # Re-read every call so tests (and operators) can override via env after
  # sourcing this file.
  local conf="${AGENT_HUB_FC_ROOTS_CONF:-/etc/agent-hub/firecracker-roots.conf}"
  ARTIFACT_DIR="${ARTIFACT_DIR:-/var/lib/agent-hub/firecracker}"
  RUN_DIR="${RUN_DIR:-/var/lib/agent-hub/firecracker/vms}"
  JAILER_DIR="${JAILER_DIR:-/var/lib/agent-hub/firecracker/jailer}"
  WORKTREE_ROOTS="${WORKTREE_ROOTS:-/home/node/.agent-hub/workspaces:/var/lib/agent-hub/workspaces}"
  if [[ -f "${conf}" ]]; then
    # shellcheck disable=SC1090
    source "${conf}"
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

# Resolve symlinks in existing path components so a Hub-writable symlink under
# an allowed root cannot retarget /dev or other host paths.
fc_canonicalize() {
  local path=$1
  local dir base resolved_dir
  if [[ -e "$path" || -L "$path" ]]; then
    realpath "$path"
    return 0
  fi
  dir=$(dirname -- "$path")
  base=$(basename -- "$path")
  while [[ "$dir" != "/" && ! -e "$dir" && ! -L "$dir" ]]; do
    base="$(basename -- "$dir")/${base}"
    dir=$(dirname -- "$dir")
  done
  if [[ -e "$dir" || -L "$dir" ]]; then
    resolved_dir=$(realpath "$dir")
    printf '%s/%s\n' "${resolved_dir%/}" "$base"
  else
    printf '%s\n' "$path"
  fi
}

fc_canonical_root() {
  local root=$1
  if [[ -e "$root" || -L "$root" ]]; then
    realpath "$root"
  else
    # Root may not exist yet (fresh jailer dir); keep lexical form.
    printf '%s\n' "$root"
  fi
}

# $1=label $2=path $3...=root variable names (ARTIFACT_DIR, RUN_DIR, …) or
# literal paths. When no roots are passed, uses the default Firecracker set.
fc_assert_under_roots() {
  local label=$1 path=$2
  shift 2
  fc_assert_safe_abs_path "$label" "$path"
  fc_load_roots

  local canonical
  canonical=$(fc_canonicalize "$path")

  local roots=("$@")
  if [[ ${#roots[@]} -eq 0 ]]; then
    local IFS=':'
    # shellcheck disable=SC2206
    roots=(${ARTIFACT_DIR} ${RUN_DIR} ${JAILER_DIR} ${WORKTREE_ROOTS})
  fi

  local root crootraw croot
  for root in "${roots[@]}"; do
    [[ -n "$root" ]] || continue
    # Allow either a configured variable name or a literal path.
    case "$root" in
      ARTIFACT_DIR) crootraw=$ARTIFACT_DIR ;;
      RUN_DIR) crootraw=$RUN_DIR ;;
      JAILER_DIR) crootraw=$JAILER_DIR ;;
      WORKTREE_ROOTS)
        local wr
        local IFS=':'
        for wr in ${WORKTREE_ROOTS}; do
          [[ -n "$wr" ]] || continue
          croot=$(fc_canonical_root "$wr")
          if fc_path_under "$canonical" "$croot"; then
            return 0
          fi
        done
        continue
        ;;
      *) crootraw=$root ;;
    esac
    croot=$(fc_canonical_root "$crootraw")
    if fc_path_under "$canonical" "$croot"; then
      return 0
    fi
  done
  echo "fc-path-guard: $label outside configured Firecracker roots: $path (canonical: $canonical)" >&2
  echo "fc-path-guard: allowed prefixes: ARTIFACT_DIR=${ARTIFACT_DIR} RUN_DIR=${RUN_DIR} JAILER_DIR=${JAILER_DIR} WORKTREE_ROOTS=${WORKTREE_ROOTS}" >&2
  exit 2
}

# Reject any symlink in the path components (closes Hub-writable symlink
# retargets for inputs that will be opened as root).
fc_assert_no_symlink_components() {
  local label=$1 path=$2
  fc_assert_safe_abs_path "$label" "$path"
  local cur="" part
  local IFS='/'
  # shellcheck disable=SC2086
  set -- ${path#/}
  for part in "$@"; do
    [[ -n "$part" ]] || continue
    cur="${cur}/${part}"
    if [[ -L "$cur" ]]; then
      echo "fc-path-guard: $label contains symlink component: $cur" >&2
      exit 2
    fi
  done
}


# Writable disk/jail outputs must live under RUN_DIR / JAILER_DIR / ARTIFACT_DIR
# — never under a Hub-writable worktree (symlink escape surface).
fc_assert_output_under_roots() {
  fc_assert_under_roots "$1" "$2" RUN_DIR JAILER_DIR ARTIFACT_DIR
}

fc_assert_worktree_under_roots() {
  fc_assert_under_roots "$1" "$2" WORKTREE_ROOTS
}


# Validate every absolute-path token in "$@". Exact pinned VMM binaries are
# exempt (required for jailer --exec-file /usr/bin/firecracker).
fc_assert_argv_paths_under_roots() {
  local arg pinned
  for arg in "$@"; do
    if [[ "$arg" == /* ]]; then
      for pinned in ${FC_PINNED_BINS}; do
        if [[ "$arg" == "$pinned" ]]; then
          continue 2
        fi
      done
      fc_assert_under_roots 'argv path' "$arg"
    fi
  done
}
