import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(here, 'runner', 'entrypoint.sh');

function readEntrypoint(): string {
  return readFileSync(ENTRYPOINT, 'utf8');
}

function dockerdLogPath(script: string): string | undefined {
  return /^DOCKERD_LOG=(\S+)\s*$/m.exec(script)?.[1];
}

describe('runner entrypoint — dockerd log path', () => {
  // Regression guard for a silent, total DinD failure. The entrypoint runs as
  // the image's `runner` user but starts dockerd under sudo, so the log file is
  // created by one uid and appended to by another. When the log lived in /tmp —
  // world-writable and sticky — a host with fs.protected_regular=1 made the
  // kernel refuse root's O_CREAT append onto the runner-owned file, and
  // may_create_in_sticky() has no CAP_DAC_OVERRIDE bypass. dockerd never
  // started; the only symptom was a readiness timeout minutes later.
  //
  // The Finalize fleet AMI sets the sysctl to 0, so Finalize never saw this.
  // Hub hosts set it to 1, which is where session environments run their DinD.
  it('keeps the log out of world-writable sticky directories', () => {
    const path = dockerdLogPath(readEntrypoint());
    expect(path).toBeDefined();
    expect(path).not.toMatch(/^\/(tmp|var\/tmp|dev\/shm)\//);
  });

  it('creates the log as root so the sudo-ed append owns the file', () => {
    // A plain `: > "${DOCKERD_LOG}"` would create it as `runner`, reintroducing
    // the ownership split even on a directory the sysctl does not police.
    expect(readEntrypoint()).toContain('sudo sh -c ": > ${DOCKERD_LOG}');
  });
});

describe('runner identity matches the workspace owner', () => {
  // Regression guard for a session env that could not start at all, verified
  // against the real image: with a workspace owner of 1000 and `runner` on 1001
  // the container exited 8 on `usermod: user runner is currently used by
  // process 1` — process 1 being this entrypoint. Rewriting /etc/passwd instead
  // got one step further and then died on `sudo: you do not exist in the passwd
  // database`, because the rewrite orphans the uid the shell is still running
  // as. An account cannot be renumbered from inside its own container, so the
  // ids have to line up at build time and the entrypoint only verifies.
  const HUB_WORKSPACE_UID = '1000';

  it('pins the runner account to the uid a Hub workspace carries', () => {
    const dockerfile = readFileSync(join(here, 'runner', 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(new RegExp(`useradd[^\\n]*-u ${HUB_WORKSPACE_UID}\\b`));
    expect(dockerfile).toMatch(new RegExp(`groupadd -g ${HUB_WORKSPACE_UID} runner`));
    // ubuntu:24.04 ships an `ubuntu` account on 1000, and useradd would
    // otherwise fall through to 1001. It has to be moved off first.
    expect(dockerfile).toMatch(/usermod -u \d+ ubuntu/);
    expect(dockerfile).toMatch(/groupmod -g \d+ ubuntu/);
  });

  it('does not attempt to renumber the running runner account', () => {
    const script = readEntrypoint();
    const forbidden = [
      /usermod\s+-u\s+"\$want_uid"/,
      /groupmod\s+-g\s+"\$want_gid"/,
      /sed -i -E .*\/etc\/passwd/,
      /sed -i -E .*\/etc\/group/,
    ];
    for (const pattern of forbidden) {
      expect(script).not.toMatch(pattern);
    }
  });

  it('fails loudly on a mismatch instead of returning a read-only workspace', () => {
    // Continuing would hand back a container that rejects every write to the
    // worktree, which surfaces later as unrelated-looking build and git errors.
    const script = readEntrypoint();
    expect(script).toContain('[finalize-runner] FATAL: workspace is owned by');
    expect(script).toMatch(/Rebuild this image with/);
  });

  it('skips the check when no workspace owner is declared', () => {
    // The Finalize path sets no AGENT_HUB_WORKSPACE_UID and must be unaffected.
    const script = readEntrypoint();
    expect(script).toMatch(/want_uid="\$\{AGENT_HUB_WORKSPACE_UID:-\}"/);
    expect(script).toMatch(/if \[ -z "\$want_uid" \]; then\n\s+return 0/);
  });
});

describe('runner entrypoint — Finalize workspace chown', () => {
  // Prod after a host replacement: every install step died with EACCES mkdir
  // /github/workspace/node_modules (exit 243). The fleet agent already chowns
  // to hardcoded uid 1000; that misses job-image uid skew, Hub-local clones,
  // and userns remap. The job entrypoint chowns to the account it actually
  // execs as and probes that a create succeeds before any CI step runs.
  it('chowns /github/workspace to the running runner account on the Finalize path', () => {
    const script = readEntrypoint();
    expect(script).toContain('prepare_job_workspace');
    expect(script).toMatch(/sudo chown -R "\$\{RUNNER_USER\}:\$\{RUNNER_USER\}" "\$ws"/);
    expect(script).toContain('.finalize-workspace-writable');
  });

  it('runs prepare_job_workspace in daemon mode before dockerd', () => {
    const script = readEntrypoint();
    const daemon = script.slice(script.indexOf('daemon)'));
    const chownAt = daemon.indexOf('prepare_job_workspace');
    const dockerdAt = daemon.indexOf('start_dockerd');
    expect(chownAt).toBeGreaterThan(-1);
    expect(dockerdAt).toBeGreaterThan(chownAt);
  });

  it('does not chown the workspace when a session env declared AGENT_HUB_WORKSPACE_UID', () => {
    const script = readEntrypoint();
    expect(script).toMatch(
      /prepare_job_workspace\(\) \{\n\s+\[ -n "\$\{AGENT_HUB_WORKSPACE_UID:-\}" \] && return 0/,
    );
  });

  it('refuses to chown a path other than /github/workspace', () => {
    const script = readEntrypoint();
    expect(script).toContain('skipping workspace chown for unexpected path');
    expect(script).toContain('[ "$ws" != "/github/workspace" ]');
  });
});
