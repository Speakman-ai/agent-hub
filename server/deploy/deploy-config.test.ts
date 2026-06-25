/**
 * deploy-config.ts parser — pure validation tests (no IO).
 */
import { describe, it, expect } from 'vitest';
import {
  parseDeployConfig,
  resolveDeployEnvironment,
  DeployConfigError,
  DEPLOY_DEFAULT_RUNS_ON,
  DEPLOY_TIMEOUT_DEFAULT_MINUTES,
} from './deploy-config.js';

const VALID = `
version: 1
environments:
  dev:
    steps:
      - name: build
        run: ./build.sh
      - run: ./deploy-dev.sh
  production:
    approval: true
    runs-on: ubuntu-24.04
    timeout_minutes: 30
    steps:
      - run: ./deploy-prod.sh
`;

describe('parseDeployConfig — happy path', () => {
  it('parses environments, defaults, and step names', () => {
    const cfg = parseDeployConfig(VALID);
    expect(cfg.version).toBe(1);
    expect([...cfg.environments.keys()]).toEqual(['dev', 'production']);

    const dev = cfg.environments.get('dev')!;
    expect(dev.approval).toBe(false);
    expect(dev.runsOn).toBe(DEPLOY_DEFAULT_RUNS_ON);
    expect(dev.timeoutMinutes).toBe(DEPLOY_TIMEOUT_DEFAULT_MINUTES);
    expect(dev.steps).toEqual([
      { name: 'build', run: './build.sh' },
      { name: 'step 2', run: './deploy-dev.sh' }, // name defaults to "step <index>"
    ]);

    const prod = cfg.environments.get('production')!;
    expect(prod.approval).toBe(true);
    expect(prod.runsOn).toBe('ubuntu-24.04');
    expect(prod.timeoutMinutes).toBe(30);
  });

  it('preserves environment insertion order', () => {
    const cfg = parseDeployConfig(`
version: 1
environments:
  staging: { steps: [{ run: a }] }
  alpha: { steps: [{ run: b }] }
  prod: { steps: [{ run: c }] }
`);
    expect([...cfg.environments.keys()]).toEqual(['staging', 'alpha', 'prod']);
  });
});

describe('parseDeployConfig — rejections', () => {
  const cases: Array<{ name: string; yaml: string; reason: string }> = [
    { name: 'non-mapping root', yaml: '- a\n- b', reason: 'invalid_root' },
    { name: 'wrong version', yaml: 'version: 2\nenvironments: {}', reason: 'invalid_version' },
    {
      name: 'missing version',
      yaml: 'environments:\n  dev: { steps: [{ run: x }] }',
      reason: 'invalid_version',
    },
    {
      name: 'empty environments',
      yaml: 'version: 1\nenvironments: {}',
      reason: 'missing_environments',
    },
    {
      name: 'unknown top-level key',
      yaml: 'version: 1\nbogus: true\nenvironments:\n  dev: { steps: [{ run: x }] }',
      reason: 'unknown_key',
    },
    {
      name: 'unknown environment key',
      yaml: 'version: 1\nenvironments:\n  dev:\n    nope: 1\n    steps: [{ run: x }]',
      reason: 'unknown_key',
    },
    {
      name: 'unknown step key',
      yaml: 'version: 1\nenvironments:\n  dev:\n    steps:\n      - run: x\n        shell: zsh',
      reason: 'unknown_key',
    },
    {
      name: 'missing steps',
      yaml: 'version: 1\nenvironments:\n  dev: { approval: false }',
      reason: 'missing_steps',
    },
    {
      name: 'empty steps list',
      yaml: 'version: 1\nenvironments:\n  dev: { steps: [] }',
      reason: 'missing_steps',
    },
    {
      name: 'step missing run',
      yaml: 'version: 1\nenvironments:\n  dev:\n    steps:\n      - name: x',
      reason: 'missing_run',
    },
    {
      name: 'non-boolean approval',
      yaml: 'version: 1\nenvironments:\n  dev:\n    approval: yes-please\n    steps: [{ run: x }]',
      reason: 'invalid_approval',
    },
    {
      name: 'timeout below floor',
      yaml: 'version: 1\nenvironments:\n  dev:\n    timeout_minutes: 0\n    steps: [{ run: x }]',
      reason: 'invalid_timeout',
    },
    {
      name: 'timeout above ceiling',
      yaml: 'version: 1\nenvironments:\n  dev:\n    timeout_minutes: 9999\n    steps: [{ run: x }]',
      reason: 'invalid_timeout',
    },
    { name: 'malformed yaml', yaml: 'version: 1\n  bad: : :', reason: 'invalid_yaml' },
  ];

  for (const c of cases) {
    it(`rejects ${c.name} with reason=${c.reason}`, () => {
      try {
        parseDeployConfig(c.yaml);
        throw new Error('expected parseDeployConfig to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DeployConfigError);
        expect((err as DeployConfigError).reason).toBe(c.reason);
      }
    });
  }
});

describe('resolveDeployEnvironment', () => {
  it('returns the named environment', () => {
    const cfg = parseDeployConfig(VALID);
    expect(resolveDeployEnvironment(cfg, 'dev').name).toBe('dev');
  });

  it('throws unknown_environment for an undeclared env', () => {
    const cfg = parseDeployConfig(VALID);
    try {
      resolveDeployEnvironment(cfg, 'qa');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployConfigError);
      expect((err as DeployConfigError).reason).toBe('unknown_environment');
    }
  });
});
