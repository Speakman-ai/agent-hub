import { describe, it, expect } from 'vitest';
import {
  diagnosePreviewBootFailure,
  withBootDiagnostic,
  listDiagnosticHints,
} from './preview-boot-diagnostics.js';

describe('hint safety invariant', () => {
  // Root cause of two review rounds: hints embedded destructive commands that
  // operators copy-paste and run blind. No hint — for any current or future
  // signature — may contain a data-destroying one-liner.
  const FORBIDDEN = [
    /\bprune\b/i, // docker network/system/image/volume prune
    /--volumes\b/i, // deletes volumes with persistent app data
    /\b-f\b/, // force flags skip the confirmation prompt
    /--force\b/i,
    /\brm\s+-rf\b/i,
  ];

  it.each(listDiagnosticHints())('hint is safe to run blind: %s', (hint) => {
    for (const pattern of FORBIDDEN) {
      expect(hint, `hint must not invite a destructive command (${pattern})`).not.toMatch(pattern);
    }
  });
});

describe('diagnosePreviewBootFailure', () => {
  it('flags Docker address-pool exhaustion from a real compose-up failure tail', () => {
    // Trimmed from the reported failure: the image built successfully (all 22
    // steps cached) and the operative daemon error is the LAST few lines.
    const tail = [
      'Step 22/22 : LABEL com.docker.compose.image.builder=classic',
      ' ---> Using cache',
      'Successfully tagged surveytracker-preview-backend:latest',
      'Image surveytracker-preview-backend:latest Built',
      'network:default failed to create network session-d2877137_default: Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network',
      'failed to create network session-d2877137_default: Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network',
    ];
    const diag = diagnosePreviewBootFailure(tail);
    expect(diag?.code).toBe('docker_network_pool_exhausted');
    expect(diag?.hint).toMatch(/docker network ls/i);
  });

  it('flags out-of-disk failures', () => {
    const tail = [
      'Step 9/22 : RUN pip install --no-cache-dir -r requirements-docker.txt',
      'write /var/lib/docker/tmp/layer: no space left on device',
    ];
    const diag = diagnosePreviewBootFailure(tail);
    expect(diag?.code).toBe('docker_no_space_left');
    expect(diag?.hint).toMatch(/docker system df/i);
  });

  it('gives a generic (non-Docker) disk hint when the path is not the docker graph root', () => {
    // The worktree / host filesystem filled up — the message is not about the
    // docker graph root, so it must NOT prescribe destructive docker cleanup.
    const tail = ['npm run build', 'Error: ENOSPC: no space left on device, write'];
    const diag = diagnosePreviewBootFailure(tail);
    expect(diag?.code).toBe('no_space_left');
    expect(diag?.hint).not.toMatch(/docker/i);
    expect(diag?.hint).toMatch(/free disk space/i);
  });

  it('returns null for an unrecognised / ordinary build failure', () => {
    const tail = [
      'Step 9/22 : RUN pip install --no-cache-dir -r requirements-docker.txt',
      'ERROR: Could not find a version that satisfies the requirement foo==9.9.9',
    ];
    expect(diagnosePreviewBootFailure(tail)).toBeNull();
  });

  it('returns null on an empty tail', () => {
    expect(diagnosePreviewBootFailure([])).toBeNull();
  });

  it('scans newest-first and tolerates blank lines', () => {
    const tail = [
      'could not find an available, non-overlapping IPv4 address pool',
      '',
      'some later unrelated line',
    ];
    expect(diagnosePreviewBootFailure(tail)?.code).toBe('docker_network_pool_exhausted');
  });
});

describe('withBootDiagnostic', () => {
  it('appends the hint when a signature matches', () => {
    const msg = withBootDiagnostic('build failed: buildCommand exited with code 1', [
      'failed to create network foo_default: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network',
    ]);
    expect(msg).toMatch(/^build failed: buildCommand exited with code 1 — /);
    expect(msg).toMatch(/address pool/i);
  });

  it('returns the base message unchanged when nothing matches', () => {
    const base = 'build failed: buildCommand exited with code 1';
    expect(withBootDiagnostic(base, ['just a normal log line'])).toBe(base);
  });
});
