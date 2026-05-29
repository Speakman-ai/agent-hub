#!/usr/bin/env bash
# scan-ci-signals.sh — emit a one-shot JSON summary of CI-relevant
# signal in a project directory: existing ci.yaml, GitHub workflows,
# Makefile targets, package.json scripts, and obvious test runners.
#
# Usage:
#   scan-ci-signals.sh <workspaceDir>
#
# Output (stdout, JSON, single line):
#   {
#     "existingCi": true|false,
#     "githubWorkflows": ["ci.yml", ...],
#     "makefileTargets": ["test", "lint", ...],
#     "manifests": { "package.json": true, "pyproject.toml": false, ... },
#     "scripts": { "test": "vitest", "lint": "eslint .", ... }
#   }
#
# Designed to be called by the finalize-setup wizard skill so it does
# not need to shell out to Node just to grok the repo layout.

set -u

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo '{"existingCi":false,"githubWorkflows":[],"makefileTargets":[],"manifests":{},"scripts":{}}'
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo '{"existingCi":false,"githubWorkflows":[],"makefileTargets":[],"manifests":{},"scripts":{}}'
  exit 0
fi

WORKSPACE_DIR="$DIR" node --input-type=module - <<'NODE_EOF'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import path from 'path';

const dir = process.env.WORKSPACE_DIR;

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function safeReadFile(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Existing ci.yaml under .agent-hub/?
const existingCi = existsSync(path.join(dir, '.agent-hub', 'ci.yaml'));

// .github/workflows/*.yml — name-only
const workflowsDir = path.join(dir, '.github', 'workflows');
const githubWorkflows = safeReaddir(workflowsDir)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

// Makefile target names (lines like "target:" at column 0)
const makefileTargets = [];
const makefileTxt = safeReadFile(path.join(dir, 'Makefile'));
if (makefileTxt) {
  const lines = makefileTxt.split(/\r?\n/);
  const seen = new Set();
  for (const line of lines) {
    const m = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
    if (!m) continue;
    const target = m[1];
    if (target.startsWith('.')) continue; // .PHONY etc
    if (!seen.has(target)) {
      seen.add(target);
      makefileTargets.push(target);
    }
  }
}

// Manifest presence (one indicator per stack)
const manifests = {
  'package.json': existsSync(path.join(dir, 'package.json')),
  'pyproject.toml': existsSync(path.join(dir, 'pyproject.toml')),
  'requirements.txt': existsSync(path.join(dir, 'requirements.txt')),
  'Cargo.toml': existsSync(path.join(dir, 'Cargo.toml')),
  'go.mod': existsSync(path.join(dir, 'go.mod')),
  'Gemfile': existsSync(path.join(dir, 'Gemfile')),
  'pnpm-lock.yaml': existsSync(path.join(dir, 'pnpm-lock.yaml')),
  'yarn.lock': existsSync(path.join(dir, 'yarn.lock')),
  'package-lock.json': existsSync(path.join(dir, 'package-lock.json')),
  'poetry.lock': existsSync(path.join(dir, 'poetry.lock')),
};

// Top-level package.json scripts (full body — caller decides which to surface)
let scripts = {};
const pkgTxt = safeReadFile(path.join(dir, 'package.json'));
if (pkgTxt) {
  try {
    const pkg = JSON.parse(pkgTxt);
    if (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object') {
      for (const [name, body] of Object.entries(pkg.scripts)) {
        if (typeof body === 'string') scripts[name] = body;
      }
    }
  } catch {
    // ignore — malformed package.json is the user's problem, not ours
  }
}

process.stdout.write(
  JSON.stringify({
    existingCi,
    githubWorkflows,
    makefileTargets,
    manifests,
    scripts,
  }),
);
NODE_EOF
