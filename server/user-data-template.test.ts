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
 * Not a full HCL implementation — just enough to assert the user-data
 * template renders correctly for the various bootstrap modes.
 */
function evalExpr(expr: string, vars: Record<string, unknown>): boolean {
  const jsExpr = expr.replace(/\b([a-zA-Z_]\w*)\b/g, (token) => {
    if (token === 'true' || token === 'false' || token === 'null') return token;
    return JSON.stringify(vars[token] ?? false);
  });
  return Boolean(Function(`return (${jsExpr});`)());
}

function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
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
  libprofiler_stub_c_b64: LIBPROFILER_STUB_B64,
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
    const offending = /^\s*\$PKG_INSTALL\b[^\n#]*\bcurl\b(?!-)/m;
    expect(tpl, 'must not install curl as a separate package').not.toMatch(offending);
  });

  it('uses --allowerasing on the dnf path as a defensive measure', () => {
    expect(tpl).toMatch(/PKG_INSTALL="dnf install -y --allowerasing"/);
  });

  it('still installs the minimum package set needed by the rest of the script', () => {
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

    // Tolerate bash line-continuation backslashes: the install line may
    // wrap across multiple lines when the arg list grows. We assert the
    // full uid/gid prefix is present and that each required dir appears
    // (data + uploads + projects + workspaces).
    const installBlocks = tpl.match(
      /install -d -m 0755 -o 1000 -g 1000(?:[ \t]*\\?\n?[ \t]*"\$DATA_ROOT\/[a-zA-Z0-9_-]+")+/g,
    );
    expect(
      installBlocks,
      'expected 1000:1000 install -d in both bootstrap branches',
    ).not.toBeNull();
    expect(installBlocks!.length).toBeGreaterThanOrEqual(2);
    for (const block of installBlocks!) {
      expect(block, 'each install block must create the data dir').toMatch(/"\$DATA_ROOT\/data"/);
      expect(block, 'each install block must create the uploads dir').toMatch(
        /"\$DATA_ROOT\/uploads"/,
      );
      expect(block, 'each install block must create the projects dir').toMatch(
        /"\$DATA_ROOT\/projects"/,
      );
      // Card 9b868252 — workspaces becomes a host-visible bind mount so
      // compose previews launched from per-session worktrees can see
      // source on the daemon side. Both bootstrap branches must create
      // the host dir with the container-runtime uid so the bind mount
      // is writable on first boot.
      expect(block, 'each install block must create the workspaces dir').toMatch(
        /"\$DATA_ROOT\/workspaces"/,
      );
    }
  });

  // Card 9b868252 — the workspaces bind mount + env var must reach the
  // container, otherwise `host-path-translation.ts` falls back to its
  // null branch for worktree-rooted preview paths and the daemon mounts
  // empty dirs again. Pinned in both bootstrap branches so a future
  // template refactor can't silently drop one.
  describe('workspaces bind-mount (card 9b868252)', () => {
    it('bind-mounts $DATA_ROOT/workspaces and exports AGENT_HUB_HOST_WORKSPACES_DIR (ECR-pull)', () => {
      const rendered = renderTemplate(tpl, { ...RENDER_VARS_BASE });
      expect(rendered).toMatch(
        /-v "\\\$DATA_ROOT\/workspaces:\/home\/node\/\.agent-hub\/workspaces"/,
      );
      expect(rendered).toMatch(/-e "AGENT_HUB_HOST_WORKSPACES_DIR=\\\$DATA_ROOT\/workspaces"/);
    });

    it('bind-mounts $DATA_ROOT/workspaces and exports AGENT_HUB_HOST_WORKSPACES_DIR (legacy docker-build)', () => {
      const rendered = renderTemplate(tpl, {
        ...RENDER_VARS_BASE,
        use_ecr_pull: false,
        use_docker_bootstrap: true,
        use_pm2_bootstrap: false,
      });
      expect(rendered).toMatch(
        /-v "\$DATA_ROOT\/workspaces:\/home\/node\/\.agent-hub\/workspaces"/,
      );
      expect(rendered).toMatch(/-e "AGENT_HUB_HOST_WORKSPACES_DIR=\$DATA_ROOT\/workspaces"/);
    });
  });

  // Host-path-aliased bind mounts for compose build contexts.
  //
  // `--project-directory` (emitted by PreviewComposeRuntime via
  // host-path-translation.ts) is the host-absolute path so the daemon
  // can resolve bind-mount sources. But compose-go runs INSIDE the Hub
  // container and stats `build.context` locally before tarring it to
  // the daemon — so the host path also has to be visible at the same
  // absolute path inside the container, otherwise any preview compose
  // file with `build:` fails with "unable to prepare context: path
  // \"…\" not found". The fix: alias each data dir at both the legacy
  // /home/node/... mount and the host-absolute $DATA_ROOT/... mount.
  // Same underlying inodes, two visible paths.
  describe('host-path-aliased bind mounts for compose build contexts', () => {
    it('aliases $DATA_ROOT/projects and $DATA_ROOT/workspaces at the host path (ECR-pull)', () => {
      const rendered = renderTemplate(tpl, { ...RENDER_VARS_BASE });
      // Escape pattern: in the heredoc-rendered runscript, $DATA_ROOT
      // is kept literal as `\$DATA_ROOT` so bash expands it at run time.
      expect(rendered).toMatch(/-v "\\\$DATA_ROOT\/projects:\\\$DATA_ROOT\/projects"/);
      expect(rendered).toMatch(/-v "\\\$DATA_ROOT\/workspaces:\\\$DATA_ROOT\/workspaces"/);
      // Original /home/node/... mounts must remain — agents still address
      // these paths and the alias is additive, not a replacement.
      expect(rendered).toMatch(/-v "\\\$DATA_ROOT\/projects:\/home\/node\/projects"/);
      expect(rendered).toMatch(
        /-v "\\\$DATA_ROOT\/workspaces:\/home\/node\/\.agent-hub\/workspaces"/,
      );
    });

    it('aliases $DATA_ROOT/projects and $DATA_ROOT/workspaces at the host path (legacy docker-build)', () => {
      const rendered = renderTemplate(tpl, {
        ...RENDER_VARS_BASE,
        use_ecr_pull: false,
        use_docker_bootstrap: true,
        use_pm2_bootstrap: false,
      });
      // In the inline (non-heredoc) docker run, $DATA_ROOT is expanded
      // by cloud-init's shell at user-data run time — so the rendered
      // template carries the literal `$DATA_ROOT` token (no backslash).
      expect(rendered).toMatch(/-v "\$DATA_ROOT\/projects:\$DATA_ROOT\/projects"/);
      expect(rendered).toMatch(/-v "\$DATA_ROOT\/workspaces:\$DATA_ROOT\/workspaces"/);
      expect(rendered).toMatch(/-v "\$DATA_ROOT\/projects:\/home\/node\/projects"/);
      expect(rendered).toMatch(
        /-v "\$DATA_ROOT\/workspaces:\/home\/node\/\.agent-hub\/workspaces"/,
      );
    });
  });

  // ── ECR-pull bootstrap renders the standard docker run invocation ────────
  describe('ECR-pull bootstrap', () => {
    const rendered = renderTemplate(tpl, { ...RENDER_VARS_BASE });

    it('renders docker run with socket bind for session compose previews', () => {
      // `\$REPO_DIR` stays escaped in the unquoted runscript heredoc so bash
      // expands it at runtime, not at user-data render time.
      expect(rendered).toMatch(
        /exec docker run --rm --name agenthub-server[\s\S]*?--env-file "\\\$REPO_DIR\/\.env"/,
      );
      expect(rendered).toContain('/var/run/docker.sock:/var/run/docker.sock');
      expect(rendered).not.toContain('--add-host host.docker.internal:host-gateway');
      expect(rendered).not.toMatch(/--pid=host\b/);
    });

    it('still picks up image updates on systemd-managed restart', () => {
      expect(rendered).toMatch(/agenthub-server\.service/);
      expect(rendered).toMatch(/docker pull --quiet "\\\$IMAGE_URI"/);
    });

    // Regression guard for kanban 89903017. The previous wrapper had a 3-attempt
    // pull retry loop that fell through to `exec docker run` on failure, so a
    // disk-full / ECR-blip / network-timeout silently launched the container
    // on the stale cached image. systemd then reported the unit healthy and CI
    // reported "Restart Success" — even though the deployed binary was old.
    // Observed 2026-05-11: dev sandbox stuck on v1.16.0 for 3 days. The new
    // wrapper sets PULL_OK and `exit 1`s if no attempt succeeded.
    it('makes docker pull failure FATAL (does not fall through to stale image)', () => {
      expect(rendered, 'wrapper must track pull success via PULL_OK').toMatch(/PULL_OK=0/);
      expect(rendered, 'wrapper must set PULL_OK=1 on the success branch').toMatch(/PULL_OK=1/);
      expect(rendered, 'wrapper must exit 1 when all pull attempts fail').toMatch(
        /if \[ "\\\$PULL_OK" != "1" \][\s\S]*?exit 1/,
      );
      // Specifically forbid the old fall-through shape where exec docker run
      // immediately follows the retry loop with no PULL_OK check.
      expect(rendered).not.toMatch(/sleep 10\s*\ndone\s*\n\s*docker rm -f agenthub-server/);
    });

    // Regression guard for kanban b2528863. Every CI push to :main writes a
    // new image to ECR Public and the host pulls it; the previous :main
    // becomes a dangling untagged image. Without GC the host disk filled
    // to 98% over ~30 deploys, at which point pulls started failing. The
    // systemd unit now runs `docker image prune` (only images older than
    // 24h, so the just-pulled :main is preserved) before each start.
    it('reaps dangling images >24h old before each restart via systemd ExecStartPre', () => {
      expect(rendered).toMatch(
        /ExecStartPre=-\/usr\/bin\/docker image prune -af --filter until=24h/,
      );
    });

    it('does not install host nginx, certbot, or the dns-route53 plugin (PR-env removal)', () => {
      expect(rendered).not.toMatch(/\$PKG_INSTALL\s+nginx\s+certbot/);
      expect(rendered).not.toContain('python3-certbot-dns-route53');
    });

    it('does not invoke certbot at all (PR-env removal)', () => {
      expect(rendered).not.toMatch(/\bcertbot certonly\b/);
      expect(rendered).not.toContain('--dns-route53');
      expect(rendered).not.toContain('/etc/letsencrypt/live/');
    });

    it('does not drop the per-PR base nginx vhost or sudoers.d allowlist (PR-env removal)', () => {
      expect(rendered).not.toContain('/etc/nginx/conf.d/agent-hub-pr-base.conf');
      expect(rendered).not.toContain('/etc/sudoers.d/agenthub-pr-env');
    });

    it('does not write the Tier-3 prEnv config.json (PR-env removal)', () => {
      expect(rendered).not.toContain('PR_ENV_CONFIG_DIR=');
      expect(rendered).not.toContain('PR_ENV_CONFIG_OWNER=');
    });
  });

  it('runs the libprofiler stub after PM2-path nginx install', () => {
    const r = renderTemplate(tpl, {
      ...RENDER_VARS_BASE,
      use_ecr_pull: false,
      use_docker_bootstrap: false,
      use_pm2_bootstrap: true,
    });
    expect(r).toMatch(
      /\$PKG_INSTALL nginx\nmaybe_fix_al2023_nginx_libprofiler\nsystemctl enable nginx/,
    );
  });
});
