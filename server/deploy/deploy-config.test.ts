/**
 * deploy-config.ts parser — pure validation tests (no IO).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

describe('github_workflow steps', () => {
  it('compiles a github_workflow step into a run script and keeps the spec', () => {
    const cfg = parseDeployConfig(`
version: 1
environments:
  production:
    steps:
      - name: Release
        github_workflow:
          workflow: release.yml
          ref: main
          inputs:
            bump: patch
          poll_interval_seconds: 15
`);
    const step = resolveDeployEnvironment(cfg, 'production').steps[0];
    expect(step.name).toBe('Release');
    expect(step.githubWorkflow).toEqual({
      workflow: 'release.yml',
      ref: 'main',
      inputs: { bump: 'patch' },
      pollIntervalSeconds: 15,
    });
    // The executable `run` is the compiled dispatch+poll script.
    expect(step.run).toContain('gh workflow run');
    expect(step.run).toContain('gh run watch');
  });

  it('rejects a step that sets both run and github_workflow', () => {
    try {
      parseDeployConfig(`
version: 1
environments:
  production:
    steps:
      - run: ./x.sh
        github_workflow:
          workflow: release.yml
`);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployConfigError);
      expect((err as DeployConfigError).reason).toBe('conflicting_step');
    }
  });

  it('rejects a github_workflow step missing a workflow', () => {
    try {
      parseDeployConfig(`
version: 1
environments:
  production:
    steps:
      - github_workflow:
          ref: main
`);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployConfigError);
      expect((err as DeployConfigError).reason).toBe('missing_workflow');
    }
  });

  it('rejects a github_workflow step missing a ref (workflow_dispatch needs a branch/tag)', () => {
    try {
      parseDeployConfig(`
version: 1
environments:
  production:
    steps:
      - github_workflow:
          workflow: release.yml
`);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployConfigError);
      expect((err as DeployConfigError).reason).toBe('missing_workflow_ref');
    }
  });
});

describe("this repo's .agent-hub/deploy.yaml", () => {
  // Regression: the github_workflow dispatch-and-watch step type shipped, but our
  // own production deploy step kept using a fire-and-forget `run: gh workflow run`
  // — so deploys reported success the instant the dispatch queued and never
  // listened for the release workflow's conclusion. Pin the production step to the
  // watch-to-completion shape so it can't silently regress to fire-and-forget.
  const deployYamlPath = fileURLToPath(new URL('../../.agent-hub/deploy.yaml', import.meta.url));
  const raw = readFileSync(deployYamlPath, 'utf8');

  it('parses without error', () => {
    expect(() => parseDeployConfig(raw)).not.toThrow();
  });

  it('dispatches release-all.yml AND watches it to completion (not fire-and-forget)', () => {
    const cfg = parseDeployConfig(raw);
    const prod = resolveDeployEnvironment(cfg, 'production');
    const step = prod.steps.find((s) => s.githubWorkflow);
    expect(step, 'production must use a github_workflow step, not a bare `run:`').toBeTruthy();
    expect(step!.githubWorkflow).toEqual({
      workflow: 'release-all.yml',
      ref: 'main',
      inputs: { bump: 'patch' },
    });
    // The compiled run must actually poll the run to completion.
    expect(step!.run).toContain('gh run watch');
    expect(step!.run).toContain('--exit-status');
  });
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
