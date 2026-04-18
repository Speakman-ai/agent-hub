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
const WORKFLOW_PATH = join(__dirname, '..', '.github', 'workflows', 'deploy-dev.yml');

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

  it('disables errexit immediately before the explicit exit 0', () => {
    // The ordering matters: `set +e` must appear before `exit 0` inside
    // the health-check success branch so shell bookkeeping cannot
    // retroactively flip the exit code.
    const successBlock = executable.match(/echo\s+["']health ok on attempt[\s\S]{0,200}?exit 0/);
    expect(successBlock, 'health-success block not found').toBeTruthy();
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
