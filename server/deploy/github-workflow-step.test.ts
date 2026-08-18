import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  GITHUB_RUN_MARKER,
  GITHUB_RELEASE_VERSION_MARKER,
  compileGithubWorkflowRun,
  compileGithubWorkflowResumeRun,
  parseGithubRunMarker,
  parseReleaseVersionMarker,
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
    expect(script).toContain('polling run status directly');
    expect(script).toContain(GITHUB_RUN_MARKER);
    expect(script.indexOf(GITHUB_RUN_MARKER)).toBeLessThan(script.indexOf('gh run watch'));
    expect(script).toContain('RUN_STATUS="$(gh run view "${RUN_ID}" --json status');
    expect(script).toContain('RUN_CONCLUSION="$(gh run view "${RUN_ID}" --json conclusion');
  });

  it('falls back to run-view polling when gh run watch exits before a successful workflow completes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'github-workflow-step-'));
    try {
      const fakeGh = path.join(dir, 'gh');
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${dir}"
if [ "$1 $2" = "workflow run" ]; then
  touch "$STATE_DIR/dispatched"
  exit 0
fi
if [ "$1 $2" = "run list" ]; then
  if [ -f "$STATE_DIR/dispatched" ]; then
    printf '77\\n'
  else
    printf '[]\\n'
  fi
  exit 0
fi
if [ "$1 $2" = "run watch" ]; then
  echo "context canceled" >&2
  exit 1
fi
if [ "$1 $2" = "run view" ]; then
  args="$*"
  count_file="$STATE_DIR/status-count"
  count=0
  if [ -f "$count_file" ]; then count="$(cat "$count_file")"; fi
  if [[ "$args" == *"--json status"* ]]; then
    if [ "$count" -eq 0 ]; then
      echo 1 > "$count_file"
      printf 'in_progress\\n'
    else
      printf 'completed\\n'
    fi
    exit 0
  fi
  if [[ "$args" == *"--json conclusion"* ]]; then
    if [ "$count" -eq 0 ]; then
      printf '\\n'
    else
      printf 'success\\n'
    fi
    exit 0
  fi
  if [ "$count" -eq 0 ]; then
    printf '{"runId":"77","url":"https://github.com/o/r/actions/runs/77","status":"in_progress","conclusion":null,"workflowName":"Release","displayTitle":"Release"}\\n'
  else
    printf '{"runId":"77","url":"https://github.com/o/r/actions/runs/77","status":"completed","conclusion":"success","workflowName":"Release","displayTitle":"Release"}\\n'
  fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 2
`,
      );
      chmodSync(fakeGh, 0o755);

      const script = compileGithubWorkflowRun({
        workflow: 'release.yml',
        ref: 'main',
        pollIntervalSeconds: 0,
      });
      const stdout = execFileSync('bash', ['-c', script], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(stdout).toContain(`${GITHUB_RUN_MARKER}`);
      expect(stdout).toContain('"status":"completed"');
      expect(stdout).toContain('"conclusion":"success"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('captures a NEWLY-published release tag only, on success, after the run is watched', () => {
    const script = compileGithubWorkflowRun({ workflow: 'release.yml', ref: 'main' });
    // Snapshot pre-existing release tags BEFORE dispatch...
    expect(script).toContain(`PRE_RELEASE_TAGS="$(gh release list --limit 100 --json tagName`);
    expect(script.indexOf('PRE_RELEASE_TAGS=')).toBeLessThan(script.indexOf('gh workflow run'));
    // ...then, on success, pick the newest release tag NOT in that snapshot.
    expect(script).toContain('inside(${PRE_RELEASE_TAGS}) | not');
    expect(script).toContain(GITHUB_RELEASE_VERSION_MARKER);
    // Only emitted after the run is watched to completion, never before dispatch.
    expect(script.indexOf(GITHUB_RELEASE_VERSION_MARKER)).toBeGreaterThan(
      script.indexOf('gh run watch'),
    );
    // Gated behind a success exit — sits between the success guard and its `exit 0`.
    expect(script).toMatch(/if \[ "\$\{WATCH_EXIT\}" -eq 0 \]; then[\s\S]*?REL_TAG=[\s\S]*?exit 0/);
  });

  it('emits the release marker only when the run publishes a NEW release', () => {
    // The fake gh distinguishes the pre-dispatch snapshot (`--json tagName`) from
    // the post-run resolution (`--json tagName,createdAt`, which the compiled
    // script filters with `inside(PRE_RELEASE_TAGS) | not`). `newRel` is what that
    // filter would resolve to: a tag for "published a new release", '' otherwise.
    const runFixture = (watchExit: number, newRel: string) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'github-workflow-rel-'));
      try {
        const fakeGh = path.join(dir, 'gh');
        writeFileSync(
          fakeGh,
          `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${dir}"
if [ "$1 $2" = "workflow run" ]; then touch "$STATE_DIR/dispatched"; exit 0; fi
if [ "$1 $2" = "run list" ]; then
  if [ -f "$STATE_DIR/dispatched" ]; then printf '77\\n'; else printf '[]\\n'; fi
  exit 0
fi
if [ "$1 $2" = "run watch" ]; then exit ${watchExit}; fi
if [ "$1 $2" = "run view" ]; then
  args="$*"
  if [[ "$args" == *"--json status"* ]]; then printf 'completed\\n'; exit 0; fi
  if [[ "$args" == *"--json conclusion"* ]]; then printf '${watchExit === 0 ? 'success' : 'failure'}\\n'; exit 0; fi
  printf '{"runId":"77","status":"completed","conclusion":"${watchExit === 0 ? 'success' : 'failure'}"}\\n'
  exit 0
fi
if [ "$1 $2" = "release list" ]; then
  args="$*"
  if [[ "$args" == *"createdAt"* ]]; then printf '${newRel}\\n'; else printf '["v9.9.8"]\\n'; fi
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 2
`,
        );
        chmodSync(fakeGh, 0o755);
        const script = compileGithubWorkflowRun({
          workflow: 'release.yml',
          ref: 'main',
          pollIntervalSeconds: 0,
        });
        try {
          return execFileSync('bash', ['-c', script], {
            cwd: dir,
            env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err: any) {
          // A failing workflow makes the step exit non-zero; keep its stdout.
          return String(err.stdout ?? '');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    // Success AND a newly-published release → marker with that tag.
    expect(runFixture(0, 'v9.9.9')).toContain(`${GITHUB_RELEASE_VERSION_MARKER}v9.9.9`);
    // Success but NO new release (e.g. a dev rollout step) → no marker, so no
    // stale pre-existing version is stamped onto the deployment.
    expect(runFixture(0, '')).not.toContain(GITHUB_RELEASE_VERSION_MARKER);
    // Failed run never reaches the success path → no marker.
    expect(runFixture(1, 'v9.9.9')).not.toContain(GITHUB_RELEASE_VERSION_MARKER);
  });
});

describe('compileGithubWorkflowResumeRun', () => {
  it('watches a persisted run id without dispatching a new workflow', () => {
    const script = compileGithubWorkflowResumeRun({ runId: '4242', pollIntervalSeconds: 20 });
    expect(script).toContain(`RUN_ID='4242'`);
    expect(script).toContain('gh run watch "${RUN_ID}" --interval "${POLL}" --exit-status');
    expect(script).toContain('POLL=20');
    expect(script).toContain(GITHUB_RUN_MARKER);
    expect(script).not.toContain('gh workflow run');
  });

  it('rediscovers a legacy interrupted workflow run without dispatching', () => {
    const script = compileGithubWorkflowResumeRun({
      workflow: 'release.yml',
      ref: 'main',
      createdAfter: '2026-07-01T00:00:00Z',
    });
    expect(script).toContain(`WORKFLOW='release.yml'`);
    expect(script).toContain(`REF='main'`);
    expect(script).toContain(`CREATED_AFTER='2026-07-01T00:00:00Z'`);
    expect(script).toContain('gh run list --workflow "${WORKFLOW}" --branch "${REF}"');
    expect(script).not.toContain('gh workflow run');
  });

  it('distinguishes a lookup failure from a confirmed-empty rediscovery and never claims nothing ran', () => {
    // Regression: a Hub self-deploy restart can interrupt a github_workflow step
    // after it is marked running but before `gh workflow run` records a run id.
    // Recovery rediscovers by time; an empty RUN_ID can mean EITHER the CLI failed
    // (auth/network/rate limit — `2>/dev/null`) OR the listing was genuinely empty.
    // Neither proves nothing ran (a just-dispatched run can be briefly unlistable),
    // so recovery must NOT categorically assure the operator no release happened —
    // re-running a gated deploy on that false assurance could double-release.
    const script = compileGithubWorkflowResumeRun({
      workflow: 'release-all.yml',
      ref: 'main',
      createdAfter: '2026-08-18T02:33:37Z',
    });
    // The gh exit status is captured separately, not folded into `|| true`.
    expect(script).toContain('LOOKUP_OK=1');
    expect(script).toContain('|| LOOKUP_OK=0');
    expect(script).toContain('if [ "${LOOKUP_OK}" -eq 1 ]; then');
    // Lookup-failure branch: cannot determine dispatch state.
    expect(script).toContain('gh run list failed');
    expect(script).toContain('cannot determine whether a release was dispatched');
    // Confirmed-empty branch stays hedged, not categorical.
    expect(script).toContain('was listed created at/after');
    expect(script).toContain('a just-dispatched run can be briefly unlistable');
    expect(script).toContain('This does not confirm a release was or was not dispatched');
    // Both branches steer the operator to verify before re-running.
    expect(script).toContain('Check the Actions tab');
    // No residual categorical assurance that nothing ran.
    expect(script).not.toContain('so no release was dispatched');
    expect(script).not.toContain('nothing released');
    // Still keeps the stable log prefix the orchestrator asserts on.
    expect(script).toContain('github_workflow recovery:');
    // Recovery never dispatches — no double-release, gate stays intact.
    expect(script).not.toContain('gh workflow run');
    // Both empty-run-id branches still fail the step.
    expect(script).toContain('exit 1');
  });

  it('never captures a release version (no pre-dispatch snapshot on recovery)', () => {
    const byRunId = compileGithubWorkflowResumeRun({ runId: '4242' });
    const byRediscovery = compileGithubWorkflowResumeRun({
      workflow: 'release.yml',
      ref: 'main',
      createdAfter: '2026-07-01T00:00:00Z',
    });
    for (const script of [byRunId, byRediscovery]) {
      expect(script).not.toContain(GITHUB_RELEASE_VERSION_MARKER);
      expect(script).not.toContain('PRE_RELEASE_TAGS');
    }
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

describe('parseReleaseVersionMarker', () => {
  it('parses the release tag from the marker line', () => {
    expect(
      parseReleaseVersionMarker(['noise', `${GITHUB_RELEASE_VERSION_MARKER}v2.31.18`, 'more']),
    ).toBe('v2.31.18');
  });

  it('takes the LAST marker and trims surrounding whitespace', () => {
    expect(
      parseReleaseVersionMarker([
        `${GITHUB_RELEASE_VERSION_MARKER}v1.0.0`,
        `${GITHUB_RELEASE_VERSION_MARKER}  v1.0.1  `,
      ]),
    ).toBe('v1.0.1');
  });

  it('returns null when no marker is present or the value is empty', () => {
    expect(parseReleaseVersionMarker(['build output'])).toBeNull();
    expect(parseReleaseVersionMarker([`${GITHUB_RELEASE_VERSION_MARKER}   `])).toBeNull();
  });
});
