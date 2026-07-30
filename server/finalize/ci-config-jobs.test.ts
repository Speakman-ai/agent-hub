import { describe, expect, it } from 'vitest';
import { parseCiConfig } from './ci-config.js';
import {
  applyEnvToStep,
  buildFinalizeBuiltinEnv,
  DEFAULT_JOB_RETRIES,
  expandJobInstances,
  matrixKeyFromRow,
  resolveDefaultJobRetries,
  resolveDefaultMatrixFailFast,
  substituteEnvString,
} from './ci-config-jobs.js';

describe('ci-config-jobs helpers', () => {
  it('matrixKeyFromRow prefers group field', () => {
    expect(matrixKeyFromRow({ group: 'Profiles & Tasks', specs: 'a.cy.ts' })).toBe(
      'Profiles_Tasks',
    );
  });

  it('substituteEnvString replaces braced and bare vars', () => {
    const env = { FOO: 'bar', SPECS: 'a.cy.ts' };
    expect(substituteEnvString('echo ${FOO} $SPECS', env)).toBe('echo bar a.cy.ts');
    expect(substituteEnvString('unknown ${MISSING}', env)).toBe('unknown ${MISSING}');
  });

  it('expandJobInstances expands matrix shards with builtins', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - group: A
          specs: "x.cy.ts"
        - group: B
          specs: "y.cy.ts"
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    const builtins = buildFinalizeBuiltinEnv({ branch: 'feat/x', headSha: 'abc123' });
    const instances = expandJobInstances(parsed.config, builtins);
    expect(instances).toHaveLength(2);
    expect(instances[0].jobId).toBe('e2e');
    expect(instances[0].matrixKey).toBe('A');
    expect(instances[0].env.FINALIZE_MATRIX_SPECS).toBe('x.cy.ts');
    expect(instances[0].env.FINALIZE_BRANCH).toBe('feat/x');
    expect(instances[1].matrixKey).toBe('B');
  });

  it('injects a 1-based FINALIZE_MATRIX_ORDINAL/TOTAL per matrix instance', () => {
    // Regression for "shards wrongly print zero indexed numbers": a project
    // using a 0-based runner index (group 0..3) still needs a 1-based value
    // to print a human "shard N/M" label without off-by-one shell math.
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  backend-tests:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - group: "0"
        - group: "1"
        - group: "2"
        - group: "3"
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    const builtins = buildFinalizeBuiltinEnv({ branch: 'feat/x', headSha: 'abc123' });
    const instances = expandJobInstances(parsed.config, builtins);
    expect(instances).toHaveLength(4);
    // The runner index stays faithful (0-based), while the display ordinal is
    // 1-based and the total reflects the matrix size.
    expect(instances.map((i) => i.env.FINALIZE_MATRIX_GROUP)).toEqual(['0', '1', '2', '3']);
    expect(instances.map((i) => i.env.FINALIZE_MATRIX_ORDINAL)).toEqual(['1', '2', '3', '4']);
    for (const inst of instances) {
      expect(inst.env.FINALIZE_MATRIX_TOTAL).toBe('4');
    }
  });

  it('ordinal/total are per-job, and an explicit matrix key overrides them', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  single:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
  triple:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - shard: "1"
        - shard: "2"
          ordinal: "custom"
        - shard: "3"
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    const builtins = buildFinalizeBuiltinEnv({ branch: 'feat/x', headSha: 'abc123' });
    const instances = expandJobInstances(parsed.config, builtins);
    const single = instances.filter((i) => i.jobId === 'single');
    const triple = instances.filter((i) => i.jobId === 'triple');
    // A job with no matrix.include is one implicit instance: ordinal 1 of 1.
    expect(single).toHaveLength(1);
    expect(single[0].env.FINALIZE_MATRIX_ORDINAL).toBe('1');
    expect(single[0].env.FINALIZE_MATRIX_TOTAL).toBe('1');
    // Totals are scoped to each job's own matrix, not the whole config.
    expect(triple.map((i) => i.env.FINALIZE_MATRIX_TOTAL)).toEqual(['3', '3', '3']);
    // A user-authored `ordinal` matrix key wins over the computed value.
    expect(triple[1].env.FINALIZE_MATRIX_ORDINAL).toBe('custom');
    expect(triple[0].env.FINALIZE_MATRIX_ORDINAL).toBe('1');
    expect(triple[2].env.FINALIZE_MATRIX_ORDINAL).toBe('3');
  });

  it('parses optional job paths globs', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    paths:
      - "e2e/**"
      - "client/**"
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    expect(parsed.config.jobs.e2e.paths).toEqual(['e2e/**', 'client/**']);
  });

  it('paths omitted leaves the field undefined', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    expect(parsed.config.jobs.e2e.paths).toBeUndefined();
  });

  it('rejects non-list paths', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    paths: "e2e/**"
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('invalid_paths');
  });

  it('parses warmup job flag and carries it onto instances (default false)', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: ubuntu-24.04
    warmup: true
    steps:
      - run: ./run_e2e_ci.sh
  e2e:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - group: A
          specs: "x.cy.ts"
    steps:
      - run: ./run_e2e_ci.sh
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    expect(parsed.config.jobs.prepare.warmup).toBe(true);
    expect(parsed.config.jobs.e2e.warmup).toBe(false);
    const instances = expandJobInstances(
      parsed.config,
      buildFinalizeBuiltinEnv({ branch: 'b', headSha: 's' }),
    );
    expect(instances.find((i) => i.jobId === 'prepare')?.warmup).toBe(true);
    expect(instances.find((i) => i.jobId === 'e2e')?.warmup).toBe(false);
  });

  it('defaults matrix fail-fast OFF so every shard runs and reports its true result', () => {
    // Finalize diverges from GHA here: a fix agent needs the complete failure
    // set, so a job that omits fail-fast must NOT cancel sibling shards.
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - group: A
          specs: "a.cy.ts"
    steps:
      - run: ./run_e2e_ci.sh
  strict:
    runs-on: ubuntu-24.04
    fail-fast: true
    matrix:
      include:
        - group: B
          specs: "b.cy.ts"
    steps:
      - run: ./run_e2e_ci.sh
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    // Omitted → defaults OFF (the new Finalize default).
    expect(parsed.config.jobs.e2e.failFast).toBe(false);
    // Explicit fail-fast: true still wins over the default.
    expect(parsed.config.jobs.strict.failFast).toBe(true);
    const instances = expandJobInstances(
      parsed.config,
      buildFinalizeBuiltinEnv({ branch: 'b', headSha: 's' }),
    );
    expect(instances.find((i) => i.jobId === 'e2e')?.failFast).toBe(false);
    expect(instances.find((i) => i.jobId === 'strict')?.failFast).toBe(true);
  });

  it('resolveDefaultMatrixFailFast: OFF by default, ON via env override', () => {
    const prev = process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT;
    try {
      delete process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT;
      expect(resolveDefaultMatrixFailFast()).toBe(false);
      for (const v of ['true', 'TRUE', '1', 'on', 'yes']) {
        process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT = v;
        expect(resolveDefaultMatrixFailFast()).toBe(true);
      }
      for (const v of ['false', '0', 'off', '']) {
        process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT = v;
        expect(resolveDefaultMatrixFailFast()).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT;
      else process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT = prev;
    }
  });

  it('env override flips the parsed job default to fail-fast ON', () => {
    const prev = process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT;
    process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT = 'true';
    try {
      const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: ./run_e2e_ci.sh
`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.config.version !== 2) return;
      expect(parsed.config.jobs.e2e.failFast).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT;
      else process.env.FINALIZE_MATRIX_FAIL_FAST_DEFAULT = prev;
    }
  });

  it('parses needs (bare string and list) and normalizes to an array', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: ubuntu-24.04
    steps:
      - run: ./prep.sh
  e2e:
    runs-on: ubuntu-24.04
    needs: prepare
    steps:
      - run: ./e2e.sh
  report:
    runs-on: ubuntu-24.04
    needs: [prepare, e2e]
    steps:
      - run: ./report.sh
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    expect(parsed.config.jobs.prepare.needs).toEqual([]);
    expect(parsed.config.jobs.e2e.needs).toEqual(['prepare']);
    expect(parsed.config.jobs.report.needs).toEqual(['prepare', 'e2e']);
  });

  it('rejects needs referencing an unknown job', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    needs: [nope]
    steps:
      - run: ./e2e.sh
`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('unknown_needs_job');
  });

  it('rejects a needs cycle', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  a:
    runs-on: ubuntu-24.04
    needs: [b]
    steps:
      - run: ./a.sh
  b:
    runs-on: ubuntu-24.04
    needs: [a]
    steps:
      - run: ./b.sh
`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('cyclic_needs');
  });

  it('rejects a warmup job that needs a non-warmup job (implicit cycle)', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: ubuntu-24.04
    warmup: true
    needs: [e2e]
    steps:
      - run: ./prep.sh
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: ./e2e.sh
`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('cyclic_needs');
  });

  it('rejects a non-boolean warmup', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: ubuntu-24.04
    warmup: "yes"
    steps:
      - run: echo hi
`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('invalid_warmup');
  });

  it('applyEnvToStep substitutes run and step env', () => {
    const env = {
      FINALIZE_MATRIX_SPECS: 'a.cy.ts',
      CYPRESS_E2E_HEALTH_URL: 'http://localhost/health',
    };
    const step = applyEnvToStep(
      {
        name: 'cypress',
        run: 'npx cypress run --spec "${FINALIZE_MATRIX_SPECS}"',
        env: { CYPRESS_E2E_HEALTH_URL: '${CYPRESS_E2E_HEALTH_URL}' },
      },
      env,
    );
    expect(step.run).toBe('npx cypress run --spec "a.cy.ts"');
  });

  it('exports resolved step env but drops unresolved ${VAR} placeholders', () => {
    const step = applyEnvToStep(
      {
        name: 'warm',
        run: './run_e2e_ci.sh',
        env: {
          FINALIZE_WARMUP: '1', // literal → exported
          AWS_REGION: '${AWS_REGION}', // resolves from env below → exported
          AWS_S3_REGION: '${AWS_S3_REGION}', // not in scope → dropped
        },
      },
      { AWS_REGION: 'us-east-2' },
    );
    expect(step.env).toEqual({ FINALIZE_WARMUP: '1', AWS_REGION: 'us-east-2' });
    expect(step.env).not.toHaveProperty('AWS_S3_REGION');
  });
});

describe('ci-config-jobs — per-step timeout_minutes', () => {
  const cfg = (stepTail: string) => `
version: 2
on: [finalize]
jobs:
  backend:
    runs-on: ubuntu-24.04
    steps:
      - name: Test
        run: npm test
${stepTail}
`;

  it('parses a valid per-step timeout_minutes onto the step', () => {
    const r = parseCiConfig(cfg('        timeout_minutes: 8'));
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 2) return;
    expect(r.config.jobs.backend.steps[0]).toEqual({
      name: 'Test',
      run: 'npm test',
      timeoutMinutes: 8,
    });
  });

  it('rejects an invalid step timeout with invalid_step_timeout', () => {
    const r = parseCiConfig(cfg('        timeout_minutes: 0'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_step_timeout');
  });
});

describe('ci-config-jobs job retries', () => {
  const jobCfg = (retriesLine = ''): string => `
version: 2
on: [finalize]
jobs:
  backend:
    runs-on: ubuntu-24.04
${retriesLine ? `    ${retriesLine}\n` : ''}    steps:
      - name: Test
        run: npm test
`;

  it('defaults job.retries to 2 when the key is omitted', () => {
    const r = parseCiConfig(jobCfg());
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 2) return;
    expect(r.config.jobs.backend.retries).toBe(2);
  });

  it('accepts an explicit retries value', () => {
    const r = parseCiConfig(jobCfg('retries: 4'));
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 2) return;
    expect(r.config.jobs.backend.retries).toBe(4);
  });

  it('accepts retries: 0 to disable flaky-test reruns', () => {
    const r = parseCiConfig(jobCfg('retries: 0'));
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 2) return;
    expect(r.config.jobs.backend.retries).toBe(0);
  });

  it.each([
    ['retries: -1', 'negative'],
    ['retries: 1.5', 'non-integer'],
    ['retries: 11', 'above the max'],
    ["retries: 'two'", 'a string'],
    ['retries: true', 'a boolean'],
  ])('rejects %s (%s) with invalid_retries', (line) => {
    const r = parseCiConfig(jobCfg(line));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('invalid_retries');
  });

  it('defaults a WARMUP job to retries 0 (setup is not flaky-test work)', () => {
    const r = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: host
    warmup: true
    steps:
      - run: build-images
`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 2) return;
    expect(r.config.jobs.prepare.retries).toBe(0);
  });

  it('honors an explicit retries value on a warmup job (opt-in)', () => {
    const r = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: host
    warmup: true
    retries: 3
    steps:
      - run: build-images
`);
    expect(r.ok).toBe(true);
    if (!r.ok || r.config.version !== 2) return;
    expect(r.config.jobs.prepare.retries).toBe(3);
  });

  it('threads job.retries onto every expanded matrix instance', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    retries: 3
    matrix:
      include:
        - group: A
        - group: B
    steps:
      - run: echo test
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    const builtins = buildFinalizeBuiltinEnv({ branch: 'feat/x', headSha: 'abc123' });
    const instances = expandJobInstances(parsed.config, builtins);
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.retries)).toEqual([3, 3]);
  });

  it('resolveDefaultJobRetries honors a valid FINALIZE_JOB_RETRIES_DEFAULT override', () => {
    const prev = process.env.FINALIZE_JOB_RETRIES_DEFAULT;
    try {
      process.env.FINALIZE_JOB_RETRIES_DEFAULT = '0';
      expect(resolveDefaultJobRetries()).toBe(0);
      process.env.FINALIZE_JOB_RETRIES_DEFAULT = '5';
      expect(resolveDefaultJobRetries()).toBe(5);
      // Invalid values fall back to the constant default.
      process.env.FINALIZE_JOB_RETRIES_DEFAULT = 'garbage';
      expect(resolveDefaultJobRetries()).toBe(DEFAULT_JOB_RETRIES);
      process.env.FINALIZE_JOB_RETRIES_DEFAULT = '-2';
      expect(resolveDefaultJobRetries()).toBe(DEFAULT_JOB_RETRIES);
    } finally {
      if (prev === undefined) delete process.env.FINALIZE_JOB_RETRIES_DEFAULT;
      else process.env.FINALIZE_JOB_RETRIES_DEFAULT = prev;
    }
  });
});
