#!/usr/bin/env node
// Container pool — starter CLI version-bump detector CLI wrapper (W3).
//
// Thin argv/IO wrapper around scripts/lib/starter-versions-core.mjs.
// Per the "Scripts Layer" convention (wiki: "Scripts Layer — Node CLI
// Convention"), top-level script stays small and all testable logic
// lives in the core module.
//
// Usage:
//   ./scripts/check-starter-versions.mjs [--manifest <path>]
//                                        [--github-output <path>]
//                                        [--json]
//
//   --manifest        Path to the pinned starter-versions.json
//                     (default: docker/starter-versions.json relative
//                     to the repo root inferred from this script's
//                     location).
//   --github-output   If set, write a GitHub Actions step output file
//                     with keys `has_major_bump` (true|false) and
//                     `bumps_json` (compact JSON of the bump list). The
//                     workflow reads these via `steps.<id>.outputs.*`.
//                     Typically `$GITHUB_OUTPUT`.
//   --json            Print the machine-readable JSON report to
//                     stdout instead of the human-readable one.
//
// Exit codes (aligns with scripts/ah-api.mjs convention):
//   0 — success; no major bumps detected
//   1 — success (ran cleanly) but MAJOR bump detected. CI treats
//       this as a "block :latest retag, open issue" signal rather than
//       a hard failure, so the workflow uses `continue-on-error: true`
//       on this step and keys off the `has_major_bump` output.
//   2 — bad invocation (unknown flag, missing manifest file, parse error)
//   3 — transport failure (network, registry 5xx, malformed response)
//
import { readFile } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  loadManifest,
  checkManifest,
  renderReport,
} from './lib/starter-versions-core.mjs';

// Minimal local arg parser — matches scripts/ah-api.mjs pattern.
export function parseArgs(argv) {
  const out = { manifest: null, githubOutput: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--manifest':
        out.manifest = argv[++i];
        break;
      case '--github-output':
        out.githubOutput = argv[++i];
        break;
      case '--json':
        out.json = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

export async function main({ argv, stdout, stderr, fetchImpl, env }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`check-starter-versions: ${err.message}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(
      'usage: check-starter-versions.mjs [--manifest <path>] [--github-output <path>] [--json]\n'
    );
    return 0;
  }

  const manifestPath =
    args.manifest ??
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'docker',
      'starter-versions.json'
    );

  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    stderr.write(`check-starter-versions: cannot read ${manifestPath}: ${err.message}\n`);
    return 2;
  }

  let manifest;
  try {
    manifest = loadManifest(raw);
  } catch (err) {
    stderr.write(`check-starter-versions: ${err.message}\n`);
    return 2;
  }

  let report;
  try {
    report = await checkManifest(manifest, { fetchImpl });
  } catch (err) {
    stderr.write(`check-starter-versions: ${err.message}\n`);
    return 3;
  }

  if (args.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(`${renderReport(report)}\n`);
  }

  const ghOutputPath = args.githubOutput ?? env?.GITHUB_OUTPUT;
  if (ghOutputPath) {
    const bumpsJson = JSON.stringify(report.bumps);
    const lines = [
      `has_major_bump=${report.hasMajorBump ? 'true' : 'false'}`,
      `bumps_json=${bumpsJson}`,
      '',
    ];
    try {
      await appendFile(ghOutputPath, lines.join('\n'), 'utf8');
    } catch (err) {
      stderr.write(
        `check-starter-versions: failed to write GITHUB_OUTPUT ${ghOutputPath}: ${err.message}\n`
      );
      return 3;
    }
  }

  return report.hasMajorBump ? 1 : 0;
}

// Guard direct invocation so Vitest can `import { main }` without running.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
    fetchImpl: globalThis.fetch,
    env: process.env,
  })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`check-starter-versions: unexpected: ${err.stack ?? err}\n`);
      process.exit(3);
    });
}
