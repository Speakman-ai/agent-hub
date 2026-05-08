#!/usr/bin/env bash
# scripts/gh-release.sh — releases, gists, and Actions workflow-run operations.
#
# Usage:
#   # Releases
#   gh-release.sh create   --tag <tag> [--title <title>] [--notes <text>]
#                          [--draft] [--prerelease] [--target <branch|sha>]
#                          [--asset <file>]
#   gh-release.sh list     [--limit <n>]
#   gh-release.sh view     <tag>
#   gh-release.sh download <tag> [--dir <path>] [--pattern <glob>]
#   gh-release.sh delete   <tag> [--yes]
#
#   # Gists
#   gh-release.sh gist-create  <file> [--desc <text>] [--public]
#   gh-release.sh gist-list    [--limit <n>]
#   gh-release.sh gist-view    <id|URL>
#
#   # Workflow runs (GitHub Actions)
#   gh-release.sh run-list    [--workflow <filename>] [--branch <branch>]
#                             [--status success|failure|in_progress|…] [--limit <n>]
#   gh-release.sh run-view    <run-id>
#   gh-release.sh run-logs    <run-id>
#   gh-release.sh run-rerun   <run-id> [--failed]
#   gh-release.sh run-cancel  <run-id>
#   gh-release.sh workflow-list  # list workflows in the repo
#   gh-release.sh workflow-run   --workflow <filename> [--ref <branch>]
#                                [--field key=value]…

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_common.sh"

# ---------------------------------------------------------------------------
# release create
# ---------------------------------------------------------------------------
cmd_release_create() {
  local tag="" title="" notes="" draft=false prerelease=false target="" asset=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag)        tag="$2";        shift 2 ;;
      --title)      title="$2";      shift 2 ;;
      --notes)      notes="$2";      shift 2 ;;
      --draft)      draft=true;      shift   ;;
      --prerelease) prerelease=true; shift   ;;
      --target)     target="$2";     shift 2 ;;
      --asset)      asset="$2";      shift 2 ;;
      *) gh_die "release create: unknown flag '$1'" ;;
    esac
  done
  _require_arg "--tag" "$tag"

  require_gh_token

  local args=(release create "$tag")
  [[ -n "$title" ]]         && args+=(--title "$title")
  [[ -n "$notes" ]]         && args+=(--notes "$notes")
  [[ "$draft" == true ]]      && args+=(--draft)
  [[ "$prerelease" == true ]] && args+=(--prerelease)
  [[ -n "$target" ]]        && args+=(--target "$target")
  [[ -n "$asset" ]]         && args+=("$asset")

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# release list
# ---------------------------------------------------------------------------
cmd_release_list() {
  local limit=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) gh_die "release list: unknown flag '$1'" ;;
    esac
  done

  require_gh_token
  gh release list --limit "$limit"
}

# ---------------------------------------------------------------------------
# release view
# ---------------------------------------------------------------------------
cmd_release_view() {
  [[ $# -lt 1 ]] && gh_die "release view <tag>"
  require_gh_token
  gh release view "$1"
}

# ---------------------------------------------------------------------------
# release download
# ---------------------------------------------------------------------------
cmd_release_download() {
  [[ $# -lt 1 ]] && gh_die "release download <tag> [--dir <path>] [--pattern <glob>]"
  local tag="$1"; shift
  local dir="" pattern=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir)     dir="$2";     shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      *) gh_die "release download: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  local args=(release download "$tag")
  [[ -n "$dir" ]]     && args+=(--dir "$dir")
  [[ -n "$pattern" ]] && args+=(--pattern "$pattern")

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# release delete
# ---------------------------------------------------------------------------
cmd_release_delete() {
  [[ $# -lt 1 ]] && gh_die "release delete <tag> [--yes]"
  local tag="$1"; shift
  local yes=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) yes=true; shift ;;
      *) gh_die "release delete: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  if [[ "$yes" == true ]]; then
    gh release delete "$tag" --yes
  else
    gh release delete "$tag"
  fi
  echo "Release $tag deleted"
}

# ---------------------------------------------------------------------------
# gist create
# ---------------------------------------------------------------------------
cmd_gist_create() {
  [[ $# -lt 1 ]] && gh_die "gist-create <file> [--desc <text>] [--public]"
  local file="$1"; shift
  local desc="" public=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --desc)   desc="$2";   shift 2 ;;
      --public) public=true; shift   ;;
      *) gh_die "gist-create: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  local args=(gist create "$file")
  [[ -n "$desc" ]]        && args+=(--desc "$desc")
  [[ "$public" == true ]] && args+=(--public)

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# gist list
# ---------------------------------------------------------------------------
cmd_gist_list() {
  local limit=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) gh_die "gist-list: unknown flag '$1'" ;;
    esac
  done

  require_gh_token
  gh gist list --limit "$limit"
}

# ---------------------------------------------------------------------------
# gist view
# ---------------------------------------------------------------------------
cmd_gist_view() {
  [[ $# -lt 1 ]] && gh_die "gist-view <id|URL>"
  require_gh_token
  gh gist view "$1"
}

# ---------------------------------------------------------------------------
# run list
# ---------------------------------------------------------------------------
cmd_run_list() {
  local workflow="" branch="" status="" limit=10
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --workflow) workflow="$2"; shift 2 ;;
      --branch)   branch="$2";   shift 2 ;;
      --status)   status="$2";   shift 2 ;;
      --limit)    limit="$2";    shift 2 ;;
      *) gh_die "run-list: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  local args=(run list --limit "$limit")
  [[ -n "$workflow" ]] && args+=(--workflow "$workflow")
  [[ -n "$branch" ]]   && args+=(--branch "$branch")
  [[ -n "$status" ]]   && args+=(--status "$status")

  gh "${args[@]}"
}

# ---------------------------------------------------------------------------
# run view
# ---------------------------------------------------------------------------
cmd_run_view() {
  [[ $# -lt 1 ]] && gh_die "run-view <run-id>"
  require_gh_token
  gh run view "$1"
}

# ---------------------------------------------------------------------------
# run logs
# ---------------------------------------------------------------------------
cmd_run_logs() {
  [[ $# -lt 1 ]] && gh_die "run-logs <run-id>"
  require_gh_token
  gh run view "$1" --log
}

# ---------------------------------------------------------------------------
# run rerun
# ---------------------------------------------------------------------------
cmd_run_rerun() {
  [[ $# -lt 1 ]] && gh_die "run-rerun <run-id> [--failed]"
  local run_id="$1"; shift
  local failed=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --failed) failed=true; shift ;;
      *) gh_die "run-rerun: unknown flag '$1'" ;;
    esac
  done

  require_gh_token

  if [[ "$failed" == true ]]; then
    gh run rerun "$run_id" --failed
  else
    gh run rerun "$run_id"
  fi
  echo "Re-queued run $run_id"
}

# ---------------------------------------------------------------------------
# run cancel
# ---------------------------------------------------------------------------
cmd_run_cancel() {
  [[ $# -lt 1 ]] && gh_die "run-cancel <run-id>"
  require_gh_token
  gh run cancel "$1"
  echo "Cancelled run $1"
}

# ---------------------------------------------------------------------------
# workflow list
# ---------------------------------------------------------------------------
cmd_workflow_list() {
  require_gh_token
  gh workflow list
}

# ---------------------------------------------------------------------------
# workflow run
# ---------------------------------------------------------------------------
cmd_workflow_run() {
  local workflow="" ref="" fields=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --workflow) workflow="$2"; shift 2 ;;
      --ref)      ref="$2";      shift 2 ;;
      --field)    fields+=("$2"); shift 2 ;;
      *) gh_die "workflow-run: unknown flag '$1'" ;;
    esac
  done
  _require_arg "--workflow" "$workflow"

  require_gh_token

  local args=(workflow run "$workflow")
  [[ -n "$ref" ]] && args+=(--ref "$ref")
  for f in "${fields[@]}"; do
    args+=(-f "$f")
  done

  gh "${args[@]}"
  echo "Workflow '$workflow' dispatched"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
SUBCOMMAND="${1:-}"
shift || true

case "$SUBCOMMAND" in
  create)        cmd_release_create   "$@" ;;
  list)          cmd_release_list     "$@" ;;
  view)          cmd_release_view     "$@" ;;
  download)      cmd_release_download "$@" ;;
  delete)        cmd_release_delete   "$@" ;;
  gist-create)   cmd_gist_create      "$@" ;;
  gist-list)     cmd_gist_list        "$@" ;;
  gist-view)     cmd_gist_view        "$@" ;;
  run-list)      cmd_run_list         "$@" ;;
  run-view)      cmd_run_view         "$@" ;;
  run-logs)      cmd_run_logs         "$@" ;;
  run-rerun)     cmd_run_rerun        "$@" ;;
  run-cancel)    cmd_run_cancel       "$@" ;;
  workflow-list) cmd_workflow_list    "$@" ;;
  workflow-run)  cmd_workflow_run     "$@" ;;
  *)
    cat >&2 <<USAGE
Usage: gh-release.sh <subcommand> [options]

Release subcommands:
  create    --tag <tag> [--title <title>] [--notes <text>] [--draft]
            [--prerelease] [--target <branch>] [--asset <file>]
  list      [--limit <n>]
  view      <tag>
  download  <tag> [--dir <path>] [--pattern <glob>]
  delete    <tag> [--yes]

Gist subcommands:
  gist-create  <file> [--desc <text>] [--public]
  gist-list    [--limit <n>]
  gist-view    <id|URL>

Workflow-run subcommands:
  run-list      [--workflow <file>] [--branch <branch>] [--status <status>] [--limit <n>]
  run-view      <run-id>
  run-logs      <run-id>
  run-rerun     <run-id> [--failed]
  run-cancel    <run-id>
  workflow-list
  workflow-run  --workflow <file> [--ref <branch>] [--field key=value]…

Examples:
  gh-release.sh create --tag v1.2.0 --title "v1.2.0" --notes "Bug fixes."
  gh-release.sh run-list --workflow ci.yml --status failure
  gh-release.sh run-rerun 12345678 --failed
  gh-release.sh gist-create output.txt --desc "build output" --public
USAGE
    exit 2
    ;;
esac
