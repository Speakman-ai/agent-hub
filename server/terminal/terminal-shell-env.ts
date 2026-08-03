/**
 * Env overlay for the session terminal shell.
 *
 * The PTY inherits the Hub server process env, so the Terminal tab used to see
 * none of the project's AWS profiles: `aws --profile <name>` failed with "The
 * config profile could not be found" while the same profile worked for the
 * agent, whose spawns go through `mergeProjectAwsSpawnEnv`. This overlay puts
 * the terminal on the same project-scoped config / credentials files, and drops
 * ambient AWS credential vars inherited from the server process so they cannot
 * shadow them.
 *
 * HOME is deliberately untouched. The AWS CLI keys its SSO token cache off
 * `$HOME/.aws/sso/cache` and offers no env var to relocate it
 * (https://github.com/aws/aws-cli/issues/8945), so pinning HOME to a Hub creds
 * tree to share Hub SSO tokens would also move the shell's dotfiles, history,
 * git and gh config. Consequences:
 *   - static profiles work immediately (the credentials file carries the keys);
 *   - SSO profiles resolve by name, and `aws sso login --profile <name>` run
 *     inside the terminal caches its token under the shell's own HOME.
 *
 * A value of `undefined` means "unset this inherited variable" — both SessionEnv
 * adapters drop undefined entries when materializing the PTY env.
 */

import type { Project } from '../types.js';
import {
  AWS_AMBIENT_CREDENTIAL_KEYS,
  mergeProjectAwsSpawnEnv,
  projectHasAwsSsoProfiles,
} from '../project-aws-spawn.js';

/** Overlay merged over the SessionEnv base env when opening the terminal PTY. */
export type TerminalShellEnvOverlay = Record<string, string | undefined>;

export interface BuildTerminalShellEnvOpts {
  /**
   * Isolation boundary the PTY runs in. Only the `host` adapter shares a
   * filesystem with the Hub, so only there can the shell read the generated
   * config files; a sysbox shell would get paths that do not exist inside its
   * container.
   */
  envKind: 'host' | 'sysbox';
}

/**
 * Build the terminal shell env overlay for a project. Returns an empty overlay
 * (terminal env unchanged) when the project configures no AWS profiles, when
 * the PTY runs outside the host filesystem, or when rendering the project files
 * fails — a terminal must always open.
 */
export function buildTerminalShellEnv(
  project: Project | null | undefined,
  opts: BuildTerminalShellEnvOpts,
): TerminalShellEnvOverlay {
  if (!project || opts.envKind !== 'host') return {};
  if (!projectHasAwsSsoProfiles(project)) return {};

  const overlay: TerminalShellEnvOverlay = {};
  const applied = mergeProjectAwsSpawnEnv(overlay as NodeJS.ProcessEnv, project);
  if (!applied) return {};

  // `mergeProjectAwsSpawnEnv` scrubs by deleting keys, which on an overlay just
  // lets the inherited value through. Re-state them as explicit unsets.
  for (const key of AWS_AMBIENT_CREDENTIAL_KEYS) overlay[key] = undefined;
  return overlay;
}
