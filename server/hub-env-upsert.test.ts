import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * hub-env-upsert.remote.sh is what the release pipeline executes on the live Hub
 * to adopt Terraform env changes without replacing the instance. It edits a file
 * the Hub boots from and restarts the service, so its semantics are pinned here:
 * in-place replacement, order preservation, value safety, and — most importantly
 * — no restart when nothing changed (the pipeline runs it on every release).
 *
 * The script is executed for real against a throwaway .env, with `systemctl` and
 * `docker` stubbed on PATH so nothing touches the host.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'ops', 'scripts', 'hub-env-upsert.remote.sh');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  env: string;
  backups: string[];
  calls: string;
}

/**
 * @param existing   initial .env contents
 * @param desired    KEY=VALUE lines Terraform wants applied
 * @param opts.missingInContainer keys the stubbed `docker exec printenv` should fail for
 */
function runUpsert(
  existing: string,
  desired: string[],
  opts: { missingInContainer?: string[] } = {},
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'hub-env-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, existing);

  const binDir = join(dir, 'bin');
  const callLog = join(dir, 'calls.log');
  writeFileSync(callLog, '');

  // Stub systemctl: record invocations, always succeed.
  const stubDir = (name: string, body: string) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  };
  spawnSync('mkdir', ['-p', binDir]);
  stubDir('systemctl', `echo "systemctl $*" >> "${callLog}"\nexit 0`);
  // Stub docker: `inspect` reports running; `exec ... printenv KEY` fails for the
  // keys the caller marked absent, which is how the script detects a bad rollout.
  const missing = (opts.missingInContainer ?? []).join(' ');
  stubDir(
    'docker',
    [
      `echo "docker $*" >> "${callLog}"`,
      'if [ "$1" = "inspect" ]; then echo true; exit 0; fi',
      'if [ "$1" = "exec" ]; then',
      '  key="${!#}"',
      `  for m in ${missing}; do`,
      '    if [ "$m" = "$key" ]; then exit 1; fi',
      '  done',
      '  echo "$key"; exit 0',
      'fi',
      'exit 0',
    ].join('\n'),
  );

  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HUB_ENV_FILE: envFile,
      HUB_ENV_DESIRED_B64: Buffer.from(`${desired.join('\n')}\n`).toString('base64'),
      HUB_ENV_CONTAINER: 'agenthub-server',
      HUB_ENV_SERVICE: 'agenthub-server',
    },
  });

  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    env: readFileSync(envFile, 'utf8'),
    backups: readdirSync(dir).filter((f) => f.startsWith('.env.bak.')),
    calls: readFileSync(callLog, 'utf8'),
  };
}

describe('hub-env-upsert.remote.sh', () => {
  it('replaces an existing key in place, preserving line order', () => {
    const { status, env } = runUpsert(
      'NODE_ENV=production\nFINALIZE_FLEET_MAX_AGENTS=16\nAGENT_HUB_PORT=3051\n',
      ['FINALIZE_FLEET_MAX_AGENTS=128'],
    );
    expect(status).toBe(0);
    expect(env).toBe('NODE_ENV=production\nFINALIZE_FLEET_MAX_AGENTS=128\nAGENT_HUB_PORT=3051\n');
  });

  it('appends a key that is not present yet', () => {
    const { status, env } = runUpsert('NODE_ENV=production\n', [
      'FINALIZE_FLEET_DYNAMIC_SCALE_DOWN=1',
    ]);
    expect(status).toBe(0);
    expect(env).toBe('NODE_ENV=production\nFINALIZE_FLEET_DYNAMIC_SCALE_DOWN=1\n');
  });

  it('leaves unmanaged keys untouched', () => {
    // The mask-all flag is UI-owned and excluded from the managed set; a sync
    // must never remove or rewrite it.
    const { env } = runUpsert(
      'AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=false\nSERPER_API_KEY=hand-added\nFINALIZE_FLEET_MAX_AGENTS=16\n',
      ['FINALIZE_FLEET_MAX_AGENTS=128'],
    );
    expect(env).toContain('AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=false');
    expect(env).toContain('SERPER_API_KEY=hand-added');
  });

  it('does not restart or back up when the result is identical', () => {
    const { status, stdout, backups, calls } = runUpsert(
      'NODE_ENV=production\nFINALIZE_FLEET_MAX_AGENTS=128\n',
      ['FINALIZE_FLEET_MAX_AGENTS=128'],
    );
    expect(status).toBe(0);
    expect(stdout).toContain('RESULT=unchanged');
    expect(backups).toEqual([]);
    expect(calls).not.toContain('systemctl restart');
  });

  it('restarts the service and backs up the file when something changed', () => {
    const { status, stdout, backups, calls } = runUpsert('FINALIZE_FLEET_MAX_AGENTS=16\n', [
      'FINALIZE_FLEET_MAX_AGENTS=128',
    ]);
    expect(status).toBe(0);
    expect(stdout).toContain('RESULT=changed');
    expect(backups).toHaveLength(1);
    expect(calls).toContain('systemctl restart agenthub-server');
  });

  it('handles values containing regex/sed metacharacters', () => {
    // A sed-based upsert would corrupt these; awk with -v does not.
    const { status, env } = runUpsert('ALLOWED_ORIGINS=https://old.example.com\nX=1\n', [
      'ALLOWED_ORIGINS=https://a.example.com,https://b.example.com/&path|pipe',
    ]);
    expect(status).toBe(0);
    expect(env).toContain('ALLOWED_ORIGINS=https://a.example.com,https://b.example.com/&path|pipe');
    expect(env).toContain('X=1');
  });

  it('does not partially match a longer key with the same prefix', () => {
    const { env } = runUpsert('AGENT_HUB_ARTIFACTS_BUCKET_REGION=us-east-1\n', [
      'AGENT_HUB_ARTIFACTS_BUCKET=bucket-1',
    ]);
    // The REGION key must survive untouched and the new key be appended.
    expect(env).toContain('AGENT_HUB_ARTIFACTS_BUCKET_REGION=us-east-1');
    expect(env).toContain('AGENT_HUB_ARTIFACTS_BUCKET=bucket-1');
  });

  it('fails when a managed key is absent from the restarted container', () => {
    const { status, stderr } = runUpsert('X=1\n', ['FINALIZE_FLEET_MAX_AGENTS=128'], {
      missingInContainer: ['FINALIZE_FLEET_MAX_AGENTS'],
    });
    expect(status).toBe(1);
    expect(stderr).toContain('FINALIZE_FLEET_MAX_AGENTS');
  });

  it('fails loudly when the target .env does not exist', () => {
    const res = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HUB_ENV_FILE: join(tmpdir(), 'no-such-hub', '.env'),
        HUB_ENV_DESIRED_B64: Buffer.from('X=1\n').toString('base64'),
      },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('does not exist');
  });

  it('never prints managed values', () => {
    const { stdout } = runUpsert('X=1\n', ['AGENT_HUB_ARTIFACTS_BUCKET=super-specific-bucket']);
    expect(stdout).toContain('managed AGENT_HUB_ARTIFACTS_BUCKET');
    expect(stdout).not.toContain('super-specific-bucket');
  });
});
