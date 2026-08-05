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
 * The stubs model a real container rather than a fixed answer sheet: the
 * container has its own environment, fixed at creation, which only a RECREATE
 * refreshes from the current .env. That is the whole subject under test, so
 * faking a post-restart answer directly would test nothing.
 *
 * @param existing   initial .env contents
 * @param desired    KEY=VALUE lines Terraform wants applied
 * @param opts.managedKeys the managed-key inventory; owned keys absent from
 *   `desired` are removed from the file. Omitted → removal is disabled.
 * @param opts.runtimeKeys keys the script is told are supplied outside .env, so
 *   they are exempt from the retraction check.
 * @param opts.pinned keys something other than .env supplies (a `docker run -e`
 *   flag or an image ENV line). They survive every recreate and beat .env, which
 *   is exactly how docker treats them.
 * @param opts.restartRecreates set false to model a unit that restarts the
 *   EXISTING container: its environment and creation stamp are untouched, so no
 *   .env change reaches the process.
 * @param opts.containerEnv overrides for the environment of the container that
 *   is already running when the script starts. Use it to model a container that
 *   has drifted from the file, e.g. after a previous sync failed mid-way.
 * @param opts.missingInContainer keys dropped from the container on recreate, to
 *   model a rollout where a key never made it in.
 * @param opts.containerCreated explicit RFC3339 creation stamp override.
 */
function runUpsert(
  existing: string,
  desired: string[],
  opts: {
    missingInContainer?: string[];
    managedKeys?: string[];
    containerEnv?: Record<string, string>;
    containerCreated?: string;
    runtimeKeys?: string[];
    pinned?: Record<string, string>;
    restartRecreates?: boolean;
  } = {},
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'hub-env-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, existing);

  const binDir = join(dir, 'bin');
  const callLog = join(dir, 'calls.log');
  writeFileSync(callLog, '');

  const pinned = opts.pinned ?? {};
  const recreates = opts.restartRecreates !== false;

  // The environment of the container that is ALREADY running: whatever the
  // current .env says, plus the keys pinned outside it, plus any explicit drift.
  const running = new Map<string, string>();
  for (const line of existing.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      running.set(line.slice(0, eq), line.slice(eq + 1));
    }
  }
  for (const [key, value] of Object.entries(pinned)) running.set(key, value);
  for (const [key, value] of Object.entries(opts.containerEnv ?? {})) running.set(key, value);

  const containerEnvFile = join(dir, 'container.env');
  const createdFile = join(dir, 'created.txt');
  const pinnedFile = join(dir, 'pinned.env');
  const missingFile = join(dir, 'missing.keys');
  writeFileSync(
    containerEnvFile,
    [...running].map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
  );
  // The running container predates this run, which is what makes "was it
  // recreated?" a meaningful question.
  writeFileSync(createdFile, `${opts.containerCreated ?? '2020-01-01T00:00:00.000000000Z'}\n`);
  writeFileSync(
    pinnedFile,
    Object.entries(pinned)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
  writeFileSync(missingFile, `${(opts.missingInContainer ?? []).join('\n')}\n`);

  const stubDir = (name: string, body: string) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  };
  spawnSync('mkdir', ['-p', binDir]);
  // Stub systemctl: on restart, a recreating unit rebuilds the container's
  // environment from the CURRENT .env (plus the pinned keys) and stamps a new
  // creation time. A non-recreating unit changes neither.
  stubDir(
    'systemctl',
    [
      `echo "systemctl $*" >> "${callLog}"`,
      `if [ "$1" = "restart" ] && ${recreates ? 'true' : 'false'}; then`,
      `  grep -Ev '^[[:space:]]*(#|$)' "${envFile}" > "${containerEnvFile}" || true`,
      // Pinned keys BEAT the env file, so drop the file's line before appending
      // theirs. That is docker's -e precedence, and getting it backwards would
      // make the stub disagree with the thing under test.
      `  while IFS= read -r p; do`,
      '    [ -n "$p" ] || continue',
      `    grep -v "^\${p%%=*}=" "${containerEnvFile}" > "${containerEnvFile}.tmp" || true`,
      `    mv "${containerEnvFile}.tmp" "${containerEnvFile}"`,
      `    printf '%s\\n' "$p" >> "${containerEnvFile}"`,
      `  done < "${pinnedFile}"`,
      `  while IFS= read -r k; do`,
      '    [ -n "$k" ] || continue',
      `    grep -v "^\${k}=" "${containerEnvFile}" > "${containerEnvFile}.tmp" || true`,
      `    mv "${containerEnvFile}.tmp" "${containerEnvFile}"`,
      `  done < "${missingFile}"`,
      opts.containerCreated
        ? `  printf '%s\\n' "${opts.containerCreated}" > "${createdFile}"`
        : `  date -u +%Y-%m-%dT%H:%M:%S.000000000Z > "${createdFile}"`,
      'fi',
      'exit 0',
    ].join('\n'),
  );
  // Stub docker: `inspect` reports running or the creation stamp; `exec ...
  // printenv KEY` answers from the container's current environment, and exits
  // non-zero when the key is unset.
  stubDir(
    'docker',
    [
      `echo "docker $*" >> "${callLog}"`,
      'if [ "$1" = "inspect" ]; then',
      '  case "$*" in',
      `    *Created*) cat "${createdFile}"; exit 0 ;;`,
      '    *) echo true; exit 0 ;;',
      '  esac',
      'fi',
      'if [ "$1" = "exec" ]; then',
      '  key="${!#}"',
      `  line="$(grep -m1 "^\${key}=" "${containerEnvFile}" || true)"`,
      '  if [ -z "$line" ]; then exit 1; fi',
      '  printf \'%s\\n\' "${line#*=}"',
      '  exit 0',
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
      HUB_ENV_DESIRED_B64: desired.length
        ? Buffer.from(`${desired.join('\n')}\n`).toString('base64')
        : '',
      HUB_ENV_MANAGED_KEYS_B64: opts.managedKeys
        ? Buffer.from(`${opts.managedKeys.join('\n')}\n`).toString('base64')
        : '',
      HUB_ENV_RUNTIME_KEYS_B64: opts.runtimeKeys
        ? Buffer.from(`${opts.runtimeKeys.join('\n')}\n`).toString('base64')
        : '',
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

  describe('when the file already matches but the container does not', () => {
    // A byte-identical file is not proof the Hub is RUNNING that file. A
    // previous sync can rewrite .env and then fail to recreate the container,
    // which leaves the retracted keys live in the process. Exiting on the file
    // comparison alone turns that failure into a green release on the next run.
    const INVENTORY = ['NODE_ENV', 'AGENT_HUB_PORT', 'FINALIZE_RUNNER_BACKEND'];
    const CLEAN_FILE = 'NODE_ENV=production\nAGENT_HUB_PORT=3051\n';
    const DESIRED = ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'];

    it('restarts to converge when a retracted key is still live', () => {
      const { status, stdout, stderr, env, calls } = runUpsert(CLEAN_FILE, DESIRED, {
        managedKeys: INVENTORY,
        // The file no longer has it; the still-running container does.
        containerEnv: { FINALIZE_RUNNER_BACKEND: 'remote' },
      });
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=converged');
      // Reported as a warning, naming the key so the operator can see which
      // feature was still live.
      expect(stderr).toContain('retracted keys are still set');
      expect(stderr).toContain('FINALIZE_RUNNER_BACKEND');
      expect(calls).toContain('systemctl restart agenthub-server');
      // Converging must not rewrite or back up the file; it already agrees.
      expect(env).toBe(CLEAN_FILE);
    });

    it('reports success only after the retraction actually took', () => {
      const { status, stdout } = runUpsert(CLEAN_FILE, DESIRED, {
        managedKeys: INVENTORY,
        containerEnv: { FINALIZE_RUNNER_BACKEND: 'remote' },
      });
      expect(status).toBe(0);
      expect(stdout).toContain('retracted keys are gone');
    });

    it('fails when the converge restart does not recreate the container', () => {
      const { status, stderr } = runUpsert(CLEAN_FILE, DESIRED, {
        managedKeys: INVENTORY,
        containerEnv: { FINALIZE_RUNNER_BACKEND: 'remote' },
        restartRecreates: false,
      });
      expect(status).toBe(1);
      expect(stderr).toContain('reused the existing container instead of recreating it');
    });

    it('converges a stale VALUE too, not just a stale key', () => {
      const { status, stdout, calls } = runUpsert(
        'AGENT_HUB_PORT=3051\n',
        ['AGENT_HUB_PORT=3051'],
        { containerEnv: { AGENT_HUB_PORT: '9999' } },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=converged');
      expect(calls).toContain('systemctl restart agenthub-server');
    });

    it('leaves a genuinely settled host alone', () => {
      // The no-op must stay a no-op: the pipeline runs this on every release.
      const { status, stdout, backups, calls } = runUpsert(CLEAN_FILE, DESIRED, {
        managedKeys: INVENTORY,
      });
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=unchanged');
      expect(stdout).not.toContain('RESULT=converged');
      expect(backups).toEqual([]);
      expect(calls).not.toContain('systemctl restart');
    });

    it('does not converge on a key that is exempt from the retraction check', () => {
      const { status, stdout, calls } = runUpsert(CLEAN_FILE, DESIRED, {
        managedKeys: INVENTORY,
        runtimeKeys: ['FINALIZE_RUNNER_BACKEND'],
        containerEnv: { FINALIZE_RUNNER_BACKEND: 'remote' },
      });
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=unchanged');
      expect(calls).not.toContain('systemctl restart');
    });
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
    // A sed-based upsert would corrupt these; routing the value around the
    // regex does not.
    const { status, env } = runUpsert('ALLOWED_ORIGINS=https://old.example.com\nX=1\n', [
      'ALLOWED_ORIGINS=https://a.example.com,https://b.example.com/&path|pipe',
    ]);
    expect(status).toBe(0);
    expect(env).toContain('ALLOWED_ORIGINS=https://a.example.com,https://b.example.com/&path|pipe');
    expect(env).toContain('X=1');
  });

  describe('values containing backslashes', () => {
    // `awk -v v="$val"` expands escape sequences in the assignment, so these
    // values would be rewritten before ever reaching .env. The container would
    // then receive a configuration Terraform never planned, and the sync would
    // report success. Values must survive byte for byte.
    it('writes a Windows-style path unchanged', () => {
      const value = String.raw`C:\path\to\new\tab`;
      const { status, env } = runUpsert('SOME_PATH=old\n', [`SOME_PATH=${value}`]);
      expect(status).toBe(0);
      expect(env).toBe(`SOME_PATH=${value}\n`);
    });

    it('does not split the line when the value contains \\n', () => {
      // The nastiest form: awk turns `\n` into a real newline, so one managed
      // key becomes two lines and the tail is parsed as a bogus KEY=VALUE pair.
      const value = String.raw`a\nb`;
      const { status, env } = runUpsert('X=1\n', [`GREETING=${value}`]);
      expect(status).toBe(0);
      expect(env).toBe(`X=1\nGREETING=${value}\n`);
      expect(env.split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('preserves doubled and unknown escapes', () => {
      // `\\` collapses to `\` and `\q` is undefined behaviour per POSIX.
      const value = String.raw`\\ and \q and \\\\`;
      const { status, env } = runUpsert('ESCAPES=old\nX=1\n', [`ESCAPES=${value}`]);
      expect(status).toBe(0);
      expect(env).toContain(`ESCAPES=${value}\n`);
      expect(env).toContain('X=1');
    });

    it('preserves a backslash value when appending a new key', () => {
      // The append branch formats the line separately from the replace branch.
      const value = String.raw`d:\logs\new`;
      const { status, env } = runUpsert('X=1\n', [`WIN_LOG_DIR=${value}`]);
      expect(status).toBe(0);
      expect(env).toBe(`X=1\nWIN_LOG_DIR=${value}\n`);
    });

    it('reports unchanged when a backslash value already matches', () => {
      // Corruption on write would make this compare as a change and restart the
      // Hub on every single release.
      const value = String.raw`C:\path\to\new`;
      const { status, stdout, calls } = runUpsert(`SOME_PATH=${value}\n`, [`SOME_PATH=${value}`]);
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=unchanged');
      expect(calls).not.toContain('systemctl restart');
    });
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

  describe('verifying the value actually reached the container', () => {
    // Docker fixes a container's env at CREATION. A unit that restarts the
    // existing container instead of recreating it leaves the old values live,
    // and a presence-only check happily calls that a successful rollout.
    it('fails when a key kept its old value', () => {
      // Recreated, but the run command pins this key with -e, which beats
      // --env-file. Rewriting .env can never move it.
      const { status, stderr } = runUpsert(
        'FINALIZE_FLEET_MAX_AGENTS=16\n',
        ['FINALIZE_FLEET_MAX_AGENTS=128'],
        { pinned: { FINALIZE_FLEET_MAX_AGENTS: '16' } },
      );
      expect(status).toBe(1);
      expect(stderr).toContain('carry a different value');
      expect(stderr).toContain('FINALIZE_FLEET_MAX_AGENTS');
      // The operator needs to be told WHY rather than shown a mystery mismatch.
      expect(stderr).toContain('pinned outside');
    });

    it('blames a container that predates the .env write', () => {
      const { status, stderr } = runUpsert(
        'FINALIZE_FLEET_MAX_AGENTS=16\n',
        ['FINALIZE_FLEET_MAX_AGENTS=128'],
        {
          containerEnv: { FINALIZE_FLEET_MAX_AGENTS: '16' },
          containerCreated: '2020-01-01T00:00:00.000000000Z',
        },
      );
      expect(status).toBe(1);
      expect(stderr).toContain('reused the existing container instead of recreating it');
    });

    it('fails on a container that was not recreated even when every key looks right', () => {
      // Recreation is the invariant every per-key check rests on, so it is
      // asserted on its own rather than inferred from a key mismatch. Here the
      // container reports exactly the desired values and is still a failure.
      const { status, stderr } = runUpsert(
        'FINALIZE_FLEET_MAX_AGENTS=16\n',
        ['FINALIZE_FLEET_MAX_AGENTS=128'],
        { containerCreated: '2020-01-01T00:00:00.000000000Z' },
      );
      expect(status).toBe(1);
      expect(stderr).toContain('reused the existing container instead of recreating it');
    });

    it('accepts a key whose desired value is empty', () => {
      // printenv exits 0 with no output for an empty-but-set var; that is a
      // success, not an absent key.
      const { status, stdout } = runUpsert('ALLOWED_ORIGINS=https://old\n', ['ALLOWED_ORIGINS=']);
      expect(status).toBe(0);
      expect(stdout).toContain('desired keys carry the expected values');
    });

    it('never prints the mismatched values', () => {
      const { stderr, stdout } = runUpsert(
        'AGENT_HUB_ARTIFACTS_BUCKET=old-bucket\n',
        ['AGENT_HUB_ARTIFACTS_BUCKET=super-specific-bucket'],
        {
          containerEnv: { AGENT_HUB_ARTIFACTS_BUCKET: 'old-bucket' },
        },
      );
      expect(`${stdout}${stderr}`).not.toContain('super-specific-bucket');
      expect(`${stdout}${stderr}`).not.toContain('old-bucket');
    });
  });

  describe('rejecting a desired payload that is not KEY=VALUE', () => {
    // Neither "${line%%=*}" nor "${line#*=}" can signal "no match": both return
    // the whole string. So a bare `FOO` derives key=FOO AND val=FOO, and without
    // an explicit separator check the line is silently written as `FOO=FOO` into
    // the file the Hub boots from. The caller validates its payload, but this
    // script is directly invocable and is the last boundary before that file.
    it('refuses a line with no = instead of writing KEY=KEY', () => {
      const { status, stderr, env, calls } = runUpsert('NODE_ENV=production\n', ['FOO']);
      expect(status).toBe(1);
      expect(stderr).toContain("no '=' separator");
      // The specific corruption: a bogus key echoing its own name.
      expect(env).not.toContain('FOO=FOO');
      expect(env).not.toContain('FOO');
      // Rejected before anything was written or restarted.
      expect(env).toBe('NODE_ENV=production\n');
      expect(calls).not.toContain('systemctl restart');
    });

    it('refuses a line whose key is not an identifier', () => {
      const { status, stderr, env } = runUpsert('NODE_ENV=production\n', ['not a key=value']);
      expect(status).toBe(1);
      expect(stderr).toContain('not a valid identifier');
      expect(env).toBe('NODE_ENV=production\n');
    });

    it('refuses an empty key', () => {
      const { status, stderr, env } = runUpsert('NODE_ENV=production\n', ['=orphan-value']);
      expect(status).toBe(1);
      expect(stderr).toContain('not a valid identifier');
      expect(env).toBe('NODE_ENV=production\n');
    });

    it('does not echo the rejected line', () => {
      // A malformed line is the one most likely to be a stray secret, and this
      // output reaches a public CI log.
      const secret = 'super-secret-nonsense';
      const { stdout, stderr } = runUpsert('NODE_ENV=production\n', [secret]);
      expect(`${stdout}${stderr}`).not.toContain(secret);
    });

    it('still accepts a legitimately empty value', () => {
      // `KEY=` has the separator and an empty value, which is valid.
      const { status, env } = runUpsert('NODE_ENV=production\n', ['ALLOWED_ORIGINS=']);
      expect(status).toBe(0);
      expect(env).toContain('ALLOWED_ORIGINS=');
    });

    it('still accepts a value containing =', () => {
      // Only the FIRST `=` separates; base64 padding and query strings must
      // survive intact.
      const value = 'a=b==';
      const { status, env } = runUpsert('NODE_ENV=production\n', [`SOME_BLOB=${value}`]);
      expect(status).toBe(0);
      expect(env).toContain(`SOME_BLOB=${value}\n`);
    });
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

  describe('retracting keys Terraform stopped emitting', () => {
    // Terraform omits a feature's keys entirely once the feature is disabled:
    // enable_finalize_runners = false drops the whole FINALIZE_* group from the
    // desired set. Upsert-only semantics leave the old lines in place, the file
    // compares byte-identical, and the Hub keeps dispatching to the remote
    // runner fleet the operator just turned off.
    const FLEET_KEYS = [
      'FINALIZE_RUNNER_BACKEND',
      'FINALIZE_WORKTREE_BUCKET',
      'FINALIZE_FLEET_MAX_AGENTS',
    ];
    const INVENTORY = ['NODE_ENV', 'AGENT_HUB_PORT', ...FLEET_KEYS];
    const WITH_FLEET = [
      'NODE_ENV=production',
      'FINALIZE_RUNNER_BACKEND=remote',
      'FINALIZE_WORKTREE_BUCKET=hub-worktrees',
      'FINALIZE_FLEET_MAX_AGENTS=16',
      'AGENT_HUB_PORT=3051',
      '',
    ].join('\n');

    it('removes owned keys the desired set no longer carries', () => {
      const { status, stdout, env } = runUpsert(
        WITH_FLEET,
        ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
        { managedKeys: INVENTORY },
      );
      expect(status).toBe(0);
      expect(env).toBe('NODE_ENV=production\nAGENT_HUB_PORT=3051\n');
      for (const key of FLEET_KEYS) {
        expect(stdout).toContain(`removed ${key}`);
      }
    });

    it('restarts the service when the only change is a removal', () => {
      // The whole point: a retraction must reach the running container, not
      // just the file.
      const { stdout, backups, calls } = runUpsert(
        WITH_FLEET,
        ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
        { managedKeys: INVENTORY },
      );
      expect(stdout).toContain('RESULT=changed');
      expect(backups).toHaveLength(1);
      expect(calls).toContain('systemctl restart agenthub-server');
    });

    it('preserves secret and UI-owned keys that are not in the inventory', () => {
      const { env } = runUpsert(
        [
          'AGENT_HUB_API_KEY=super-secret',
          'FINALIZE_RUNNER_FLEET_TOKEN=fleet-secret',
          'AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=false',
          'SERPER_API_KEY=hand-added',
          'FINALIZE_RUNNER_BACKEND=remote',
          '',
        ].join('\n'),
        ['NODE_ENV=production'],
        { managedKeys: INVENTORY },
      );
      expect(env).toContain('AGENT_HUB_API_KEY=super-secret');
      expect(env).toContain('FINALIZE_RUNNER_FLEET_TOKEN=fleet-secret');
      expect(env).toContain('AGENT_HUB_REPLAY_MASK_ALL_ENFORCED=false');
      expect(env).toContain('SERPER_API_KEY=hand-added');
      expect(env).not.toContain('FINALIZE_RUNNER_BACKEND');
    });

    it('stays a no-op when every owned key is already absent', () => {
      const { status, stdout, backups, calls } = runUpsert(
        'NODE_ENV=production\nAGENT_HUB_PORT=3051\n',
        ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
        { managedKeys: INVENTORY },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=unchanged');
      expect(stdout).not.toContain('removed ');
      expect(backups).toEqual([]);
      expect(calls).not.toContain('systemctl restart');
    });

    it('does not remove a longer key that merely shares a prefix', () => {
      const { env } = runUpsert(
        'AGENT_HUB_ARTIFACTS_BUCKET=b1\nAGENT_HUB_ARTIFACTS_BUCKET_REGION=us-east-1\n',
        ['NODE_ENV=production'],
        { managedKeys: ['NODE_ENV', 'AGENT_HUB_ARTIFACTS_BUCKET'] },
      );
      expect(env).not.toMatch(/^AGENT_HUB_ARTIFACTS_BUCKET=/m);
      expect(env).toContain('AGENT_HUB_ARTIFACTS_BUCKET_REGION=us-east-1');
    });

    it('retracts every owned key when Terraform emits nothing at all', () => {
      // The last managed feature going off renders an EMPTY desired set. If the
      // pipeline treats that as "nothing to do", the host keeps every stale
      // value forever.
      const { status, stdout, env, calls } = runUpsert(WITH_FLEET, [], {
        managedKeys: INVENTORY,
      });
      expect(status).toBe(0);
      expect(stdout).toContain('RESULT=changed');
      expect(env).toBe('');
      expect(calls).toContain('systemctl restart agenthub-server');
    });

    it('refuses an empty desired set with no inventory', () => {
      const { status, stderr } = runUpsert(WITH_FLEET, []);
      expect(status).toBe(1);
      expect(stderr).toContain('HUB_ENV_DESIRED_B64 or HUB_ENV_MANAGED_KEYS_B64 is required');
    });

    it('removes nothing when no inventory is supplied', () => {
      // An older caller must degrade to upsert-only rather than delete lines it
      // never claimed to own.
      const { env } = runUpsert(WITH_FLEET, ['NODE_ENV=production']);
      expect(env).toContain('FINALIZE_RUNNER_BACKEND=remote');
    });

    it('fails when a retracted key is still set in the container', () => {
      // The blind spot: a retraction-only release. Every desired key keeps its
      // value, so a presence/value sweep of the desired keys is silent while the
      // disabled feature's variables are still live in the process.
      const { status, stdout, stderr } = runUpsert(
        WITH_FLEET,
        ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
        {
          managedKeys: INVENTORY,
          // Survives the recreate because something outside .env supplies it,
          // and it was never declared as such.
          pinned: { FINALIZE_RUNNER_BACKEND: 'remote' },
        },
      );
      expect(stdout).toContain('RESULT=changed');
      expect(status).toBe(1);
      expect(stderr).toContain('retracted keys are still set in the container');
      expect(stderr).toContain('FINALIZE_RUNNER_BACKEND');
    });

    it('passes when the retracted keys really are gone', () => {
      const { status, stdout } = runUpsert(
        WITH_FLEET,
        ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
        { managedKeys: INVENTORY },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('retracted keys are gone');
    });

    it('exempts keys something other than .env supplies', () => {
      // AGENT_HUB_PREVIEW_HEALTH_HOST is pinned by a docker run -e flag, so it
      // survives removal from .env by design and must not fail the release.
      const { status, stdout } = runUpsert(
        'NODE_ENV=production\nAGENT_HUB_PREVIEW_HEALTH_HOST=host.docker.internal\n',
        ['NODE_ENV=production'],
        {
          managedKeys: ['NODE_ENV', 'AGENT_HUB_PREVIEW_HEALTH_HOST'],
          runtimeKeys: ['AGENT_HUB_PREVIEW_HEALTH_HOST'],
          containerEnv: { AGENT_HUB_PREVIEW_HEALTH_HOST: 'host.docker.internal' },
        },
      );
      expect(status).toBe(0);
      expect(stdout).toContain('exempt AGENT_HUB_PREVIEW_HEALTH_HOST');
    });

    it('does not exempt a key just because some other key is exempt', () => {
      const { status, stderr } = runUpsert(
        WITH_FLEET,
        ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
        {
          managedKeys: INVENTORY,
          runtimeKeys: ['FINALIZE_WORKTREE_BUCKET'],
          pinned: {
            FINALIZE_WORKTREE_BUCKET: 'hub-worktrees',
            FINALIZE_RUNNER_BACKEND: 'remote',
          },
        },
      );
      expect(status).toBe(1);
      expect(stderr).toContain('FINALIZE_RUNNER_BACKEND');
      expect(stderr).not.toContain('FINALIZE_WORKTREE_BUCKET');
    });

    it('rejects a malformed inventory entry instead of guessing', () => {
      const { status, stderr } = runUpsert('NODE_ENV=production\n', ['NODE_ENV=production'], {
        managedKeys: ['NODE_ENV', 'not a key'],
      });
      expect(status).toBe(1);
      expect(stderr).toContain('malformed managed-key inventory entry');
    });

    describe('inventory entries are validated, never normalised', () => {
      // This list drives DELETION. Truncating `FOO=bar` to `FOO` would take a
      // key the caller never named and remove it from the live .env, so a
      // malformed entry has to fail rather than be guessed at.
      it('refuses a KEY=VALUE entry rather than truncating it to KEY', () => {
        const { status, stderr, env, calls } = runUpsert(
          'NODE_ENV=production\nFINALIZE_RUNNER_BACKEND=remote\n',
          ['NODE_ENV=production'],
          { managedKeys: ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND=oops'] },
        );
        expect(status).toBe(1);
        expect(stderr).toContain('malformed managed-key inventory entry');
        // The damage the truncation would have done: retracting a key the
        // entry never legitimately named.
        expect(env).toContain('FINALIZE_RUNNER_BACKEND=remote');
        expect(env).toBe('NODE_ENV=production\nFINALIZE_RUNNER_BACKEND=remote\n');
        expect(calls).not.toContain('systemctl restart');
      });

      it('does not echo the rejected entry', () => {
        const secret = 'super-secret-nonsense';
        const { stdout, stderr } = runUpsert('NODE_ENV=production\n', ['NODE_ENV=production'], {
          managedKeys: ['NODE_ENV', `SOME_KEY=${secret}`],
        });
        expect(`${stdout}${stderr}`).not.toContain(secret);
      });

      it('still accepts a well-formed bare key', () => {
        // Guard against over-strict validation: the normal path must survive.
        const { status, env } = runUpsert(
          'NODE_ENV=production\nFINALIZE_RUNNER_BACKEND=remote\n',
          ['NODE_ENV=production'],
          { managedKeys: ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND'] },
        );
        expect(status).toBe(0);
        expect(env).toBe('NODE_ENV=production\n');
      });
    });
  });

  it('never prints managed values', () => {
    const { stdout } = runUpsert('X=1\n', ['AGENT_HUB_ARTIFACTS_BUCKET=super-specific-bucket']);
    expect(stdout).toContain('managed AGENT_HUB_ARTIFACTS_BUCKET');
    expect(stdout).not.toContain('super-specific-bucket');
  });
});
