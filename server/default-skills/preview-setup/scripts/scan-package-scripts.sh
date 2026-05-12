#!/usr/bin/env bash
# scan-package-scripts.sh — emit candidate dev-server start scripts from
# a project's package.json (top-level + apps/* + frontend/ + client/).
#
# Usage:
#   scan-package-scripts.sh <workspaceDir>
#
# Output, one per line:
#   <cwd-relative-path>::<scriptName>::<scriptBody>
#
# Designed for the preview-setup wizard skill so it can offer the user a
# short list of plausible candidates rather than asking them to type in
# the right invocation from scratch.

set -euo pipefail

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  exit 0
fi

# Prefer Node's JSON parser to a regex pipeline — it's the only thing
# that handles escaped quotes and multi-line script bodies reliably.
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

# Candidate package.json locations, in priority order. The wizard cares
# about start/dev-shaped scripts in any of them; one project may have
# multiple (root + apps/web).
candidates=(
  "package.json"
  "frontend/package.json"
  "client/package.json"
  "apps/web/package.json"
  "apps/api/package.json"
)

# Build a JSON array of {path, scripts} for each existing candidate.
files_json="["
first=1
for c in "${candidates[@]}"; do
  full="$DIR/$c"
  if [[ -f "$full" ]]; then
    [[ $first -eq 1 ]] || files_json+=","
    files_json+="\"$c\""
    first=0
  fi
done
files_json+="]"

PKG_DIR="$DIR" PKG_FILES="$files_json" node --input-type=module - <<'NODE_EOF'
import { readFileSync } from 'fs';
import path from 'path';

const root = process.env.PKG_DIR;
const files = JSON.parse(process.env.PKG_FILES);

// Script names that typically boot a dev server. We surface every match
// (not just the first) so a project with both `dev` and `start:web`
// shows both rows in the wizard picker.
const SHAPES = [
  /^dev$/,
  /^dev:.+/,
  /^start$/,
  /^start:.+/,
  /^serve$/,
  /^web$/,
];

const out = [];
for (const rel of files) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    continue;
  }
  const scripts = pkg && typeof pkg === 'object' ? pkg.scripts : null;
  if (!scripts || typeof scripts !== 'object') continue;
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    if (!SHAPES.some((re) => re.test(name))) continue;
    // The `cwd` is the directory containing the package.json, expressed
    // relative to the workspace root. Root package.json → "." sentinel.
    const cwd = path.dirname(rel) || '.';
    out.push(`${cwd}::${name}::${body}`);
  }
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
NODE_EOF
