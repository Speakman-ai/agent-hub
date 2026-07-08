import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * Guard against re-introducing internal-only provenance identifiers that carry
 * NO functional role — the maintainer's personal GitHub handle and the real
 * dev-hub domain — anywhere in the tracked tree. Card #1390 genericized the
 * ~250 `surveytracker`/`mcsteen` provenance references that had accumulated in
 * tests, comments, and finalize fixtures (owner/repo test data -> `acme/webapp`,
 * PR-provenance strings -> `webapp#…`, illustrative domains -> `example.com`).
 * The real PR/commit traceability lives in git history and the wiki, and points
 * at a PRIVATE repo that a public reader cannot follow anyway.
 *
 * Deliberately NOT covered here (each is its own concern):
 *  - The live `survey-tracker` kanban LABEL that routes `DEV_HUB_API_KEY`
 *    (`server/secrets.ts` `CROSS_HUB_LABELS`, `autonomous.ts`, their tests) is a
 *    functional identifier, not provenance — it must match production and stays.
 *  - Real AWS account ids / ARNs in server comments + AWS test fixtures — a
 *    broader leak tracked separately.
 *  - `scripts/*surveytracker*` operator helpers hardwired to the private
 *    project — tracked separately.
 * So this guard scans for the two tokens that are pure leaks with zero
 * functional meaning, keeping it non-brittle.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Files allowed to mention these tokens: the hygiene ban-list and this guard.
const ALLOWLIST = new Set([
  'server/public-repo-hygiene.test.ts',
  'server/no-internal-provenance.test.ts',
]);

function gitGrep(pattern: string): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nIiE', pattern], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    // git grep exits 1 with no output when there are no matches.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout) return [];
    throw err;
  }
  return out.split('\n').filter(Boolean);
}

function offenders(pattern: string): string[] {
  return gitGrep(pattern).filter((line) => {
    const file = line.slice(0, line.indexOf(':'));
    return !ALLOWLIST.has(file);
  });
}

describe('no internal provenance leaks', () => {
  it('the personal GitHub handle (mcsteen) appears nowhere but the ban-list', () => {
    const found = offenders('\\bmcsteen\\b');
    expect(found, `\`mcsteen\` leaked into:\n${found.join('\n')}`).toEqual([]);
  });

  it('the real dev-hub domain (surveytracker.io) appears nowhere but the ban-list', () => {
    const found = offenders('surveytracker\\.io');
    expect(found, `dev-hub domain leaked into:\n${found.join('\n')}`).toEqual([]);
  });
});
