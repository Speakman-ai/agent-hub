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
