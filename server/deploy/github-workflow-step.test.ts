import { describe, it, expect } from 'vitest';
import {
  GITHUB_RUN_MARKER,
  compileGithubWorkflowRun,
  parseGithubRunMarker,
  parseGithubWorkflowStepConfig,
} from './github-workflow-step.js';
import { DeployConfigError } from './deploy-config-error.js';

const WHERE = 'environment "production" step 1';

describe('parseGithubWorkflowStepConfig', () => {
  it('parses a minimal spec (workflow + required ref)', () => {
    const spec = parseGithubWorkflowStepConfig({ workflow: 'release.yml', ref: 'main' }, WHERE);
    expect(spec).toEqual({ workflow: 'release.yml', ref: 'main' });
  });

  it('parses ref, inputs, and poll interval, coercing scalar inputs to strings', () => {
    const spec = parseGithubWorkflowStepConfig(
      {
        workflow: 'release.yml',
        ref: 'main',
        inputs: { bump: 'patch', dry_run: true, count: 3 },
        poll_interval_seconds: 15,
      },
      WHERE,
    );
    expect(spec).toEqual({
      workflow: 'release.yml',
      ref: 'main',
      inputs: { bump: 'patch', dry_run: 'true', count: '3' },
      pollIntervalSeconds: 15,
    });
  });

  it('trims workflow and ref', () => {
    const spec = parseGithubWorkflowStepConfig(
      { workflow: '  release.yml  ', ref: ' main ' },
      WHERE,
    );
    expect(spec.workflow).toBe('release.yml');
    expect(spec.ref).toBe('main');
  });

  it.each([
    [{}, 'missing_workflow'],
    [{ workflow: '' }, 'missing_workflow'],
    [{ workflow: 'r.yml' }, 'missing_workflow_ref'],
    [{ workflow: 'r.yml', ref: '' }, 'missing_workflow_ref'],
    [{ workflow: 'r.yml', ref: 'main', inputs: [] }, 'invalid_workflow_inputs'],
    [{ workflow: 'r.yml', ref: 'main', inputs: { 'bad key': 'x' } }, 'invalid_workflow_inputs'],
    [{ workflow: 'r.yml', ref: 'main', inputs: { ok: { nested: 1 } } }, 'invalid_workflow_inputs'],
    [{ workflow: 'r.yml', ref: 'main', poll_interval_seconds: 1 }, 'invalid_workflow_poll'],
    [{ workflow: 'r.yml', ref: 'main', poll_interval_seconds: 99999 }, 'invalid_workflow_poll'],
    [{ workflow: 'r.yml', ref: 'main', poll_interval_seconds: 1.5 }, 'invalid_workflow_poll'],
    [{ workflow: 'r.yml', nope: true }, 'unknown_key'],
    ['not-a-mapping', 'invalid_github_workflow'],
  ])('rejects %j with reason %s', (raw, reason) => {
    try {
      parseGithubWorkflowStepConfig(raw, WHERE);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DeployConfigError);
      expect((err as DeployConfigError).reason).toBe(reason);
    }
  });
});

describe('compileGithubWorkflowRun', () => {
  it('dispatches, resolves the run id, watches to completion, and prints the marker', () => {
    const script = compileGithubWorkflowRun({ workflow: 'release.yml', ref: 'main' });
    expect(script).toContain(`WORKFLOW='release.yml'`);
    expect(script).toContain(`REF='main'`);
    expect(script).toContain('gh workflow run "${WORKFLOW}" --ref "${REF}"');
    expect(script).toContain('gh run list --workflow "${WORKFLOW}" --branch "${REF}"');
    expect(script).toContain('--event workflow_dispatch');
    expect(script).toContain('gh run watch "${RUN_ID}" --interval "${POLL}" --exit-status');
    expect(script).toContain(GITHUB_RUN_MARKER);
    expect(script).toContain('exit "${WATCH_EXIT}"');
  });

  it('resolves the run id by diffing against a pre-dispatch snapshot (no clock dependency)', () => {
    const script = compileGithubWorkflowRun({ workflow: 'release.yml', ref: 'main' });
    // Snapshot existing run ids BEFORE dispatch...
    expect(script).toContain(`PRE_RUN_IDS="$(gh run list`);
    expect(script).toContain(`--jq '[.[].databaseId]'`);
    // ...then pick the newest run id NOT in that snapshot.
    expect(script).toContain('inside(${PRE_RUN_IDS}) | not');
    expect(script).toContain('sort_by(.createdAt) | last');
    // The brittle wall-clock comparison must be gone.
    expect(script).not.toContain('DISPATCH_TS');
    expect(script).not.toContain('date -u');
  });

  it('bakes the required branch/tag ref in and never falls back to an env var', () => {
    const script = compileGithubWorkflowRun({ workflow: 'release.yml', ref: 'release-2' });
    expect(script).toContain(`REF='release-2'`);
    // No deploy-ref env-var default — workflow_dispatch needs a branch/tag.
    expect(script).not.toContain('AGENT_HUB_DEPLOY_REF');
  });

  it('renders workflow_dispatch inputs as -f flags', () => {
    const script = compileGithubWorkflowRun({
      workflow: 'release.yml',
      ref: 'main',
      inputs: { bump: 'patch', note: 'ship it' },
    });
    expect(script).toContain(`-f 'bump=patch'`);
    expect(script).toContain(`-f 'note=ship it'`);
  });

  it('uses the configured poll interval', () => {
    expect(
      compileGithubWorkflowRun({ workflow: 'r.yml', ref: 'main', pollIntervalSeconds: 20 }),
    ).toContain('POLL=20');
    // default
    expect(compileGithubWorkflowRun({ workflow: 'r.yml', ref: 'main' })).toContain('POLL=10');
  });

  it('safely single-quotes a workflow name containing a quote', () => {
    const script = compileGithubWorkflowRun({ workflow: "weird'name.yml", ref: 'main' });
    expect(script).toContain(`WORKFLOW='weird'\\''name.yml'`);
  });
});

describe('parseGithubRunMarker', () => {
  it('parses run info from the marker line', () => {
    const payload = JSON.stringify({
      runId: '123',
      url: 'https://github.com/o/r/actions/runs/123',
      status: 'completed',
      conclusion: 'success',
      workflowName: 'Release',
      displayTitle: 'Release main',
    });
    const result = parseGithubRunMarker(['noise', `${GITHUB_RUN_MARKER}${payload}`, 'tail noise']);
    expect(result).toEqual({
      runId: '123',
      url: 'https://github.com/o/r/actions/runs/123',
      status: 'completed',
      conclusion: 'success',
      workflowName: 'Release',
      displayTitle: 'Release main',
    });
  });

  it('takes the LAST marker when several are present', () => {
    const first = `${GITHUB_RUN_MARKER}${JSON.stringify({ runId: '1' })}`;
    const second = `${GITHUB_RUN_MARKER}${JSON.stringify({ runId: '2' })}`;
    expect(parseGithubRunMarker([first, second])?.runId).toBe('2');
  });

  it('coerces an empty/absent field to null', () => {
    const payload = JSON.stringify({ runId: '9', url: '', conclusion: null });
    const result = parseGithubRunMarker([`${GITHUB_RUN_MARKER}${payload}`]);
    expect(result).toMatchObject({ runId: '9', url: null, conclusion: null });
  });

  it('returns null when no marker is present (plain run step)', () => {
    expect(parseGithubRunMarker(['just', 'build output'])).toBeNull();
  });

  it('returns null on malformed marker JSON', () => {
    expect(parseGithubRunMarker([`${GITHUB_RUN_MARKER}{not json`])).toBeNull();
  });
});
