import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * sync-hub-env.sh is the CI side of the Hub env sync. Its managed-key inventory
 * decides what the live host is allowed to DELETE, so the checks around that
 * list are release-blocking rather than advisory: a secret key in the inventory
 * would be wiped from the running .env, and a desired key outside it would be a
 * key we can write but never retract.
 *
 * Run with --dry-run and stubbed `aws` on PATH — nothing leaves the machine.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'ops', 'scripts', 'sync-hub-env.sh');

/**
 * @param unreadable which input file to make unreadable, to model an I/O
 *   failure. `chmod 000` is honest here because the suite runs unprivileged;
 *   root would read it anyway.
 */
function runSync(
  desired: string[],
  managedKeys?: string[],
  runtimeKeys?: string[],
  unreadable?: 'env' | 'managedKeys' | 'runtimeKeys',
) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-hub-env-'));
  const envFile = join(dir, 'managed.env');
  writeFileSync(envFile, `${desired.join('\n')}\n`);

  // --dry-run never invokes either, but the script requires both on PATH.
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const name of ['aws', 'jq']) {
    const stub = join(binDir, name);
    writeFileSync(stub, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(stub, 0o755);
  }

  const args = [
    SCRIPT,
    '--instance-id',
    'i-0123456789abcdef0',
    '--env-file',
    envFile,
    '--remote-path',
    '/home/agenthub/agent-hub/.env',
    '--dry-run',
  ];
  let managedKeysFile = '';
  let runtimeKeysFile = '';
  if (managedKeys) {
    managedKeysFile = join(dir, 'keys.txt');
    writeFileSync(managedKeysFile, `${managedKeys.join('\n')}\n`);
    args.push('--managed-keys-file', managedKeysFile);
  }
  if (runtimeKeys) {
    runtimeKeysFile = join(dir, 'runtime-keys.txt');
    writeFileSync(runtimeKeysFile, `${runtimeKeys.join('\n')}\n`);
    args.push('--runtime-keys-file', runtimeKeysFile);
  }

  // Applied last so the file still exists (the -f guard must pass) but cannot
  // be read, which is what makes grep exit 2 rather than 1.
  if (unreadable) {
    const target = { env: envFile, managedKeys: managedKeysFile, runtimeKeys: runtimeKeysFile }[
      unreadable
    ];
    chmodSync(target, 0o000);
  }

  const res = spawnSync('bash', args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('sync-hub-env.sh input read failures', () => {
  /**
   * grep exits 1 for "no matching lines" and 2+ for a real read failure.
   * Collapsing those with `|| true` is not a harmless default here: an empty
   * desired set alongside an inventory is precisely the instruction that makes
   * the host retract EVERY managed key and restart the live Hub. An unreadable
   * file must never be mistaken for "Terraform wants nothing".
   */
  it('refuses to sync when the env file cannot be read', () => {
    const { status, stdout, stderr } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND'],
      undefined,
      'env',
    );
    expect(status).toBe(2);
    expect(stderr).toContain('failed to read env file');
    // The destructive outcome that must not happen: a payload built from an
    // empty desired set while the inventory says every key is ours to remove.
    expect(stdout).not.toContain('retracting every owned key');
    expect(stdout).not.toContain('HUB_ENV_DESIRED_B64');
  });

  it('refuses to sync when the managed-keys file cannot be read', () => {
    const { status, stdout, stderr } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV'],
      undefined,
      'managedKeys',
    );
    expect(status).toBe(2);
    expect(stderr).toContain('failed to read managed keys file');
    expect(stdout).not.toContain('HUB_ENV_DESIRED_B64');
  });

  it('refuses to sync when the runtime-keys file cannot be read', () => {
    // An unreadable exemption list would silently drop every exemption and fail
    // the host's retraction check instead.
    const { status, stderr } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV'],
      ['NODE_ENV'],
      'runtimeKeys',
    );
    expect(status).toBe(2);
    expect(stderr).toContain('failed to read runtime keys file');
  });

  it('still treats a readable but empty env file as an empty desired set', () => {
    // grep exit 1 is the legitimate case and must keep working: this is the
    // "every managed feature was turned off" retraction.
    const { status, stdout } = runSync([], ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND']);
    expect(status).toBe(0);
    expect(stdout).toContain('retracting every owned key');
  });
});

describe('sync-hub-env.sh secret exclusion', () => {
  /**
   * The desired lines are the ones carrying VALUES into the base64 SSM payload,
   * and an SSM SendCommand body is retained in command history and CloudTrail:
   * anything that reaches it is disclosed to every holder of
   * ssm:GetCommandInvocation and cannot be recalled. Terraform filters these
   * keys out upstream, but this script is the last gate before the payload is
   * built, so it must not trust its input.
   */
  const SECRET = 'do-not-leak-this-value';

  for (const key of [
    'AGENT_HUB_API_KEY',
    'FINALIZE_RUNNER_FLEET_TOKEN',
    'AGENT_HUB_DEFAULT_PASSWORD',
    'SOME_CLIENT_SECRET',
  ]) {
    it(`refuses a desired line for ${key}`, () => {
      const { status, stdout, stderr } = runSync(['NODE_ENV=production', `${key}=${SECRET}`]);
      expect(status).toBe(2);
      expect(stderr).toContain(`refusing to sync secret-bearing key: ${key}`);
      // The whole point: the value must never be echoed, and no payload may be
      // built from it.
      expect(`${stdout}${stderr}`).not.toContain(SECRET);
      expect(stdout).not.toContain('HUB_ENV_DESIRED_B64');
    });
  }

  it('rejects the secret before the payload is constructed', () => {
    // Exit 2 means we bailed during validation, not after building the blob. A
    // base64 payload would hide the value from a plain substring check, so
    // assert the encoded form is absent too.
    const { status, stdout, stderr } = runSync([`AGENT_HUB_API_KEY=${SECRET}`]);
    expect(status).toBe(2);
    const encoded = Buffer.from(`AGENT_HUB_API_KEY=${SECRET}\n`).toString('base64');
    expect(`${stdout}${stderr}`).not.toContain(encoded);
  });

  it('withholds the line when it has no = at all', () => {
    // "${line%%=*}" is NOT a safe stand-in for the key name: with no `=` it
    // expands to the entire line, so naming it in the error prints whatever the
    // operator put there straight into a public CI log.
    const { status, stdout, stderr } = runSync(['NODE_ENV=production', SECRET]);
    expect(status).toBe(2);
    expect(stderr).toContain('malformed env line');
    expect(`${stdout}${stderr}`).not.toContain(SECRET);
  });

  it('withholds the line when the key prefix is not an identifier', () => {
    // A base64 secret ends in `=` padding, so it splits into a "key" that is the
    // secret itself. This is the case a key-name-only error still leaks.
    const blob = `${SECRET}+aGVsbG8vd29ybGQ=`;
    const { status, stdout, stderr } = runSync(['NODE_ENV=production', blob]);
    expect(status).toBe(2);
    expect(stderr).toContain('invalid env key');
    expect(`${stdout}${stderr}`).not.toContain(SECRET);
  });

  it('withholds the contents of a mis-pointed managed-keys file', () => {
    // Passing the env file where the key list was expected must not echo it.
    const { status, stdout, stderr } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV', `SOME_VALUE=${SECRET}`],
    );
    expect(status).toBe(2);
    expect(stderr).toContain('invalid managed key');
    expect(`${stdout}${stderr}`).not.toContain(SECRET);
  });

  it('still names a key once it has been validated as an identifier', () => {
    // Withholding must not go so far that errors become undebuggable: a key that
    // matched the identifier pattern carries no value and is safe to print.
    const { stderr } = runSync(['AGENT_HUB_API_KEY=x']);
    expect(stderr).toContain('AGENT_HUB_API_KEY');
  });

  it('still accepts keys that merely look adjacent', () => {
    // The guard keys off the substring, so a legitimate key must not trip it.
    const { status } = runSync(['AGENT_HUB_PORT=3051', 'ALLOWED_ORIGINS=https://hub.example.com']);
    expect(status).toBe(0);
  });
});

describe('sync-hub-env.sh managed-key inventory', () => {
  it('forwards the inventory to the host script', () => {
    const { status, stdout } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND'],
    );
    expect(status).toBe(0);
    expect(stdout).toContain('export HUB_ENV_MANAGED_KEYS_B64=');
  });

  it('reports the keys Terraform stopped emitting', () => {
    const { stdout } = runSync(['NODE_ENV=production'], ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND']);
    expect(stdout).toContain('Keys no longer emitted by Terraform');
    expect(stdout).toContain('FINALIZE_RUNNER_BACKEND');
  });

  it('refuses an inventory containing a secret-bearing key', () => {
    // Secrets never travel this path (SSM payloads are retained in CloudTrail),
    // so Terraform never emits them — owning one would mean deleting it.
    const { status, stderr } = runSync(['NODE_ENV=production'], ['NODE_ENV', 'AGENT_HUB_API_KEY']);
    expect(status).toBe(2);
    expect(stderr).toContain('secret-bearing key: AGENT_HUB_API_KEY');
  });

  it('refuses a desired key that the inventory does not own', () => {
    const { status, stderr } = runSync(
      ['NODE_ENV=production', 'AGENT_HUB_PORT=3051'],
      ['NODE_ENV'],
    );
    expect(status).toBe(2);
    expect(stderr).toContain('not in the managed-key inventory: AGENT_HUB_PORT');
  });

  it('refuses an empty inventory file rather than syncing without removal', () => {
    const { status, stderr } = runSync(['NODE_ENV=production'], ['']);
    expect(status).toBe(2);
    expect(stderr).toContain('managed keys file is empty');
  });

  it('retracts every owned key when the desired file is empty', () => {
    // Disabling the LAST managed feature renders no lines at all. Exiting early
    // on an empty desired file is what would leave the stale values on the host.
    const { status, stdout } = runSync([], ['NODE_ENV', 'FINALIZE_RUNNER_BACKEND']);
    expect(status).toBe(0);
    expect(stdout).toContain('retracting every owned key');
    expect(stdout).toContain('FINALIZE_RUNNER_BACKEND');
    expect(stdout).toContain('export HUB_ENV_MANAGED_KEYS_B64=');
    // Nothing to upsert, so no per-key listing is printed for the desired set.
    expect(stdout).not.toContain('Managed keys for i-0123456789abcdef0');
  });

  it('still no-ops on an empty desired file when there is no inventory', () => {
    const { status, stdout } = runSync([]);
    expect(status).toBe(0);
    expect(stdout).toContain('nothing to do');
  });

  it('forwards the retraction-check exemptions to the host script', () => {
    const { status, stdout } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV', 'AGENT_HUB_PREVIEW_HEALTH_HOST'],
      ['AGENT_HUB_PREVIEW_HEALTH_HOST'],
    );
    expect(status).toBe(0);
    expect(stdout).toContain('Keys exempt from the retraction check');
    expect(stdout).toContain('AGENT_HUB_PREVIEW_HEALTH_HOST');
    expect(stdout).toMatch(/export HUB_ENV_RUNTIME_KEYS_B64='.+'/);
  });

  it('refuses to exempt a key the inventory does not own', () => {
    // A typo here would silently widen the retraction check's blind spot.
    const { status, stderr } = runSync(
      ['NODE_ENV=production'],
      ['NODE_ENV'],
      ['AGENT_HUB_PREVIEW_HEALTH_HSOT'],
    );
    expect(status).toBe(2);
    expect(stderr).toContain('not in the managed-key inventory: AGENT_HUB_PREVIEW_HEALTH_HSOT');
  });

  it('sends no exemptions when none are supplied', () => {
    const { status, stdout } = runSync(['NODE_ENV=production'], ['NODE_ENV']);
    expect(status).toBe(0);
    expect(stdout).toContain("export HUB_ENV_RUNTIME_KEYS_B64=''");
  });

  it('still syncs without an inventory, and says removal is off', () => {
    const { status, stdout } = runSync(['NODE_ENV=production']);
    expect(status).toBe(0);
    expect(stdout).toContain('stale managed keys will NOT be removed');
    expect(stdout).toContain("export HUB_ENV_MANAGED_KEYS_B64=''");
  });
});
