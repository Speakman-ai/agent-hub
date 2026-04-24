import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Regression guard for ops/terraform/agent-hub-user-data.tftpl.
 *
 * Context: the ECS-optimized Amazon Linux 2023 AMI ships `curl-minimal`
 * preinstalled, which provides /usr/bin/curl. If the bootstrap script asks
 * dnf to install the full `curl` package, dnf aborts with a package conflict,
 * `set -e` trips, and cloud-init fails before ever reaching `docker pull`.
 * The instance then comes up with no app container and the ALB times out.
 *
 * See: fix/al2023-curl-conflict.
 */
describe('agent-hub-user-data.tftpl', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tplPath = resolve(here, '..', 'ops', 'terraform', 'agent-hub-user-data.tftpl');
  const tpl = readFileSync(tplPath, 'utf8');

  it('does not install the stand-alone `curl` package (conflicts with curl-minimal on AL2023)', () => {
    // The bootstrap line historically read:
    //   $PKG_INSTALL ca-certificates git curl
    // which breaks AL2023. Curl is preinstalled on both AMI families; rely on it.
    const offending = /^\s*\$PKG_INSTALL\b[^\n#]*\bcurl\b(?!-)/m;
    expect(tpl, 'must not install curl as a separate package').not.toMatch(offending);
  });

  it('uses --allowerasing on the dnf path as a defensive measure', () => {
    expect(tpl).toMatch(/PKG_INSTALL="dnf install -y --allowerasing"/);
  });

  it('still installs the minimum package set needed by the rest of the script', () => {
    // `git` is used to clone the repo on the legacy bootstrap paths;
    // `ca-certificates` is required for TLS to docker registries / GitHub.
    expect(tpl).toMatch(/\$PKG_INSTALL\s+ca-certificates\s+git\b/);
  });

  // Context: the server container image uses node:22-slim and runs as the
  // built-in `node` user (uid/gid 1000). Bind mounts preserve *host*
  // ownership, so if the bootstrap creates $DATA_ROOT/{data,uploads} owned
  // by root the container cannot open the SQLite file and crash-loops with
  // SQLITE_CANTOPEN. We observed this on fresh test123 boots and had to
  // chown -R 1000:1000 via SSM to recover; regression guard below keeps the
  // fix in place.
  it('creates the docker bind-mount data dirs as uid/gid 1000 (container `node` user)', () => {
    const rootOwned = /install -d -m 0755 -o root -g root "\$DATA_ROOT\/data"/;
    expect(tpl, 'must not create $DATA_ROOT/data as root').not.toMatch(rootOwned);

    // Both bootstrap branches (ECR pull + legacy build) must create the dirs
    // with numeric 1000:1000 so the container user can write SQLite/uploads.
    const matches = tpl.match(
      /install -d -m 0755 -o 1000 -g 1000 "\$DATA_ROOT\/data" "\$DATA_ROOT\/uploads"/g,
    );
    expect(matches, 'expected 1000:1000 install -d in both bootstrap branches').not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});
