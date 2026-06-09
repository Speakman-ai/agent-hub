#!/usr/bin/env tsx
/**
 * Detect drift between `.github/workflows/*.yml` (the literal GitHub Actions
 * gate) and `.agent-hub/ci.yaml` (what the Finalize gate runs).
 *
 * The Finalize gate stands in for the GitHub PR check but runs a separate
 * config. They can silently diverge (a job added to ci.yml that ci.yaml never
 * learns about → Finalize green where GitHub would be red). This compares the
 * two against the EXPLICIT mirror mapping authored in the sidecar
 * `.agent-hub/ci-mirror.yaml` (a `jobs:` map of ci.yaml job id → GitHub
 * `<file>:<jobId>` ref / `finalize-only`, plus `workflows:` scope and an
 * `ignore:` list) — NOT inside ci.yaml, whose parser fails closed on unknown
 * keys, and not naive equality, since for agent-hub the two intentionally
 * diverge (GitHub: build+typecheck; Finalize: full suite). When the sidecar is
 * absent the repo is "not configured" and the check no-ops (exit 0).
 *
 * Exit codes:
 *   0  — no blocking drift (warnings, if any, are printed but do not fail).
 *   1  — blocking drift found (unmapped/removed/unannotated job, or an
 *        in-scope GitHub workflow that could not be parsed).
 *   2  — script invocation error (could not read/parse ci.yaml or the sidecar).
 *
 * Usage:
 *   npm run check:workflow-drift
 *   npx tsx scripts/check-workflow-drift.ts --repo /path/to/repo
 *   npx tsx scripts/check-workflow-drift.ts --strict   # warnings also fail
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCiConfigFromFile } from '../server/finalize/ci-config.js';
import {
  computeWorkflowDrift,
  formatDriftReport,
  loadGithubWorkflows,
  loadMirrorManifest,
} from '../server/finalize/workflow-drift.js';

function parseArgs(argv: string[]): { repo: string; strict: boolean } {
  const here = dirname(fileURLToPath(import.meta.url));
  let repo = resolve(here, '..');
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      repo = resolve(argv[++i] ?? '.');
    } else if (arg === '--strict') {
      strict = true;
    } else {
      console.error(`check-workflow-drift: unknown argument '${arg}'.`);
      process.exit(2);
    }
  }
  return { repo, strict };
}

async function main(): Promise<number> {
  const { repo, strict } = parseArgs(process.argv.slice(2));
  const ciPath = join(repo, '.agent-hub', 'ci.yaml');
  const manifestPath = join(repo, '.agent-hub', 'ci-mirror.yaml');
  const workflowsDir = join(repo, '.github', 'workflows');

  const parsed = await loadCiConfigFromFile(ciPath);
  if (!parsed.ok) {
    console.error(`check-workflow-drift: could not load ${ciPath}: ${parsed.error.message}`);
    return 2;
  }
  if (parsed.config.version !== 2) {
    console.error(
      `check-workflow-drift: ${ciPath} is version ${parsed.config.version}; ` +
        'workflow drift checking requires a v2 (jobs) config.',
    );
    return 2;
  }

  const manifestResult = await loadMirrorManifest(manifestPath);
  if (!manifestResult.ok) {
    console.error(`check-workflow-drift: invalid mirror manifest: ${manifestResult.error}`);
    return 2;
  }

  const workflows = await loadGithubWorkflows(workflowsDir);
  const report = computeWorkflowDrift({
    ciConfig: parsed.config,
    manifest: manifestResult.manifest,
    workflows,
  });

  console.log(formatDriftReport(report));

  if (report.notConfigured) return 0;
  if (report.hasBlockingDrift) return 1;
  if (strict && report.hasWarnings) {
    console.error('check-workflow-drift: --strict set and warnings present → failing.');
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('check-workflow-drift: unexpected error:', err);
    process.exit(2);
  },
);
