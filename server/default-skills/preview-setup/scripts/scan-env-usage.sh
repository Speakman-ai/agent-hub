#!/usr/bin/env bash
# scan-env-usage.sh — emit deduped env-var keys read by source files
# under a project workspace.
#
# Usage:
#   scan-env-usage.sh <workspaceDir>
#
# Output:
#   One key per line, sorted, deduped. Empty output if nothing matches
#   or the directory is missing.
#
# Recognised patterns:
#   - process.env.FOO              (JS / TS)
#   - process.env['FOO']
#   - import.meta.env.VITE_FOO     (Vite)
#   - os.environ['FOO']            (Python)
#   - os.environ.get('FOO')
#   - ENV['FOO']                   (Ruby)
#   - ENV.fetch('FOO')
#   - os.Getenv("FOO")             (Go)
#
# Designed to be called by the preview-setup wizard skill. Kept small so
# the SKILL.md can shell out without dragging in a Node runtime.

# NOTE: we intentionally do NOT `set -e`/`set -o pipefail` — every grep
# stage below is allowed to return non-zero (no matches) without aborting
# the whole pipeline.
set -u

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  exit 0
fi

# Source-file globs we care about. Skip node_modules, .git, dist/build
# output, and vendored Python virtualenvs — those produce noise.
exclude=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=.next
  --exclude-dir=.nuxt
  --exclude-dir=__pycache__
  --exclude-dir=venv
  --exclude-dir=.venv
  --exclude-dir=.worktrees
  --exclude-dir=worktrees
)

include=(
  --include='*.js'
  --include='*.jsx'
  --include='*.ts'
  --include='*.tsx'
  --include='*.mjs'
  --include='*.cjs'
  --include='*.py'
  --include='*.rb'
  --include='*.go'
  --include='*.rs'
  --include='*.svelte'
  --include='*.vue'
  --include='*.astro'
)

# One sed pipeline per pattern; concat then dedupe at the end.
# `grep -hor` prints just the matches across the whole tree.
{
  # process.env.FOO and process.env['FOO'] / ["FOO"]
  grep -hor "${include[@]}" "${exclude[@]}" \
    -E "process\.env\.[A-Z_][A-Z0-9_]*" "$DIR" 2>/dev/null \
    | sed -E 's/^process\.env\.//'
  grep -hor "${include[@]}" "${exclude[@]}" \
    -E "process\.env\[['\"][A-Z_][A-Z0-9_]*['\"]\]" "$DIR" 2>/dev/null \
    | sed -E "s/^process\.env\[['\"]([A-Z_][A-Z0-9_]*)['\"]\]$/\1/"

  # import.meta.env.VITE_FOO
  grep -hor "${include[@]}" "${exclude[@]}" \
    -E "import\.meta\.env\.[A-Z_][A-Z0-9_]*" "$DIR" 2>/dev/null \
    | sed -E 's/^import\.meta\.env\.//'

  # os.environ['FOO'] / os.environ.get('FOO') / os.environ.get("FOO")
  grep -hor "${include[@]}" "${exclude[@]}" \
    -E "os\.environ(\[|\.get\()['\"][A-Z_][A-Z0-9_]*['\"]" "$DIR" 2>/dev/null \
    | sed -E "s/^os\.environ(\[|\.get\()['\"]([A-Z_][A-Z0-9_]*)['\"]/\2/"

  # ENV['FOO'] / ENV.fetch('FOO')
  grep -hor "${include[@]}" "${exclude[@]}" \
    -E "ENV(\[|\.fetch\()['\"][A-Z_][A-Z0-9_]*['\"]" "$DIR" 2>/dev/null \
    | sed -E "s/^ENV(\[|\.fetch\()['\"]([A-Z_][A-Z0-9_]*)['\"]/\2/"

  # os.Getenv("FOO") — Go
  grep -hor "${include[@]}" "${exclude[@]}" \
    -E 'os\.Getenv\("[A-Z_][A-Z0-9_]*"\)' "$DIR" 2>/dev/null \
    | sed -E 's/^os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)$/\1/'
} | LC_ALL=C sort -u
