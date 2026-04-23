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
});
