import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Guardrails for .github/workflows/deploy-dev.yml. The SSM deploy has
// suffered a recurring "ghost exit 1" where the inner script exits 0 but
// SSM reports exit status 1. Four prior rewrites were undone by subtle
// regressions; this test locks in the hypothesis-5 defensive shape so a
// future edit can't silently reintroduce known-bad patterns.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'deploy-dev.yml');
const PM2_RELOAD_SCRIPT = join(REPO_ROOT, 'scripts', 'pm2-reload-and-wait.sh');

describe('deploy-dev.yml', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8');
  // Strip yaml-level comment lines so our grep-style assertions don't match
  // the explanatory "do NOT do X" comments that document past hypotheses.
  const executable = yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('does not register an EXIT trap that could override exit 0', () => {
    // `trap ... EXIT` under `set -euo pipefail` can override an explicit
    // exit 0 if any command in the trap handler returns non-zero.
    expect(executable).not.toMatch(/trap\s+['"].*?['"]\s+EXIT/);
  });

  it('invokes bash with --noprofile --norc rather than -l', () => {
    // `bash -l` sources ~/.bash_profile on entry and ~/.bash_logout on
    // exit; either can flip the script's exit code under errexit.
    expect(executable).toContain('bash --noprofile --norc');
    expect(executable).not.toMatch(/bash\s+-l\s+["'$]/);
  });

  it('sources nvm explicitly since we dropped login-shell sourcing', () => {
    expect(executable).toContain('NVM_DIR');
    expect(executable).toContain('nvm.sh');
  });

  it('delegates post-build PM2 + health check to pm2-reload-and-wait.sh', () => {
    expect(executable).toMatch(/bash\s+scripts\/pm2-reload-and-wait\.sh/);
  });

  it('disables errexit immediately before the explicit exit 0 (in PM2 script)', () => {
    // Health success branch moved out of deploy-dev.yml into scripts/pm2-reload-and-wait.sh
    // so `pm2 reload` uses ecosystem.config.cjs. Same hypothesis-5 ordering guard.
    const sh = readFileSync(PM2_RELOAD_SCRIPT, 'utf8');
    const successBlock = sh.match(/echo\s+["']health ok on attempt[\s\S]{0,200}?exit 0/);
    expect(successBlock, 'health-success block not found in pm2-reload-and-wait.sh').toBeTruthy();
    expect(successBlock![0]).toContain('set +e');
  });

  it('uses exec setpriv with --reset-env so amazon-ssm-agent waits on bash directly', () => {
    expect(executable).toMatch(/exec\s+setpriv[^\n]*--reset-env/);
  });

  it('materialises the inner script to a tempfile rather than piping via heredoc', () => {
    // Nested heredoc → stdin had the ghost-exit symptom (run 24589322286);
    // keep the tempfile indirection.
    expect(executable).toMatch(/mktemp\s+\/tmp\/agent-hub-deploy/);
  });
});
