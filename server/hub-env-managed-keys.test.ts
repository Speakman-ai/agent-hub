import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * `local.hub_env_managed_key_inventory` is the list of .env keys the SSM sync
 * owns — the only keys ops/scripts/hub-env-upsert.remote.sh will delete from the
 * live Hub. It has to stay in lockstep with what Terraform actually renders:
 *
 *   - A rendered key missing from the inventory can be written but never
 *     retracted, so disabling the feature that emits it leaves the old value
 *     running (the FINALIZE_* case).
 *   - A secret-bearing or UI-owned key that leaks into the inventory would be
 *     deleted from the live .env on the next release, since Terraform never
 *     emits it in the managed set.
 *
 * Terraform's own precondition on output.hub_env_managed catches the first case
 * at plan time, but only on a real apply against real vars. This pins both
 * directions in the unit suite, where a drifting edit is caught in seconds.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TF_DIR = join(REPO_ROOT, 'ops', 'terraform');
const LOCALS = readFileSync(join(TF_DIR, 'locals-agent-hub.tf'), 'utf8');
const FINALIZE = readFileSync(join(TF_DIR, 'finalize-hub.tf'), 'utf8');
const OUTPUTS = readFileSync(join(TF_DIR, 'outputs.tf'), 'utf8');
const USER_DATA = readFileSync(join(TF_DIR, 'agent-hub-user-data.tftpl'), 'utf8');
const DOCKERFILE = readFileSync(join(REPO_ROOT, 'server', 'Dockerfile'), 'utf8');

/** Mirrors local.hub_env_secret_key_regex. */
const SECRET_KEY = /(KEY|TOKEN|PASSWORD|SECRET)/;
/** Mirrors local.hub_env_unmanaged_keys. */
const UI_OWNED = ['AGENT_HUB_REPLAY_MASK_ALL_ENFORCED'];

function tfStringList(name: string): string[] {
  const block = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(LOCALS);
  expect(block, `${name} not found in locals-agent-hub.tf`).toBeTruthy();
  return [...(block?.[1] ?? '').matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
}

function inventory(): string[] {
  return tfStringList('hub_env_managed_key_inventory');
}

/** Every KEY= literal the env locals render, e.g. `"FINALIZE_RUNNER_BACKEND=...`. */
function renderedKeys(): string[] {
  const keys = new Set<string>();
  for (const src of [LOCALS, FINALIZE]) {
    for (const m of src.matchAll(/"([A-Z][A-Z0-9_]*)=/g)) keys.add(m[1]);
  }
  return [...keys].sort();
}

describe('hub env managed-key inventory', () => {
  const INVENTORY = inventory();

  it('lists every rendered key that is neither secret-bearing nor UI-owned', () => {
    const unlisted = renderedKeys().filter(
      (k) => !SECRET_KEY.test(k) && !UI_OWNED.includes(k) && !INVENTORY.includes(k),
    );
    expect(
      unlisted,
      'Add these to local.hub_env_managed_key_inventory so the sync can retract them',
    ).toEqual([]);
  });

  it('holds no secret-bearing key', () => {
    // These are withheld from the sync entirely (SSM payloads land in CloudTrail),
    // so Terraform never emits them — listing one would delete it from the host.
    expect(INVENTORY.filter((k) => SECRET_KEY.test(k))).toEqual([]);
  });

  it('holds no key the in-app UI owns', () => {
    expect(INVENTORY.filter((k) => UI_OWNED.includes(k))).toEqual([]);
  });

  it('has no duplicate entries', () => {
    expect(INVENTORY).toEqual([...new Set(INVENTORY)]);
  });

  it('is published as an output the release pipeline can consume', () => {
    expect(OUTPUTS).toContain('output "hub_env_managed_keys"');
    expect(OUTPUTS).toContain('local.hub_env_managed_key_inventory');
  });

  describe('runtime-injected exemptions', () => {
    /**
     * The host fails a release when a retracted key is still set in the
     * container. These are the keys that legitimately survive removal from
     * .env, so the list has to track its two real sources exactly: too small
     * and a correct release fails, too large and a disabled feature can stay
     * live unnoticed.
     */
    const RUNTIME = tfStringList('hub_env_runtime_injected_keys');

    /** `-e "KEY=..."` on the docker run command in agenthub-server-run.sh. */
    const pinnedByRunFlag = [...USER_DATA.matchAll(/-e "([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]);
    /** `ENV KEY=...` baked into the server image. */
    const bakedIntoImage = [...DOCKERFILE.matchAll(/^ENV ([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

    it('covers every owned key the run command pins with -e', () => {
      // docker gives -e precedence over --env-file, so .env can neither change
      // nor clear these.
      const uncovered = pinnedByRunFlag.filter(
        (k) => INVENTORY.includes(k) && !RUNTIME.includes(k),
      );
      expect(uncovered, 'add to local.hub_env_runtime_injected_keys').toEqual([]);
    });

    it('covers every owned key the image sets with ENV', () => {
      // Removing the key from .env falls back to the image value rather than
      // unsetting it.
      const uncovered = bakedIntoImage.filter((k) => INVENTORY.includes(k) && !RUNTIME.includes(k));
      expect(uncovered, 'add to local.hub_env_runtime_injected_keys').toEqual([]);
    });

    it('exempts nothing that is not actually injected somewhere', () => {
      // A stale exemption is a permanent blind spot in the retraction check.
      const unjustified = RUNTIME.filter(
        (k) => !pinnedByRunFlag.includes(k) && !bakedIntoImage.includes(k),
      );
      expect(unjustified, 'no -e flag or image ENV justifies exempting these').toEqual([]);
    });

    it('only exempts keys the sync actually owns', () => {
      expect(RUNTIME.filter((k) => !INVENTORY.includes(k))).toEqual([]);
    });

    it('is published as an output the release pipeline can consume', () => {
      expect(OUTPUTS).toContain('output "hub_env_runtime_injected_keys"');
    });
  });

  describe('the .env path the sync targets', () => {
    /**
     * The sync is only useful if it edits the exact file the running container
     * was created from. Both sides must therefore come from one local: the
     * user-data template receives it as `repo_dir` and writes "$REPO_DIR/.env",
     * then starts the container with `--env-file "$REPO_DIR/.env"`. Re-deriving
     * the path for the output would let the two drift, and a sync that edits a
     * file nothing reads reports success while changing nothing.
     */
    it('feeds the user-data template from the shared local', () => {
      expect(LOCALS).toMatch(/repo_dir\s*=\s*local\.agent_hub_repo_dir/);
    });

    it('derives the synced path from that same local', () => {
      expect(LOCALS).toMatch(
        /hub_env_file_path_on_host\s*=\s*"\$\{local\.agent_hub_repo_dir\}\/\.env"/,
      );
    });

    it('is the path the template actually writes and mounts', () => {
      expect(USER_DATA).toContain('REPO_DIR="${repo_dir}"');
      expect(USER_DATA).toMatch(/base64 -d >\s*"?\$REPO_DIR\/\.env"?/);
      expect(USER_DATA).toContain('--env-file "$REPO_DIR/.env"');
    });

    it('does not use docker_app_path, which belongs to the other bootstrap', () => {
      // var.docker_app_path drives bootstrap.sh.tftpl, selected only when
      // bootstrap_agent_hub = false. That branch never sets hub_env_emitted, so
      // the sync does not run there; pointing this at docker_app_path would aim
      // it at a file the running Hub was not created from.
      const block = /hub_env_file_path_on_host\s*=.*/.exec(LOCALS)?.[0] ?? '';
      expect(block).not.toContain('docker_app_path');
      expect(USER_DATA).not.toContain('docker_app_path');
    });
  });

  it('blocks a plan that renders a key the inventory does not own', () => {
    // Terraform-side half of the first assertion: the precondition is what stops
    // a real apply from writing a one-way key.
    const managed = /output "hub_env_managed" \{[\s\S]*?\n\}/.exec(OUTPUTS)?.[0] ?? '';
    expect(managed).toContain('precondition');
    expect(managed).toContain('local.hub_env_unlisted_keys');
  });
});
