// Skill-freeze coupling check.
//
// Enforces that any PR touching a "platform module" (see
// `.github/skill-coupling.yml`) also touches the agent-hub skill doc, unless
// the `skill-freeze-override` label is present.
//
// Exports a pure `evaluateCoupling({ changedFiles, labels, config })` that
// returns `{ ok, reason, matchedCoupled, matchedDoc, overrideUsed }` so the
// rule can be unit-tested without spawning a subprocess.
//
// When invoked directly (`node skill-coupling.mjs`) it reads:
//   - `CHANGED_FILES_PATH`  newline-separated list of paths, or
//   - `CHANGED_FILES`       newline-separated list inline
//   - `PR_LABELS`           comma-separated list of PR labels
//   - `SKILL_COUPLING_CONFIG`  optional path override (default: ../skill-coupling.yml)
// and exits 0 on pass, 1 on fail.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Minimal YAML parser covering the shape of `.github/skill-coupling.yml`:
 *   - top-level scalar strings
 *   - top-level string lists (`- item` entries)
 *   - comments (`#`)
 *   - blank lines
 * Anything more exotic is not supported on purpose — keeping zero deps so the
 * CI check has no install step.
 */
export function parseCouplingYaml(text) {
  const out = {};
  let currentList = null;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    // Strip comments (only whole-line or trailing; # inside quoted strings
    // is not in our config shape so we don't need to handle it)
    const hashIdx = rawLine.indexOf('#');
    const line = hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine;
    if (!line.trim()) continue;

    // List item
    const listMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(listMatch[1]));
      continue;
    }

    // Top-level key (scalar or list start)
    const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)\s*$/);
    if (keyMatch) {
      const [, key, value] = keyMatch;
      if (value.trim() === '') {
        currentList = [];
        out[key] = currentList;
      } else {
        currentList = null;
        out[key] = stripQuotes(value.trim());
      }
      continue;
    }
  }

  return out;
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Convert a glob pattern into a RegExp.
 * Supports `**` (any path segments including slashes), `*` (any chars except
 * `/`), and literal path characters. Anchored to the full string.
 */
export function globToRegex(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      // consume optional trailing slash in `**/` → still `.*`
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchesAny(filePath, patterns) {
  return patterns.some((p) => globToRegex(p).test(filePath));
}

/**
 * Core rule evaluator — pure, deterministic, testable.
 *
 * @param {object} opts
 * @param {string[]} opts.changedFiles - paths changed by the PR
 * @param {string[]} opts.labels - PR label names
 * @param {{coupled_paths: string[], skill_doc_paths: string[], override_label: string}} opts.config
 * @returns {{ok: boolean, reason: string, matchedCoupled: string[], matchedDoc: string[], overrideUsed: boolean}}
 */
export function evaluateCoupling({ changedFiles, labels, config }) {
  const coupled = config.coupled_paths || [];
  const docs = config.skill_doc_paths || [];
  const overrideLabel = config.override_label;

  const matchedCoupled = changedFiles.filter((f) => matchesAny(f, coupled));
  const matchedDoc = changedFiles.filter((f) => matchesAny(f, docs));
  const overrideUsed = Boolean(overrideLabel && labels.includes(overrideLabel));

  // No platform-module file changed → rule doesn't apply.
  if (matchedCoupled.length === 0) {
    return {
      ok: true,
      reason: 'no-coupled-files-changed',
      matchedCoupled,
      matchedDoc,
      overrideUsed,
    };
  }

  // Skill doc was also updated → satisfied.
  if (matchedDoc.length > 0) {
    return {
      ok: true,
      reason: 'skill-doc-touched',
      matchedCoupled,
      matchedDoc,
      overrideUsed,
    };
  }

  // Emergency escape hatch.
  if (overrideUsed) {
    return {
      ok: true,
      reason: 'override-label-present',
      matchedCoupled,
      matchedDoc,
      overrideUsed,
    };
  }

  return {
    ok: false,
    reason: 'coupled-change-without-skill-update',
    matchedCoupled,
    matchedDoc,
    overrideUsed,
  };
}

export function formatFailureMessage(result, config) {
  const lines = [];
  lines.push('❌ Skill-freeze coupling check failed.');
  lines.push('');
  lines.push('The following platform-module files changed in this PR:');
  for (const f of result.matchedCoupled) lines.push(`  • ${f}`);
  lines.push('');
  lines.push(
    'These modules drive agent-facing behavior (coordination protocols, auth,',
  );
  lines.push(
    'auto-behavior). The `agent-hub` SKILL.md must be kept in sync so that',
  );
  lines.push('agents reading the doc get an accurate mental model.');
  lines.push('');
  lines.push('To pass this check, do ONE of the following:');
  lines.push('');
  lines.push('  1. Update the skill doc — touch any of:');
  for (const p of config.skill_doc_paths || []) lines.push(`     • ${p}`);
  lines.push('');
  lines.push(
    `  2. Add the \`${config.override_label}\` label to this PR (emergency only).`,
  );
  lines.push('');
  lines.push(
    'The coupling rule is defined in `.github/skill-coupling.yml`.',
  );
  return lines.join('\n');
}

function readChangedFiles() {
  const fromPath = process.env.CHANGED_FILES_PATH;
  if (fromPath && existsSync(fromPath)) {
    return readFileSync(fromPath, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const inline = process.env.CHANGED_FILES;
  if (inline) {
    return inline
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function readLabels() {
  const raw = process.env.PR_LABELS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig() {
  const override = process.env.SKILL_COUPLING_CONFIG;
  const configPath = override
    ? path.resolve(override)
    : path.resolve(__dirname, '..', 'skill-coupling.yml');
  if (!existsSync(configPath)) {
    throw new Error(`skill-coupling config not found at ${configPath}`);
  }
  return parseCouplingYaml(readFileSync(configPath, 'utf8'));
}

// CLI entry point (only when run directly, not when imported).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    const config = loadConfig();
    const changedFiles = readChangedFiles();
    const labels = readLabels();

    const result = evaluateCoupling({ changedFiles, labels, config });

    if (result.ok) {
      console.log(
        `✅ Skill-freeze coupling check passed (${result.reason}).`,
      );
      if (result.matchedCoupled.length > 0) {
        console.log(
          `   Coupled files changed: ${result.matchedCoupled.length}`,
        );
      }
      if (result.matchedDoc.length > 0) {
        console.log(`   Skill-doc files touched: ${result.matchedDoc.length}`);
      }
      if (result.overrideUsed) {
        console.log(`   Override label used: ${config.override_label}`);
      }
      process.exit(0);
    }

    console.error(formatFailureMessage(result, config));
    process.exit(1);
  } catch (err) {
    console.error(`skill-coupling check errored: ${err.message}`);
    process.exit(2);
  }
}
