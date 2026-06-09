/**
 * runner-image-versions.ts — recorded target software versions for the Finalize
 * CI runner image (server/finalize/runner/Dockerfile).
 *
 * Why this exists: the Finalize gate stands in for a GitHub-hosted runner, so the
 * toolchain it ships (Node, Docker Engine, Compose, Buildx) should track the
 * versions GitHub's `actions/runner-images` ubuntu-24.04 image actually ships.
 * Drift here is a parity risk — e.g. a Compose or Docker behaviour change that
 * passes on one version and fails on another would make Finalize green where
 * GitHub is red (or vice-versa).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the *targeted* versions. The
 * Dockerfile mirrors them as ARG defaults; `runner-image-versions.test.ts`
 * fails the build if the two ever diverge, so they can't silently drift apart.
 *
 * ── Pinning philosophy (read before bumping) ─────────────────────────────────
 * We deliberately do NOT hard-pin every apt package to an exact version with no
 * escape hatch. NodeSource / download.docker.com age old patch versions out of
 * their repos, so a frozen `apt-get install foo=1.2.3` Dockerfile eventually
 * fails to build for everyone the day the pin disappears upstream. Instead the
 * Dockerfile applies these as a SOFT pin: it tries the exact version, and if it
 * has aged out it falls back to the newest patch WITHIN THE SAME MAJOR line (e.g.
 * Docker 28.x stays on 28.x, never 29.x) and prints a loud warning. It refuses to
 * cross majors: if even the recorded major is gone from the repo, the build fails
 * asking you to bump, because silently installing a different major would defeat
 * the GitHub-parity guard this module exists to provide. Set
 * RUNNER_ENFORCE_VERSION_PINS=1 to make any drift (even patch-level) fatal for
 * reproducible prod builds. That keeps the build robust while still recording,
 * and best-effort reproducing, the GitHub-parity target.
 *
 * ── Bump cadence ─────────────────────────────────────────────────────────────
 * When GitHub's `actions/runner-images` updates the ubuntu-24.04 image (watch
 * the Ubuntu2404-Readme.md manifest), update BOTH this file and the matching ARG
 * defaults in server/finalize/runner/Dockerfile to the new manifest values, then
 * rebuild (server/finalize/runner/build.sh) and bump MANIFEST_SNAPSHOT below.
 * The drift test will fail until the Dockerfile ARGs match these constants.
 *
 * Source manifest:
 *   https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
 */

export interface RunnerImageVersions {
  /** Default system Node.js (NodeSource `setup_<major>.x` + soft pin). */
  node: string;
  /** Docker Engine / CLI (`docker-ce` / `docker-ce-cli`). */
  docker: string;
  /** Docker Compose v2 plugin (`docker-compose-plugin`). */
  compose: string;
  /** Docker Buildx plugin (`docker-buildx-plugin`). */
  buildx: string;
}

/**
 * Targeted versions, mirrored from the GitHub ubuntu-24.04 image manifest.
 * Keep in lockstep with the ARG defaults in server/finalize/runner/Dockerfile.
 */
export const RUNNER_IMAGE_VERSIONS: RunnerImageVersions = {
  node: '22.22.3',
  docker: '28.0.4',
  compose: '2.38.2',
  buildx: '0.34.1',
};

/**
 * When the targeted versions above were last reconciled against the GitHub
 * manifest. Bump this (YYYY-MM-DD) whenever you refresh the versions so reviewers
 * can see how stale the pin is at a glance.
 */
export const MANIFEST_SNAPSHOT = {
  image: 'ubuntu-24.04',
  reconciledOn: '2026-06-09',
  source: 'https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md',
} as const;

/** The Node major line the NodeSource setup script must select (e.g. `22`). */
export function runnerNodeMajor(versions: RunnerImageVersions = RUNNER_IMAGE_VERSIONS): string {
  return versions.node.split('.')[0];
}
