import { describe, expect, it } from 'vitest';
import { parseCiConfig } from './ci-config.js';
import {
  applyEnvToStep,
  buildFinalizeBuiltinEnv,
  expandJobInstances,
  matrixKeyFromRow,
  substituteEnvString,
} from './ci-config-v2.js';

describe('ci-config-v2 helpers', () => {
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
