/**
 * Tests for the `.agent-hub/ci.yaml` v1 parser.
 *
 * Coverage targets the acceptance criteria from the implementation
 * card and the locked schema in the wiki page
 * `finalize-code-changes-architecture-v0` §5:
 *
 *   - Valid baseline config parses with defaults applied where allowed.
 *   - `version` is required and only the literal `1` is accepted.
 *   - Unknown top-level keys are a HARD ERROR (including `autofix:`,
 *     which existed in the predecessor design but is intentionally
 *     forbidden at v1).
 *   - `on:` accepts only `finalize` / `manual`; `pull_request` and the
 *     other GitHub-Actions vocabulary is rejected at parse time.
 *   - `steps:` is required, non-empty, and every entry needs a
 *     non-empty `run` string. `name` defaults to `step <index>`.
 *   - `steps[].shell:` (or any other unknown step-level key) is
 *     rejected — the orchestrator hard-codes `bash -euo pipefail -c`.
 *   - `timeout_minutes` may LOWER the system 4-hour cap but never
 *     raise it; out-of-range values error.
 *   - The file loader works against an arbitrary path (the "file lives
 *     at non-root location" criterion).
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINALIZE_STEP_SHELL,
  FINALIZE_TIMEOUT_DEFAULT_MINUTES,
  FINALIZE_TIMEOUT_MAX_MINUTES,
  FINALIZE_TIMEOUT_MIN_MINUTES,
  SUPPORTED_TRIGGERS,
  loadCiConfigFromFile,
  parseCiConfig,
} from './ci-config.js';

const VALID = `
version: 1
on:
  - finalize
  - manual
timeout_minutes: 45
steps:
  - name: Install
    run: npm ci --include=dev
  - name: Typecheck
    run: npm run typecheck
  - name: Test
    run: npm test
`;

describe('parseCiConfig — exported constants', () => {
  it('locks the shell prefix the orchestrator uses for every step', () => {
    expect(FINALIZE_STEP_SHELL).toBe('bash -euo pipefail -c');
  });

  it('locks the timeout floor / ceiling / default', () => {
    expect(FINALIZE_TIMEOUT_MIN_MINUTES).toBe(1);
    expect(FINALIZE_TIMEOUT_MAX_MINUTES).toBe(240);
    expect(FINALIZE_TIMEOUT_DEFAULT_MINUTES).toBe(240);
  });

  it('locks the supported trigger set (push added for Hub-hosted CI on push)', () => {
    expect([...SUPPORTED_TRIGGERS]).toEqual(['finalize', 'manual', 'push']);
  });
});

describe('parseCiConfig — valid configs', () => {
  it('parses the canonical example from the design doc', () => {
    const result = parseCiConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({
      version: 1,
      on: ['finalize', 'manual'],
      timeoutMinutes: 45,
      steps: [
        { name: 'Install', run: 'npm ci --include=dev' },
        { name: 'Typecheck', run: 'npm run typecheck' },
        { name: 'Test', run: 'npm test' },
      ],
    });
  });

  it('defaults timeout_minutes to 240 when the field is omitted', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timeoutMinutes).toBe(240);
  });

  it('defaults step name to "step <1-indexed-position>" when omitted', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: echo first
  - name: Explicit
    run: echo second
  - run: echo third
`);
    expect(result.ok).toBe(true);
    if (!result.ok || result.config.version !== 1) return;
    expect(result.config.steps.map((s) => s.name)).toEqual(['step 1', 'Explicit', 'step 3']);
  });

  it('accepts only a `finalize` trigger', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.on).toEqual(['finalize']);
  });

  it('accepts only a `manual` trigger', () => {
    const result = parseCiConfig(`
version: 1
on: [manual]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.on).toEqual(['manual']);
  });

  it('accepts the timeout floor (1) and ceiling (240)', () => {
    const floor = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: 1
steps:
  - run: echo hi
`);
    expect(floor.ok).toBe(true);
    if (floor.ok) expect(floor.config.timeoutMinutes).toBe(1);

    const ceil = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: 240
steps:
  - run: echo hi
`);
    expect(ceil.ok).toBe(true);
    if (ceil.ok) expect(ceil.config.timeoutMinutes).toBe(240);
  });
});

describe('parseCiConfig — YAML / shape errors', () => {
  it('rejects unparseable YAML with yaml_parse_error', () => {
    const result = parseCiConfig('version: 1\n  bad: [unclosed');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('yaml_parse_error');
  });

  it('rejects an empty document with not_an_object', () => {
    const result = parseCiConfig('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_an_object');
  });

  it('rejects a top-level list with not_an_object', () => {
    const result = parseCiConfig('- version: 1\n- on: [finalize]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_an_object');
  });

  it('rejects a top-level scalar with not_an_object', () => {
    const result = parseCiConfig('"just a string"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_an_object');
  });
});

describe('parseCiConfig — version ratchet', () => {
  it('errors with missing_version when the field is absent', () => {
    const result = parseCiConfig(`
on: [finalize]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_version');
    expect(result.error.path).toBe('version');
  });

  it('accepts version 2 when jobs are declared', () => {
    const result = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  smoke:
    runs-on: ubuntu-24.04
    steps:
      - run: docker version
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.version).toBe(2);
  });

  it('rejects string "1" with invalid_version (no coercion)', () => {
    const result = parseCiConfig(`
version: "1"
on: [finalize]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_version');
  });

  it('rejects null version with invalid_version', () => {
    const result = parseCiConfig(`
version: null
on: [finalize]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_version');
  });
});

describe('parseCiConfig — unknown top-level keys', () => {
  it('rejects a stray unknown key (no silent ignore)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: npm test
matrix:
  - node: 22
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_top_level_key');
    expect(result.error.path).toBe('matrix');
  });

  it('rejects autofix: with a hint, even though it existed in the predecessor design', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
autofix: true
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_top_level_key');
    expect(result.error.path).toBe('autofix');
    expect(result.error.message).toMatch(/autofix is not a v1 field/i);
  });

  it('rejects `jobs:` on v1 with a hint to use version 2', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
jobs:
  build:
    runs-on: ubuntu-latest
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_top_level_key');
    expect(result.error.path).toBe('jobs');
    expect(result.error.message).toMatch(/version: 2/i);
  });
});

describe('parseCiConfig — v2 jobs + matrix', () => {
  it('parses jobs with matrix.include and step env', () => {
    const result = parseCiConfig(`
version: 2
on: [finalize, manual]
timeout_minutes: 240
env:
  GIT_BRANCH: \${FINALIZE_BRANCH}
jobs:
  e2e:
    runs-on: ubuntu-24.04
    fail-fast: false
    matrix:
      include:
        - group: Profiles
          specs: "a.cy.ts,b.cy.ts"
        - group: Core
          specs: "c.cy.ts"
    steps:
      - name: pull
        run: docker compose pull
      - name: cypress
        run: npx cypress run --spec "\${FINALIZE_MATRIX_SPECS}"
        env:
          CYPRESS_E2E_HEALTH_URL: http://localhost/health
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.version).toBe(2);
    if (result.config.version !== 2) return;
    expect(result.config.jobs.e2e.runsOn).toBe('ubuntu-24.04');
    expect(result.config.jobs.e2e.failFast).toBe(false);
    expect(result.config.jobs.e2e.matrixInclude).toHaveLength(2);
    expect(result.config.jobs.e2e.steps).toHaveLength(2);
  });

  it('errors when v2 is missing jobs', () => {
    const result = parseCiConfig(`
version: 2
on: [finalize]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_jobs');
  });
});

describe('parseCiConfig — on triggers', () => {
  it('errors with missing_on when the field is absent', () => {
    const result = parseCiConfig(`
version: 1
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_on');
  });

  it('rejects on: as a string (GitHub Actions shorthand)', () => {
    const result = parseCiConfig(`
version: 1
on: finalize
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_on_shape');
  });

  it('rejects on: as a mapping (GitHub Actions shorthand)', () => {
    const result = parseCiConfig(`
version: 1
on:
  finalize:
    branches: [main]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_on_shape');
  });

  it('rejects an empty on: list with empty_on', () => {
    const result = parseCiConfig(`
version: 1
on: []
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('empty_on');
  });

  it('rejects pull_request explicitly (not allowed at v1)', () => {
    const result = parseCiConfig(`
version: 1
on: [pull_request]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_on_value');
    expect(result.error.path).toBe('on[0]');
  });

  it('rejects workflow_dispatch / schedule (unsupported GH-Actions triggers)', () => {
    for (const bad of ['workflow_dispatch', 'schedule']) {
      const result = parseCiConfig(`
version: 1
on: [${bad}]
steps:
  - run: npm test
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('invalid_on_value');
    }
  });

  it('accepts push (Hub-hosted CI on push)', () => {
    const result = parseCiConfig(`
version: 1
on: [push]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.on).toEqual(['push']);
  });

  it('rejects non-string entries in on:', () => {
    const result = parseCiConfig(`
version: 1
on: [42]
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_on_value');
  });
});

describe('parseCiConfig — timeout_minutes', () => {
  it('rejects 0 (out of range, floor is 1)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: 0
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timeout_out_of_range');
  });

  it('rejects negative values', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: -5
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timeout_out_of_range');
  });

  it('rejects 241 (above the v1 hard ceiling — config may lower, never raise)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: 241
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timeout_out_of_range');
    expect(result.error.message).toMatch(/out of range/i);
  });

  it('rejects a string value (no coercion)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: "30"
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_timeout_shape');
  });

  it('rejects a non-integer number (e.g. 30.5)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
timeout_minutes: 30.5
steps:
  - run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_timeout_shape');
  });
});

describe('parseCiConfig — steps', () => {
  it('errors with missing_steps when the field is absent', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_steps');
  });

  it('errors with empty_steps when the list is []', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps: []
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('empty_steps');
  });

  it('rejects steps: as a mapping (must be a list)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  build:
    run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_steps_shape');
  });

  it('rejects a step missing run with missing_step_run', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - name: NoRun
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_step_run');
    expect(result.error.path).toBe('steps[0].run');
  });

  it('rejects an empty run string', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: ""
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_step_run');
  });

  it('rejects a whitespace-only run string', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: "   "
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_step_run');
  });

  it('rejects a numeric run value', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: 42
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_step_run');
  });

  it('rejects an empty step name when explicitly set', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - name: ""
    run: npm test
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_step_name');
  });

  it('rejects a `shell:` override (no per-step shell at v1)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - name: Test
    run: npm test
    shell: zsh
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_step_key');
    expect(result.error.path).toBe('steps[0].shell');
  });

  it('rejects `uses:` (GitHub Actions vocabulary)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - uses: actions/checkout@v4
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_step_key');
  });

  it('rejects `env:` / `with:` / `matrix:` step keys', () => {
    for (const bad of ['env', 'with', 'matrix']) {
      const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: npm test
    ${bad}:
      KEY: value
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('unknown_step_key');
    }
  });

  it('rejects a non-mapping step entry (e.g. a bare string)', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - "npm test"
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_step_shape');
  });

  it('reports the failing step index in the error path', () => {
    const result = parseCiConfig(`
version: 1
on: [finalize]
steps:
  - run: npm install
  - run: npm test
  - name: Broken
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_step_run');
    expect(result.error.path).toBe('steps[2].run');
  });
});

describe('loadCiConfigFromFile — arbitrary path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads from a non-root location (acceptance: "file lives at non-root location")', async () => {
    // The orchestrator's production callsite reads `.agent-hub/ci.yaml`
    // at the repo root, but the loader is path-agnostic so tests and
    // any non-standard layout can point at an arbitrary file. Verify by
    // dropping the file into a nested subdir.
    const nested = path.join(tmpDir, 'nested', 'subdir');
    await fs.mkdir(nested, { recursive: true });
    const filePath = path.join(nested, 'ci.yaml');
    await fs.writeFile(filePath, VALID, 'utf8');

    const result = await loadCiConfigFromFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok || result.config.version !== 1) return;
    expect(result.config.steps).toHaveLength(3);
    expect(result.config.steps[0]).toEqual({ name: 'Install', run: 'npm ci --include=dev' });
  });

  it('returns yaml_parse_error when the file does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist', 'ci.yaml');
    const result = await loadCiConfigFromFile(missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('yaml_parse_error');
    expect(result.error.message).toMatch(/file not found/i);
  });

  it('propagates validation errors from parseCiConfig', async () => {
    const filePath = path.join(tmpDir, 'bad.yaml');
    await fs.writeFile(filePath, 'version: 2\non: [finalize]\n', 'utf8');
    const result = await loadCiConfigFromFile(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_jobs');
  });
});

describe('parseCiConfig — per-step timeout_minutes (v1)', () => {
  const cfg = (stepLine: string) => `
version: 1
on: [finalize]
steps:
  - name: Test
    run: npm test
${stepLine}
`;

  it('parses a valid per-step timeout_minutes onto the step', () => {
    const r = parseCiConfig(cfg('    timeout_minutes: 10'));
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 1) return;
    expect(r.config.steps[0]).toEqual({ name: 'Test', run: 'npm test', timeoutMinutes: 10 });
  });

  it('leaves timeoutMinutes undefined when the step omits it', () => {
    const r = parseCiConfig(cfg(''));
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 1) return;
    expect(r.config.steps[0].timeoutMinutes).toBeUndefined();
  });

  it('rejects a non-positive or non-integer step timeout', () => {
    for (const bad of [
      '    timeout_minutes: 0',
      '    timeout_minutes: -3',
      '    timeout_minutes: 1.5',
    ]) {
      const r = parseCiConfig(cfg(bad));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('invalid_step_timeout');
    }
  });

  it('rejects a step timeout above the pipeline ceiling (240)', () => {
    const r = parseCiConfig(cfg('    timeout_minutes: 999'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_step_timeout');
  });
});
