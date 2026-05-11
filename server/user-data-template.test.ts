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

    const matches = tpl.match(
      /install -d -m 0755 -o 1000 -g 1000 "\$DATA_ROOT\/data" "\$DATA_ROOT\/uploads"/g,
    );
    expect(matches, 'expected 1000:1000 install -d in both bootstrap branches').not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  // ── ECR-pull bootstrap renders the standard docker run invocation ────────
  describe('ECR-pull bootstrap', () => {
    const rendered = renderTemplate(tpl, { ...RENDER_VARS_BASE });

    it('renders the standard docker run (no socket bind, no host-gateway)', () => {
      // `\$REPO_DIR` stays escaped in the unquoted runscript heredoc so bash
      // expands it at runtime, not at user-data render time.
      expect(rendered).toMatch(
        /exec docker run --rm --name agenthub-server[\s\S]*?--env-file "\\\$REPO_DIR\/\.env"/,
      );
      // After PR-Env Removal #6 the docker socket bind, --pid=host, and
      // --add-host host.docker.internal:host-gateway are gone.
      expect(rendered).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
      expect(rendered).not.toContain('--add-host host.docker.internal:host-gateway');
      expect(rendered).not.toMatch(/--pid=host\b/);
      expect(rendered).not.toMatch(/DOCKER_SOCK_GID=/);
    });

    it('still picks up image updates on systemd-managed restart', () => {
      expect(rendered).toMatch(/agenthub-server\.service/);
      expect(rendered).toMatch(/docker pull --quiet "\\\$IMAGE_URI"/);
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
