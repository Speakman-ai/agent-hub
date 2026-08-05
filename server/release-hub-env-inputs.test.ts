import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * The release job turns Terraform outputs into the inputs of the SSM env sync,
 * and an EMPTY hub_env_managed is a valid instruction there meaning "retract
 * every managed key". That makes a swallowed `terraform output` failure a
 * production incident rather than a hiccup: the live Hub would be stripped of
 * its configuration and restarted.
 *
 * String-matching the workflow cannot catch that, so this executes the step's
 * real shell body with `terraform` stubbed to fail or return whatever a case
 * needs, and asserts on what the step decides.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'release-all.yml');
const STEP_NAME = 'Collect Hub env sync inputs';

/** Pull the step's `run: |` block out of the workflow and dedent it. */
function stepScript(): string {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n');
  const nameIdx = lines.findIndex((l) => l.trim() === `- name: ${STEP_NAME}`);
  expect(nameIdx, `step "${STEP_NAME}" not found`).toBeGreaterThanOrEqual(0);

  const runIdx = lines.findIndex((l, i) => i > nameIdx && l.trim() === 'run: |');
  expect(runIdx, 'run block not found').toBeGreaterThan(nameIdx);

  const indent = lines[runIdx].length - lines[runIdx].trimStart().length + 2;
  const body: string[] = [];
  for (const line of lines.slice(runIdx + 1)) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

interface Outputs {
  [name: string]: string | null;
}

/**
 * @param outputs terraform outputs by name; a name mapped to `undefined` (i.e.
 *   absent from the map) makes `terraform output` FAIL for it, which is the
 *   transient-failure case the old `|| true` erased.
 */
function runStep(outputs: Outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'hubenv-step-'));
  const binDir = join(dir, 'bin');
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });

  const githubOutput = join(dir, 'github-output.txt');
  writeFileSync(githubOutput, '');

  // Stub terraform. BOTH -json and -raw are served so this harness stays valid
  // against either form of the step, which is what makes a run against the
  // previous version of the workflow a fair comparison rather than an artifact
  // of the stub. Semantics match the real CLI: -raw errors on a null value and
  // emits no trailing newline, -json renders null as JSON null, and an
  // unconfigured name errors either way.
  //
  // Values are staged as FILES the stub cats, not interpolated into the script:
  // a value containing `\n` would otherwise reach the stub as a literal
  // backslash-n and quietly misrepresent what terraform returned.
  const outDir = join(dir, 'tf-outputs');
  mkdirSync(outDir, { recursive: true });
  for (const [name, value] of Object.entries(outputs)) {
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(value));
    if (value !== null) writeFileSync(join(outDir, `${name}.raw`), value);
  }

  const tf = join(binDir, 'terraform');
  writeFileSync(
    tf,
    [
      '#!/usr/bin/env bash',
      `out="${outDir}"`,
      '[ "$1" = "output" ] || exit 0',
      'name="$3"',
      'case "$2" in',
      '  -json)',
      '    [ -f "$out/$name.json" ] || { echo "Error: Output \\"$name\\" not found" >&2; exit 1; }',
      '    cat "$out/$name.json"',
      '    ;;',
      '  -raw)',
      '    [ -f "$out/$name.json" ] || { echo "Error: Output \\"$name\\" not found" >&2; exit 1; }',
      '    [ -f "$out/$name.raw" ] || { echo "Error: Unsupported value for raw output" >&2; exit 1; }',
      '    cat "$out/$name.raw"',
      '    ;;',
      '  *) exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(tf, 0o755);

  const res = spawnSync('bash', ['-c', stepScript()], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: githubOutput,
    },
  });

  const outputsWritten = Object.fromEntries(
    readFileSync(githubOutput, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const readFile = (name: string) => {
    try {
      return readFileSync(join(runnerTemp, name), 'utf8');
    } catch {
      return null;
    }
  };

  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    outputs: outputsWritten,
    managed: readFile('hub-env-managed.env'),
    managedKeys: readFile('hub-env-managed-keys.txt'),
    runtimeKeys: readFile('hub-env-runtime-keys.txt'),
  };
}

const HEALTHY: Outputs = {
  instance_id: 'i-0123456789abcdef0',
  hub_env_file_path: '/home/agenthub/agent-hub/.env',
  hub_env_managed: 'NODE_ENV=production\nAGENT_HUB_PORT=3051',
  hub_env_managed_keys: 'NODE_ENV\nAGENT_HUB_PORT\nFINALIZE_RUNNER_BACKEND',
  hub_env_runtime_injected_keys: 'NODE_ENV',
};

describe('release-all.yml — Collect Hub env sync inputs', () => {
  it('passes every input through on a healthy stack', () => {
    const r = runStep(HEALTHY);
    expect(r.status).toBe(0);
    expect(r.outputs.syncable).toBe('true');
    expect(r.outputs.instance_id).toBe('i-0123456789abcdef0');
    expect(r.outputs.env_path).toBe('/home/agenthub/agent-hub/.env');
    expect(r.managed).toBe('NODE_ENV=production\nAGENT_HUB_PORT=3051\n');
    expect(r.managedKeys).toBe('NODE_ENV\nAGENT_HUB_PORT\nFINALIZE_RUNNER_BACKEND\n');
    expect(r.runtimeKeys).toBe('NODE_ENV\n');
  });

  it('fails the job when hub_env_managed cannot be read', () => {
    // The incident: the inventory succeeds, the desired set does not. Swallowed,
    // that becomes an empty desired set, which the sync reads as "retract every
    // managed key" and applies to the live Hub.
    const { hub_env_managed: _dropped, ...broken } = HEALTHY;
    const r = runStep(broken);
    expect(r.status).not.toBe(0);
    expect(r.outputs.syncable).not.toBe('true');
  });

  it('fails rather than syncing when hub_env_managed is empty on a live stack', () => {
    // A stack that renders a .env always renders NODE_ENV and friends, so empty
    // here means the data is wrong, not that Terraform wants nothing.
    const r = runStep({ ...HEALTHY, hub_env_managed: '' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('hub_env_managed');
    expect(r.outputs.syncable).not.toBe('true');
  });

  it('fails when the managed-key inventory cannot be read', () => {
    const { hub_env_managed_keys: _dropped, ...broken } = HEALTHY;
    const r = runStep(broken);
    expect(r.status).not.toBe(0);
    expect(r.outputs.syncable).not.toBe('true');
  });

  it('fails when the runtime-injected key list cannot be read', () => {
    // Missing exemptions would fail the host's retraction check on every
    // pinned key, so this must not degrade silently either.
    const { hub_env_runtime_injected_keys: _dropped, ...broken } = HEALTHY;
    const r = runStep(broken);
    expect(r.status).not.toBe(0);
    expect(r.outputs.syncable).not.toBe('true');
  });

  it('fails when the instance id cannot be read', () => {
    const { instance_id: _dropped, ...broken } = HEALTHY;
    const r = runStep(broken);
    expect(r.status).not.toBe(0);
    expect(r.outputs.syncable).not.toBe('true');
  });

  it('fails when the env path lookup errors', () => {
    // Distinct from a null path: an ERROR here previously produced an empty
    // ENV_PATH and a quiet skip, so a release could go green having synced
    // nothing.
    const { hub_env_file_path: _dropped, ...broken } = HEALTHY;
    const r = runStep(broken);
    expect(r.status).not.toBe(0);
    expect(r.outputs.syncable).not.toBe('true');
  });

  it('skips quietly when the stack legitimately renders no .env', () => {
    // hub_env_file_path is null on those stacks. This is the one case where a
    // missing value is expected, and it must not fail the release.
    const r = runStep({ ...HEALTHY, hub_env_file_path: null, hub_env_managed: '' });
    expect(r.status).toBe(0);
    expect(r.outputs.syncable).toBe('false');
    expect(r.stdout).toContain('renders no Hub .env');
  });

  it('never writes an input file unless the sync is going ahead', () => {
    // A stale file from a failed run must not be able to feed a later step.
    const r = runStep({ ...HEALTHY, hub_env_managed: '' });
    expect(r.status).not.toBe(0);
    expect(r.managed).toBeNull();
    expect(r.managedKeys).toBeNull();
    expect(r.runtimeKeys).toBeNull();
  });
});
