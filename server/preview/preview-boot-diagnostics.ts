/**
 * Post-mortem classification of a failed preview boot from its log tail.
 *
 * A dev-server `buildCommand` or `startCommand` can fail for host-level reasons
 * the exit code alone can't explain — most importantly Docker exhaustion that
 * surfaces deep inside a compose log as a cryptic daemon error. When a project's
 * build shells out to `docker compose`, the operative failure (e.g. "could not
 * find an available, non-overlapping IPv4 address pool") lands dozens of lines
 * above the tail's end, and the Hub otherwise reports only "buildCommand exited
 * with code 1". The user sees an opaque failure for a condition that has a
 * one-line, self-serve fix.
 *
 * This module scans the retained boot-log tail for known, high-precision
 * infrastructure signatures and returns a short operator hint the runtime
 * appends to the surfaced failure message. Signatures must be specific enough
 * that a match is never a false positive — an unrecognised failure returns
 * null and the base message is shown unchanged.
 */

export interface PreviewBootDiagnostic {
  /** Stable id for tests and telemetry. */
  code: string;
  /** One-line, human-actionable hint appended to the failure message. */
  hint: string;
}

interface BootFailureSignature {
  code: string;
  /** Primary pattern that must match a single log line. */
  test: RegExp;
  /**
   * Optional extra patterns that must ALSO all match the SAME line as `test`.
   * Used to scope an otherwise-ambiguous message (e.g. "no space left on
   * device") to a specific subsystem before prescribing a subsystem fix.
   */
  requireAll?: readonly RegExp[];
  hint: string;
}

/** True when every pattern in the signature matches the single `line`. */
function signatureMatchesLine(sig: BootFailureSignature, line: string): boolean {
  if (!sig.test.test(line)) return false;
  return (sig.requireAll ?? []).every((re) => re.test(line));
}

// Hints are shown to operators who tend to copy-paste any command verbatim, so
// they must be SAFE to run blind: name the diagnosis and point at a read-only
// inspection command (`docker network ls`, `docker system df`). Never embed a
// destructive one-liner — no `prune`, no `-f`, no `--volumes`, nothing that can
// delete images, build cache, or (worst) volumes holding persistent app data.
// Selecting and removing disposable resources is left to the operator after
// they have inspected what exists.
const SIGNATURES: readonly BootFailureSignature[] = [
  {
    // Docker daemon, on `compose up` / `docker run -p` when a service publishes
    // a FIXED host port another process already holds:
    //   "Error response from daemon: driver failed programming external
    //    connectivity on endpoint session-<id>-frontend-1 (<hash>): Bind for
    //    0.0.0.0:4100 failed: port is already allocated"
    // The confusing part for users is that it reads like a Hub session clash
    // ("this is the only active session…"), but the collision is on the HOST:
    // the compose file hardcodes the host side of a `ports:` mapping, so a
    // leftover container from a previous boot still owns that number.
    code: 'docker_host_port_conflict',
    test: /port is already allocated/i,
    hint:
      'A preview service publishes a fixed host port that something on the host already holds ' +
      '(usually a leftover container from a previous boot, not another Hub session). ' +
      'Find what owns it with `docker ps` and stop that container, then retry. ' +
      'To stop it recurring, bind the host side of the compose `ports:` mapping to `${AGENT_HUB_HOST_PORT}` ' +
      'instead of a hardcoded number so each session gets a unique host port.',
  },
  {
    code: 'docker_network_pool_exhausted',
    // Docker daemon, on `compose up` / `network create` when every subnet in
    // the daemon's default-address-pools is already assigned to a network:
    //   "failed to create network <name>: Error response from daemon: could
    //    not find an available, non-overlapping IPv4 address pool among the
    //    defaults to assign to the network"
    test: /could not find an available,?\s+non-overlapping ipv4 address pool/i,
    hint:
      'Docker has no free network address pool left, so compose could not create the preview network (the image built fine). ' +
      'List networks with `docker network ls` and remove ones no container is using, or widen the daemon `default-address-pools`, then retry.',
  },
  {
    // Docker-specific out-of-disk: the message names a path under the docker
    // graph root (`/var/lib/docker/...`), so the failure is the image build/pull
    // filling the daemon's storage.
    // Ordered BEFORE the generic disk signature so the Docker-scoped hint wins.
    code: 'docker_no_space_left',
    test: /no space left on device/i,
    requireAll: [/no space left on device/i, /\/var\/lib\/docker\b/i],
    hint:
      "Docker's storage ran out of disk while building the preview image. " +
      'Review usage with `docker system df` and reclaim space by removing images/build cache you have confirmed are disposable, then retry.',
  },
  {
    // Generic out-of-disk: any build/start command can emit this when the
    // worktree or host filesystem is full. Do NOT prescribe Docker cleanup —
    // the cause may be unrelated to Docker.
    code: 'no_space_left',
    test: /no space left on device/i,
    hint:
      'The build/start command failed because a filesystem is full (no space left on device). ' +
      'Free disk space on the host (and the session worktree), then retry.',
  },
];

/**
 * Return the first matching diagnostic for a preview boot log tail, or null.
 *
 * Scans newest-line-first: the operative daemon error sits near the end of the
 * log, after the (often cached-and-successful) build steps.
 */
export function diagnosePreviewBootFailure(tail: readonly string[]): PreviewBootDiagnostic | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line) continue;
    for (const sig of SIGNATURES) {
      if (signatureMatchesLine(sig, line)) return { code: sig.code, hint: sig.hint };
    }
  }
  return null;
}

/**
 * Append a diagnostic hint to a base failure message when the tail matches a
 * known infrastructure signature; otherwise return the base message unchanged.
 */
export function withBootDiagnostic(baseMessage: string, tail: readonly string[]): string {
  const diag = diagnosePreviewBootFailure(tail);
  return diag ? `${baseMessage} — ${diag.hint}` : baseMessage;
}

/**
 * Every operator-facing hint string. Exposed so a guard test can assert the
 * safety invariant (no destructive copy-paste command in any hint) across all
 * current and future signatures.
 */
export function listDiagnosticHints(): string[] {
  return SIGNATURES.map((sig) => sig.hint);
}
