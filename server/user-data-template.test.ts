import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

/**
 * Minimal Terraform template-string renderer covering the subset used by
 * agent-hub-user-data.tftpl: `${name}` variable substitution and
 * `%{ if EXPR ~}` … [`%{ else ~}` …] `%{ endif ~}` boolean conditionals
 * (with optional whitespace-strip `~`). Compound expressions (`A || B`,
 * `A && B`, `!A`) evaluate against the supplied vars by mapping
 * identifiers → JS values; unknown identifiers fall through to `false`.
 *
 * This isn't a full HCL implementation — it's just enough to let us
 * exercise the pr_env_enabled branch end-to-end inside a Vitest fixture
 * without shelling out to `terraform console`.
 */
function evalExpr(expr: string, vars: Record<string, unknown>): boolean {
  const jsExpr = expr.replace(/\b([a-zA-Z_]\w*)\b/g, (token) => {
    if (token === 'true' || token === 'false' || token === 'null') return token;
    return JSON.stringify(vars[token] ?? false);
  });
  return Boolean(Function(`return (${jsExpr});`)());
}

function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  // Iteratively collapse the innermost %{ if … } … %{ endif } blocks first,
  // so nested conditionals (the bootstrap → use_ecr_pull → pr_env_enabled
  // chain inside the runscript heredoc) are evaluated outermost-last.
  const ifInner =
    /%\{(~?)\s*if\s+([^}]*?)\s*(~?)\}((?:(?!%\{~?\s*(?:if|endif)\b)[\s\S])*?)%\{(~?)\s*endif\s*(~?)\}/;
  let prev = '';
  while (prev !== tpl) {
    prev = tpl;
    tpl = tpl.replace(ifInner, (_m, _lstrip1, expr, rstrip1, body, lstrip2, _rstrip2) => {
      const val = evalExpr(expr as string, vars);
      const elseRe = /%\{(~?)\s*else\s*(~?)\}/;
      const elseMatch = elseRe.exec(body as string);
      let trueBranch = body as string;
      let falseBranch = '';
      if (elseMatch) {
        trueBranch = (body as string).slice(0, elseMatch.index);
        falseBranch = (body as string).slice(elseMatch.index + elseMatch[0].length);
      }
      let chosen = val ? trueBranch : falseBranch;
      if (rstrip1 === '~') chosen = chosen.replace(/^[ \t]*\n?/, '');
      if (lstrip2 === '~') chosen = chosen.replace(/\n?[ \t]*$/, '');
      return chosen;
    });
  }
  return tpl.replace(/\$\{(\w+)\}/g, (_m, name) => {
    if (name in vars) {
      const v = vars[name];
      return v === undefined || v === null ? '' : String(v);
    }
    return '';
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const libprofilerStubPath = resolve(
  here,
  '..',
  'ops',
  'terraform',
  'templates',
  'libprofiler-stub.c',
);
const LIBPROFILER_STUB_B64 = readFileSync(libprofilerStubPath).toString('base64');

const RENDER_VARS_BASE = {
  node_major: 22,
  app_user: 'agenthub',
  bootstrap: true,
  use_ecr_pull: true,
  use_docker_bootstrap: false,
  use_pm2_bootstrap: false,
  data_root_for_docker: '/var/lib/agent-hub',
  app_port: '3051',
  git_url: 'https://github.com/example/agent-hub.git',
  git_ref: 'main',
  repo_dir: '/home/agenthub/agent-hub',
  env_b64: '',
  docker_env_b64: '',
  image_uri: 'public.ecr.aws/example/agent-hub:main',
  ssm_deb_url: 'https://example.invalid/ssm.deb',
  // Stand-in fixture for the rendered base nginx fragment. The shape MUST
  // match what ops/terraform/templates/pr-env-base-nginx.conf.tftpl emits,
  // including the non-self-matching glob (`pr-[0-9]*.preview.conf`) — see
  // the "include glob and write directory agree" cross-file test below
  // which reads the real template and asserts the production glob pattern.
  pr_env_base_nginx_conf: 'include /etc/nginx/conf.d/pr-[0-9]*.preview.conf;',
  config_json_b64: '',
  pr_env_preview_host: '',
  cert_renewal_email: '',
  libprofiler_stub_c_b64: LIBPROFILER_STUB_B64,
};

/**
 * PrEnv Tier-3 config fixture used by the config_json_b64 tests below.
 * Mirrors the shape Terraform's locals-agent-hub.tf builds when
 * `enable_pr_env_host_nginx = true`. Kept in the test (rather than imported
 * from server/(removed pr-env subsystem)/pr-env-runtime.ts) because we want the test to
 * fail loudly if either side drifts away from this shape — schema drift is
 * exactly the bug class this fixture is meant to catch.
 */
const PR_ENV_FIXTURE_HOST = 'preview.agent-hub.example.com';
const PR_ENV_FIXTURE = {
  prEnv: {
    enabled: true,
    previewHost: PR_ENV_FIXTURE_HOST,
    previewBaseUrl: `https://${PR_ENV_FIXTURE_HOST}`,
    prodDbPath: '/data/agent-hub.db',
    prEnvDataDir: '/data/pr-env-databases',
    envFilesDir: '/data/pr-env-envfiles',
    nginx: {
      sitesAvailableDir: '/etc/nginx/conf.d',
      sitesEnabledDir: '/etc/nginx/conf.d',
      certPath: `/etc/letsencrypt/live/${PR_ENV_FIXTURE_HOST}/fullchain.pem`,
      keyPath: `/etc/letsencrypt/live/${PR_ENV_FIXTURE_HOST}/privkey.pem`,
      certHome: '/etc/letsencrypt',
      previewHost: PR_ENV_FIXTURE_HOST,
    },
    portRange: { min: 3100, max: 3999 },
    route53: { hostedZoneId: 'Z123EXAMPLE' },
  },
};

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

  it('embeds an AL2023 libprofiler workaround (nginx linked to broken gperftools build)', () => {
    expect(tpl).toContain('maybe_fix_al2023_nginx_libprofiler()');
    expect(tpl).toContain(
      "printf '%s' '${libprofiler_stub_c_b64}' | base64 -d >/tmp/libprofiler-stub.c",
    );
    const stub = readFileSync(libprofilerStubPath, 'utf8');
    for (const sym of [
      'ProfilerStart',
      'ProfilerStartWithOptions',
      'ProfilerStop',
      'ProfilerGetCurrentState',
      'ProfilerGetStackTrace',
    ]) {
      expect(stub, `stub must export ${sym}`).toContain(sym);
    }
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

  // ── PR-env mode (pr_env_enabled) ──────────────────────────────────────────
  //
  // The pr_env_enabled flag opts the host into per-PR preview environment
  // bootstrap: install host nginx + certbot, drop a base vhost that
  // includes per-PR fragments, write a narrow sudoers.d allowlist, and run
  // the Hub container with the host docker socket bind-mounted plus
  // host.docker.internal mapped to host-gateway. Default-disabled
  // scaffolding for the per-PR preview environments series.
  describe('pr_env_enabled = true', () => {
    const rendered = renderTemplate(tpl, { ...RENDER_VARS_BASE, pr_env_enabled: true });

    it('installs host nginx, certbot, and the python3-certbot-dns-route53 plugin', () => {
      // Package name is `python3-certbot-dns-route53` on both AL2023 (`dnf`)
      // and Ubuntu (`apt`); the shorter `python3-certbot-route53` does NOT
      // exist in either repo and would trip `set -e` at bootstrap. Guard the
      // exact name so a future copy-paste doesn't silently brick cloud-init.
      expect(rendered).toMatch(/\$PKG_INSTALL\s+nginx\s+certbot\s+python3-certbot-dns-route53\b/);
      // The bad name may appear in an explanatory comment ("don't use this");
      // what we forbid is it being passed to `$PKG_INSTALL`. Find every
      // PKG_INSTALL line and assert none of them contain it.
      const installLines = rendered.match(/^\s*\$PKG_INSTALL\b.*$/gm) ?? [];
      for (const line of installLines) {
        expect(line, 'must NOT install the (non-existent) shorter package').not.toMatch(
          /\bpython3-certbot-route53\b/,
        );
      }
    });

    it('runs the AL2023 libprofiler stub between nginx package install and enabling nginx', () => {
      expect(rendered).toMatch(
        /\$PKG_INSTALL nginx certbot python3-certbot-dns-route53\nmaybe_fix_al2023_nginx_libprofiler\nsystemctl enable --now nginx/,
      );
    });

    it('drops the base nginx vhost in /etc/nginx/conf.d/ (the dir AL2023 actually loads)', () => {
      // AL2023's stock /etc/nginx/nginx.conf includes /etc/nginx/conf.d/*.conf
      // but NOT /etc/nginx/sites-enabled/*. Anything we drop in sites-enabled
      // sits unused. Assert the production-correct path here.
      expect(rendered).toContain('/etc/nginx/conf.d/agent-hub-pr-base.conf');
      expect(rendered, 'sites-enabled is Debian-only; must not be the load path').not.toContain(
        '/etc/nginx/sites-enabled/agent-hub-pr-base.conf',
      );
      // And the include glob inside the base file MUST match the directory we
      // write per-PR fragments to — otherwise the Hub control plane can drop
      // fragments that nginx silently ignores. The glob must also be
      // non-self-matching: an earlier revision used `agent-hub-pr-*.conf`,
      // which matches the base file (`agent-hub-pr-base.conf`) itself and
      // recursively re-enters the same fragment, making `nginx -t` and any
      // reload segfault. The new shape (`pr-[0-9]*.preview.conf`) starts
      // with `pr-` (no `agent-hub-` prefix) so it cannot match the base
      // file, and matches the actual writer output (see
      // server/(removed pr-env subsystem)/nginx-template.ts → previewConfFilename).
      expect(rendered).toMatch(/include\s+\/etc\/nginx\/conf\.d\/pr-\[0-9\]\*\.preview\.conf/);
      // Belt-and-suspenders: assert the legacy self-matching glob does NOT
      // appear, so a future copy-paste regression trips this test loudly
      // rather than silently re-introducing the segfault.
      expect(
        rendered,
        'must not reintroduce the self-matching `agent-hub-pr-*.conf` glob (recursive include → segfault)',
      ).not.toMatch(/include\s+\/etc\/nginx\/conf\.d\/agent-hub-pr-\*\.conf/);
    });

    it('runs `nginx -t && systemctl reload nginx` after writing the base file', () => {
      // Without an explicit reload, the include only takes effect at the next
      // reboot or unrelated reload. Ensure the bootstrap surface is complete.
      expect(rendered).toMatch(/nginx -t && systemctl reload nginx/);
    });

    it('writes a narrow sudoers.d allowlist for the app user', () => {
      // App user (rendered from ${app_user}) gets exactly three NOPASSWD entries.
      expect(rendered).toContain('/etc/sudoers.d/agenthub-pr-env');
      expect(rendered).toMatch(/agenthub ALL=\(root\) NOPASSWD: \/usr\/sbin\/nginx -t\b/);
      expect(rendered).toMatch(/agenthub ALL=\(root\) NOPASSWD: \/bin\/systemctl reload nginx\b/);
      expect(rendered).toMatch(/agenthub ALL=\(root\) NOPASSWD: \/usr\/bin\/certbot\b/);
      // Belt and suspenders: validate-via-visudo and 0440 perms must be present.
      expect(rendered).toMatch(/visudo -cf \/etc\/sudoers\.d\/agenthub-pr-env/);
      expect(rendered).toMatch(/chmod 0440 \/etc\/sudoers\.d\/agenthub-pr-env/);
    });

    it('refuses to widen the sudoers allowlist to shell-escape-friendly binaries', () => {
      // Defense-in-depth: explicitly assert no shell, awk, perl, find, or
      // package-manager binary is granted NOPASSWD. If a future PR adds one,
      // this test fails loudly so the security review is forced.
      const sudoersBlock = rendered.match(
        /\/etc\/sudoers\.d\/agenthub-pr-env <<SUDOERS([\s\S]*?)SUDOERS/,
      );
      expect(sudoersBlock, 'sudoers heredoc must be present').not.toBeNull();
      const body = sudoersBlock![1]!;
      const forbidden = [
        'bash',
        'sh',
        'zsh',
        'awk',
        'perl',
        'python',
        'find',
        'dnf',
        'apt',
        'docker',
      ];
      for (const bad of forbidden) {
        expect(body, `sudoers must not allow ${bad}`).not.toMatch(
          new RegExp(`NOPASSWD:\\s+\\S*${bad}\\b`, 'i'),
        );
      }
    });

    it('binds the host docker socket and adds host.docker.internal to the runscript', () => {
      expect(rendered).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
      // Group-add resolves the host docker GID dynamically via stat -c %g.
      // Note: the runscript heredoc is unquoted, so the source contains
      // `\$(stat ...)` literally (the backslash defers `$` expansion until
      // bash later runs the script, not when cat writes it).
      expect(rendered).toMatch(/DOCKER_SOCK_GID=\\\$\(stat -c %g \/var\/run\/docker\.sock\)/);
      expect(rendered).toMatch(/--group-add\s+"\\\$DOCKER_SOCK_GID"/);
      // Host-gateway lets the container reach host nginx for healthchecks.
      expect(rendered).toContain('--add-host host.docker.internal:host-gateway');
    });

    it('aborts the runscript if the docker socket GID is missing or root (no silent --group-add 0)', () => {
      // Earlier revision used `|| echo 0` as a fallback, which silently
      // produced a container that bind-mounted the socket but couldn't use
      // it. The current bootstrap MUST refuse to start in that case so
      // systemd's Restart=always doesn't mask the real bug. Assert both:
      //   - no `|| echo 0` fallback in the stat invocation
      //   - explicit error path that exits non-zero
      expect(rendered, 'must not silently fall back to GID 0').not.toMatch(
        /stat -c %g \/var\/run\/docker\.sock[^\n)]*\|\|\s*echo\s*0/,
      );
      expect(rendered).toMatch(/Refusing to start with --group-add 0/);
      expect(rendered).toMatch(/exit 1/);
    });

    it('still picks up image updates on systemd-managed restart', () => {
      // The systemd unit + pull-on-start loop are unchanged by pr_env_enabled
      // — confirm both still render so the redeploy-on-reboot guarantee holds.
      expect(rendered).toMatch(/agenthub-server\.service/);
      // Same `\$` deferral as above — match the literal backslash-dollar.
      expect(rendered).toMatch(/docker pull --quiet "\\\$IMAGE_URI"/);
    });

    // ── Tier-3 prEnv config.json write (PR 3 of the PR-envs series) ─────
    //
    // When pr_env_enabled = true, terraform passes a base64-encoded JSON
    // blob (the prEnv block) into the template via `config_json_b64`. The
    // user-data must decode it and write it to the canonical Agent Hub
    // dataDir on first boot, with mode 0600 + ownership matching whichever
    // user the running server reads files as. The runtime resolver in
    // server/(removed pr-env subsystem)/pr-env-runtime.ts picks DB → file → env-var per
    // field, so populating only Tier-3 here is the intended "operator fills
    // in Tier-1+2 via Settings UI after first boot" path.
    describe('Tier-3 prEnv config.json write', () => {
      const fixtureJson = JSON.stringify(PR_ENV_FIXTURE);
      const fixtureB64 = Buffer.from(fixtureJson, 'utf8').toString('base64');

      it('writes the decoded JSON to $DATA_ROOT/data/config.json under Docker bootstrap', () => {
        const r = renderTemplate(tpl, {
          ...RENDER_VARS_BASE,
          pr_env_enabled: true,
          use_ecr_pull: true,
          use_docker_bootstrap: false,
          use_pm2_bootstrap: false,
          config_json_b64: fixtureB64,
        });

        // Path resolution: dataDir is bind-mounted at $DATA_ROOT/data → /data
        // in the container. The host file MUST be 1000:1000 (the container's
        // `node` user uid) so the bind-mount preserves a readable owner.
        expect(r).toContain('PR_ENV_CONFIG_DIR="$DATA_ROOT/data"');
        expect(r).toContain('PR_ENV_CONFIG_OWNER="1000:1000"');
        // Same `printf | base64 -d` pattern as the .env write.
        expect(r).toContain(`printf '%s' "${fixtureB64}"`);
        expect(r).toContain('base64 -d > "$PR_ENV_CONFIG_DIR/config.json"');
        // Strict 0600 — config.json may, in the future, contain Tier-2
        // secrets if the file-only path is ever revived. Belt-and-suspenders.
        expect(r).toMatch(/chmod 600 "\$PR_ENV_CONFIG_DIR\/config\.json"/);
        expect(r).toMatch(/install -d -m 0755 "\$PR_ENV_CONFIG_DIR"/);
      });

      it('writes to /home/${app_user}/.agent-hub/data under PM2 bootstrap', () => {
        const r = renderTemplate(tpl, {
          ...RENDER_VARS_BASE,
          pr_env_enabled: true,
          use_ecr_pull: false,
          use_docker_bootstrap: false,
          use_pm2_bootstrap: true,
          config_json_b64: fixtureB64,
        });
        // PM2 mode reads ~/.agent-hub/data/config.json directly off disk;
        // no bind-mount, so the owner is the operator user, not 1000:1000.
        expect(r).toContain('PR_ENV_CONFIG_DIR="/home/agenthub/.agent-hub/data"');
        expect(r).toContain('PR_ENV_CONFIG_OWNER="agenthub:agenthub"');
        // Docker-mode owner must NOT leak into the PM2 path.
        expect(r).not.toContain('PR_ENV_CONFIG_OWNER="1000:1000"');
      });

      it('decoded config_json_b64 contains every field readPrEnvConfig() needs at runtime', () => {
        // Schema-match assertion. Ground truth: the field set
        // server/(removed pr-env subsystem)/pr-env-runtime.ts checks in `missing` (the
        // Tier-3 paths it refuses to start without, ignoring Tier-1+2 fields
        // that arrive via the DB). If a future PR drops a key from the
        // Terraform locals block, this test fails at the `expect` line that
        // names the missing field — not at obscure cloud-init runtime.
        const decoded = JSON.parse(Buffer.from(fixtureB64, 'base64').toString('utf8'));
        expect(decoded).toHaveProperty('prEnv');
        const block = decoded.prEnv as Record<string, unknown>;
        expect(block.enabled).toBe(true);
        expect(typeof block.previewHost).toBe('string');
        expect(typeof block.previewBaseUrl).toBe('string');
        expect((block.previewBaseUrl as string).startsWith('https://')).toBe(true);
        expect(typeof block.prodDbPath).toBe('string');
        expect(typeof block.prEnvDataDir).toBe('string');
        expect(typeof block.envFilesDir).toBe('string');

        const nginx = block.nginx as Record<string, unknown>;
        expect(nginx).toBeTypeOf('object');
        for (const key of [
          'sitesAvailableDir',
          'sitesEnabledDir',
          'certPath',
          'keyPath',
          'certHome',
          'previewHost',
        ] as const) {
          expect(nginx[key], `nginx.${key} missing from Tier-3 fixture`).toBeTypeOf('string');
          expect((nginx[key] as string).length, `nginx.${key} empty`).toBeGreaterThan(0);
        }

        const portRange = block.portRange as Record<string, number>;
        expect(portRange).toBeTypeOf('object');
        expect(portRange.min).toBe(3100);
        expect(portRange.max).toBe(3999);

        const route53 = block.route53 as Record<string, unknown>;
        expect(route53).toBeTypeOf('object');
        expect(typeof route53.hostedZoneId).toBe('string');

        // Tier-1+2 fields MUST NOT be in the file block — they live in the
        // encrypted SQLite row. Asserting their absence keeps a future
        // refactor from accidentally re-writing creds to disk in plaintext.
        expect(block.repoFullName, 'Tier-1 repoFullName must NOT be in Tier-3').toBeUndefined();
        expect(block.github, 'Tier-2 github creds must NOT be in Tier-3').toBeUndefined();
        expect(
          block.certRenewalLive,
          'Tier-1 certRenewalLive must NOT be in Tier-3',
        ).toBeUndefined();
        // route53 has Tier-3 (hostedZoneId only) — accessKeyId/secretAccessKey are Tier-2.
        expect(route53.accessKeyId, 'Tier-2 r53 access key must NOT be in Tier-3').toBeUndefined();
        expect(route53.secretAccessKey, 'Tier-2 r53 secret must NOT be in Tier-3').toBeUndefined();
      });

      it('skips the write when config_json_b64 is empty (defensive guard)', () => {
        // Belt-and-suspenders for the locals.tf path that emits "" when the
        // feature is off but somehow still passes pr_env_enabled=true (e.g.
        // a partial revert). The `if [ -n … ]` guard means no config.json
        // ever appears with an empty body.
        const r = renderTemplate(tpl, {
          ...RENDER_VARS_BASE,
          pr_env_enabled: true,
          config_json_b64: '',
        });
        // The dir setup + guard still appear, but the printf line shouldn't
        // execute against an empty payload at runtime — we encode that via
        // the literal `if [ -n "" ]` shell guard surviving render.
        expect(r).toMatch(/if \[ -n "" \]; then/);
      });
    });

    // ── First-boot wildcard cert issuance (PR 4 of the PR-envs series) ──
    //
    // After PRs 1+2+3 land, this PR makes the EC2 issue a wildcard cert via
    // certbot --dns-route53 on first boot when one is not already present on
    // disk. The IAM role attached in PR 1 already has Route 53 perms, so
    // certbot's dns-route53 plugin picks them up via EC2 metadata creds — no
    // AWS_ACCESS_KEY_ID needed in the env. Renewal is owned by the Hub server
    // (server/(removed pr-env subsystem)/cert-renewal-heartbeat.ts), so no system cron
    // entry is needed in user-data.
    describe('first-boot wildcard cert issuance', () => {
      const previewHost = 'preview.agent-hub.example.com';
      const renewalEmail = 'ops@example.com';
      const r = renderTemplate(tpl, {
        ...RENDER_VARS_BASE,
        pr_env_enabled: true,
        pr_env_preview_host: previewHost,
        cert_renewal_email: renewalEmail,
      });

      it('invokes certbot certonly with --dns-route53 for the wildcard hostname', () => {
        expect(r).toMatch(/certbot certonly\b/);
        expect(r).toContain('--dns-route53');
        // Wildcard SAN gates per-PR previews like pr-123.preview.<host>.
        expect(r).toContain(`-d "*.${previewHost}"`);
        // Email registered with Let's Encrypt for expiration notices.
        expect(r).toContain(`-m "${renewalEmail}"`);
        // --non-interactive + --agree-tos are required for unattended issuance.
        expect(r).toContain('--non-interactive');
        expect(r).toContain('--agree-tos');
      });

      it('pins the cert lineage name so the on-disk path matches Tier-3 nginx.certPath', () => {
        // Without --cert-name, certbot derives the lineage from the first -d
        // argument (`*.<host>`), producing a non-deterministic on-disk path.
        // The Tier-3 config.json hard-codes /etc/letsencrypt/live/<host>/...
        // so the lineage name MUST equal `pr_env_preview_host` exactly.
        expect(r).toContain(`--cert-name "${previewHost}"`);
      });

      it('guards on existence of fullchain.pem so re-applies are idempotent', () => {
        // Lets Encrypt enforces 5 duplicate certs per week. Re-running
        // user-data (e.g. an unrelated TF change that triggers replacement)
        // must skip reissuance when the cert is already on disk.
        expect(r).toMatch(
          new RegExp(
            `if \\[ ! -f "/etc/letsencrypt/live/${previewHost.replace(/\./g, '\\.')}/fullchain\\.pem" \\]; then`,
          ),
        );
      });

      it('does not configure a system cron for renewal (the Hub heartbeat owns renewal)', () => {
        // Daily renewal is owned by server/(removed pr-env subsystem)/cert-renewal-heartbeat.ts.
        // A `certbot renew` system cron would race with the heartbeat and is
        // explicitly out of scope for this PR.
        expect(r, 'no `certbot renew` system cron in user-data').not.toMatch(/\bcertbot\s+renew\b/);
        // Belt and suspenders: no /etc/cron.d/certbot-renew or systemd timer
        // entries either.
        expect(r).not.toMatch(/\/etc\/cron\.d\/certbot/);
        expect(r).not.toMatch(/certbot\.timer/);
      });

      it('does not export AWS_ACCESS_KEY_ID — boto3 picks up creds via EC2 metadata', () => {
        // The IAM role attached to the instance (PR 1) carries Route 53
        // perms; the dns-route53 plugin reads them via boto3's IMDS provider.
        // Exporting AWS_ACCESS_KEY_ID in user-data would mean we're shipping
        // long-lived creds we shouldn't have.
        expect(r).not.toMatch(/AWS_ACCESS_KEY_ID/);
        expect(r).not.toMatch(/AWS_SECRET_ACCESS_KEY/);
      });
    });

    it('keeps the base-vhost write path and per-PR include glob in the same directory', () => {
      // Reviewer-requested cross-file consistency check. If the user-data
      // ever writes the base file into one directory while the base file's
      // include glob points at another, the Hub control plane will silently
      // drop fragments nginx never loads. Read both source files directly
      // (independent of the test renderer) and assert agreement.
      const baseTplPath = resolve(
        here,
        '..',
        'ops',
        'terraform',
        'templates',
        'pr-env-base-nginx.conf.tftpl',
      );
      const baseTpl = readFileSync(baseTplPath, 'utf8');

      const writeMatch = tpl.match(/cat >(\/etc\/nginx\/[^/]+)\/agent-hub-pr-base\.conf/);
      expect(writeMatch, 'user-data must `cat >` the base file under /etc/nginx').not.toBeNull();
      const writeDir = writeMatch![1]!;

      // Match the include glob that points at per-PR fragments. The
      // pattern MUST be `pr-[0-9]*.preview.conf` (matches the actual
      // writer output, does NOT match the base file itself); see
      // server/(removed pr-env subsystem)/nginx-template.ts → previewConfFilename.
      // Capturing the literal glob lets us assert non-self-match below.
      const includeMatch = baseTpl.match(
        /include\s+(\/etc\/nginx\/[^/]+)\/(pr-\[0-9\]\*\.preview\.conf)/,
      );
      expect(
        includeMatch,
        'base sub-template must declare a non-self-matching include glob (`pr-[0-9]*.preview.conf`)',
      ).not.toBeNull();
      const includeDir = includeMatch![1]!;
      const includeGlob = includeMatch![2]!;

      expect(includeDir, 'include glob dir must match the write dir').toBe(writeDir);
      // Belt-and-suspenders: surface the actual directory in the assertion
      // message if a future regression flips one of them to sites-enabled.
      expect(writeDir).toBe('/etc/nginx/conf.d');

      // Independent self-match guard: the captured glob, if expanded by a
      // shell-style matcher, MUST NOT match `agent-hub-pr-base.conf`
      // (recursive include → nginx segfault). We assert by checking the
      // glob's literal prefix is `pr-` and not `agent-hub-pr-`.
      expect(
        includeGlob.startsWith('pr-'),
        'include glob must start with `pr-` (not `agent-hub-pr-`) so it cannot match the base file',
      ).toBe(true);
      expect(
        includeGlob.startsWith('agent-hub-pr-'),
        'must not reintroduce the self-matching `agent-hub-pr-*.conf` glob',
      ).toBe(false);
    });
  });

  describe('pr_env_enabled = false (regression guard)', () => {
    const rendered = renderTemplate(tpl, { ...RENDER_VARS_BASE, pr_env_enabled: false });

    it('does not install nginx, certbot, or the dns-route53 plugin', () => {
      expect(rendered).not.toMatch(/\$PKG_INSTALL\s+nginx\s+certbot/);
      expect(rendered).not.toContain('python3-certbot-dns-route53');
    });

    it('does not drop the base nginx vhost or sudoers.d allowlist', () => {
      expect(rendered).not.toContain('/etc/nginx/conf.d/agent-hub-pr-base.conf');
      expect(rendered).not.toContain('/etc/sudoers.d/agenthub-pr-env');
      // Also assert the explicit reload doesn't run when the flag is off —
      // otherwise we'd reload nginx on every boot of an instance that never
      // had any agent-hub-pr-*.conf written to disk.
      expect(rendered).not.toMatch(/nginx -t && systemctl reload nginx/);
    });

    it('does not bind the host docker socket or add host-gateway', () => {
      expect(rendered).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
      expect(rendered).not.toContain('--add-host host.docker.internal:host-gateway');
      expect(rendered).not.toMatch(/DOCKER_SOCK_GID=/);
    });

    it('does not invoke certbot at all (regression guard for PR 4)', () => {
      // The first-boot wildcard cert issuance (PR 4) must be entirely gated
      // on pr_env_enabled. With the flag off, no certbot invocation, no
      // /etc/letsencrypt path reference, no Let's Encrypt email leakage.
      expect(rendered, 'certbot must not run when pr_env_enabled = false').not.toMatch(
        /\bcertbot certonly\b/,
      );
      expect(rendered).not.toContain('--dns-route53');
      expect(rendered).not.toContain('/etc/letsencrypt/live/');
    });

    it('does not write the Tier-3 prEnv config.json (regression guard for PR 3)', () => {
      // Symmetric guard for the config.json write added in PR 3 of this
      // series. With pr_env_enabled = false the entire block must be
      // gone — no PR_ENV_CONFIG_DIR shell var, no chmod against config.json.
      expect(rendered).not.toContain('PR_ENV_CONFIG_DIR=');
      expect(rendered).not.toContain('PR_ENV_CONFIG_OWNER=');
      expect(rendered).not.toMatch(/config\.json/);
    });

    it('still installs the minimum package set and renders the unchanged runscript', () => {
      // Sanity check: the rest of the template still renders normally when
      // the new flag is off — the install line and `docker run` invocation
      // for the ECR-pull branch are unchanged from pre-PR-2 behaviour.
      expect(rendered).toMatch(/\$PKG_INSTALL\s+ca-certificates\s+git\b/);
      // `\$REPO_DIR` is intentionally left as `\$` in the unquoted runscript
      // heredoc so bash expands it at runtime, not at user-data render time.
      expect(rendered).toMatch(
        /exec docker run --rm --name agenthub-server[\s\S]*?--env-file "\\\$REPO_DIR\/\.env"/,
      );
    });
  });

  it('runs the libprofiler stub after PM2-path nginx install', () => {
    const r = renderTemplate(tpl, {
      ...RENDER_VARS_BASE,
      pr_env_enabled: false,
      use_ecr_pull: false,
      use_docker_bootstrap: false,
      use_pm2_bootstrap: true,
    });
    expect(r).toMatch(
      /\$PKG_INSTALL nginx\nmaybe_fix_al2023_nginx_libprofiler\nsystemctl enable nginx/,
    );
  });
});
