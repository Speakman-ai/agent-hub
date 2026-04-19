#!/usr/bin/env node
// Lightweight eval runner for the agent-hub skill.
//
// Usage:
//   node run.mjs                         # run every eval × every model (needs ANTHROPIC_API_KEY)
//   node run.mjs --dry-run               # shape-validate evals + print matrix (no API calls)
//   node run.mjs --eval create-ticket    # filter by eval id
//   node run.mjs --model claude-haiku-*  # filter by model alias
//   node run.mjs --baseline              # omit skill context from system prompt (regression compare)
//   node run.mjs --out report.json       # write machine-readable report
//
// Behaviour grading is deterministic pattern-matching on the assistant's
// response text — no LLM-as-judge. Each `expected_behavior` entry has a
// `type` that maps to one of the matchers in MATCHERS below. This keeps the
// scoring reviewable and cheap to run in CI.
//
// The runner is intentionally dependency-free: it uses Node's built-in
// `fetch` to hit the Anthropic Messages API directly. No @anthropic-ai/sdk,
// no agent-sdk. Swap `callModel` if you want to route through a different
// provider.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(SKILL_ROOT, '..', '..', '..');

// ---------------------------------------------------------------------------
// Model roster — names are the public Anthropic aliases; adjust if a snapshot
// identifier is needed. The runner tolerates HTTP 404 on unknown models and
// records them as "skipped" rather than failing the whole matrix.
// ---------------------------------------------------------------------------
const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-5',
};

// ---------------------------------------------------------------------------
// Argument parsing — flat, no external dep.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { dryRun: false, baseline: false, evalFilter: null, modelFilter: null, outPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--baseline') out.baseline = true;
    else if (a === '--eval') out.evalFilter = argv[++i];
    else if (a === '--model') out.modelFilter = argv[++i];
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n') + '\n');
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Eval loader + shape validation.
// ---------------------------------------------------------------------------
function loadEvals() {
  const files = readdirSync(__dirname).filter((f) => f.endsWith('.json'));
  const evals = [];
  for (const f of files) {
    const raw = readFileSync(join(__dirname, f), 'utf8');
    const parsed = JSON.parse(raw);
    validateEval(parsed, f);
    evals.push(parsed);
  }
  return evals;
}

function validateEval(ev, file) {
  const required = ['id', 'description', 'skills', 'query', 'expected_behavior'];
  for (const k of required) {
    if (!(k in ev)) throw new Error(`${file}: missing required key "${k}"`);
  }
  if (!Array.isArray(ev.expected_behavior) || ev.expected_behavior.length === 0) {
    throw new Error(`${file}: expected_behavior must be a non-empty array`);
  }
  for (const b of ev.expected_behavior) {
    if (!MATCHERS[b.type]) {
      throw new Error(`${file}: unknown behavior type "${b.type}" (valid: ${Object.keys(MATCHERS).join(', ')})`);
    }
    if (!('value' in b)) throw new Error(`${file}: behavior missing "value"`);
  }
}

// ---------------------------------------------------------------------------
// Matchers — map `expected_behavior.type` → (response, value) → boolean.
// Keep these stateless and trivially auditable.
// ---------------------------------------------------------------------------
const MATCHERS = {
  contains: (resp, value) => resp.includes(value),
  not_contains: (resp, value) => !resp.includes(value),
  contains_any: (resp, values) => values.some((v) => resp.includes(v)),
  not_contains_any: (resp, values) => !values.some((v) => resp.includes(v)),
  regex: (resp, pattern) => new RegExp(pattern).test(resp),
  mentions_script: (resp, path) => resp.includes(path),
  mentions_any_script: (resp, paths) => paths.some((p) => resp.includes(p)),
  references_file: (resp, path) => resp.includes(path),
};

function grade(response, expected) {
  const results = [];
  for (const b of expected) {
    const ok = MATCHERS[b.type](response, b.value);
    results.push({ type: b.type, value: b.value, pass: ok, rationale: b.rationale || null });
  }
  return { results, pass: results.every((r) => r.pass) };
}

// ---------------------------------------------------------------------------
// Prompt assembly. When not --baseline, the skill SKILL.md + any `files` in
// the eval are concatenated into the system prompt under clear markers so a
// grader reviewing a failing run can see exactly what context the model got.
// ---------------------------------------------------------------------------
function buildSystemPrompt(ev, { baseline }) {
  if (baseline) {
    return 'You are an AI coding assistant. Answer concisely.';
  }
  const chunks = ['You are an AI agent working inside Agent Hub. Use the attached skill files to answer.\n'];
  const files = ev.files || [join('server', 'default-skills', 'agent-hub', 'SKILL.md')];
  for (const rel of files) {
    const abs = resolve(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      chunks.push(`\n<file path="${rel}">\n(missing)\n</file>\n`);
      continue;
    }
    chunks.push(`\n<file path="${rel}">\n${readFileSync(abs, 'utf8')}\n</file>\n`);
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// API call — Anthropic Messages. Fails soft so a network/credential error on
// one model doesn't torch the whole matrix.
// ---------------------------------------------------------------------------
async function callModel(model, systemPrompt, userQuery, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userQuery }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body };
  }
  const json = await res.json();
  const text = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evals = loadEvals();
  const selected = args.evalFilter ? evals.filter((e) => e.id === args.evalFilter) : evals;
  if (selected.length === 0) {
    console.error(`No evals matched filter "${args.evalFilter}". Available: ${evals.map((e) => e.id).join(', ')}`);
    process.exit(2);
  }

  const modelEntries = Object.entries(MODELS).filter(
    ([alias, id]) => !args.modelFilter || alias === args.modelFilter || id.includes(args.modelFilter),
  );

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const report = {
    ranAt: new Date().toISOString(),
    baseline: args.baseline,
    dryRun: args.dryRun || !apiKey,
    reasonDry: args.dryRun ? 'flag' : apiKey ? null : 'ANTHROPIC_API_KEY not set',
    results: [],
  };

  for (const ev of selected) {
    const systemPrompt = buildSystemPrompt(ev, { baseline: args.baseline });
    for (const [alias, modelId] of modelEntries) {
      const row = { eval: ev.id, modelAlias: alias, modelId };
      if (report.dryRun) {
        row.status = 'skipped';
        row.reason = report.reasonDry;
        report.results.push(row);
        continue;
      }
      const resp = await callModel(modelId, systemPrompt, ev.query, apiKey);
      if (!resp.ok) {
        row.status = 'api_error';
        row.httpStatus = resp.status;
        row.body = resp.body.slice(0, 500);
        report.results.push(row);
        continue;
      }
      const graded = grade(resp.text, ev.expected_behavior);
      row.status = graded.pass ? 'pass' : 'fail';
      row.responsePreview = resp.text.slice(0, 400);
      row.checks = graded.results;
      report.results.push(row);
    }
  }

  // Summary matrix.
  const evalIds = [...new Set(report.results.map((r) => r.eval))];
  const modelAliases = [...new Set(report.results.map((r) => r.modelAlias))];
  const col = (s, w) => String(s).padEnd(w);
  const width = Math.max(16, ...evalIds.map((x) => x.length + 2));
  process.stdout.write(`\n${col('eval', width)}${modelAliases.map((m) => col(m, 10)).join('')}\n`);
  process.stdout.write('-'.repeat(width + 10 * modelAliases.length) + '\n');
  for (const id of evalIds) {
    const cells = modelAliases.map((m) => {
      const row = report.results.find((r) => r.eval === id && r.modelAlias === m);
      return col(row?.status || 'n/a', 10);
    });
    process.stdout.write(`${col(id, width)}${cells.join('')}\n`);
  }

  if (args.outPath) {
    writeFileSync(args.outPath, JSON.stringify(report, null, 2));
    process.stdout.write(`\nwrote report: ${args.outPath}\n`);
  }

  // Exit code reflects aggregate pass/fail — skipped counts as pass (CI mode).
  const anyFail = report.results.some((r) => r.status === 'fail' || r.status === 'api_error');
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
