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
 * HOME follows the terminal's owner. The AWS CLI keys its SSO token cache off
 * `$HOME/.aws/sso/cache` and offers no env var to relocate it
 * (https://github.com/aws/aws-cli/issues/8945), so the HOME decides whose SSO
 * login the shell uses:
 *   - A session with an owning user runs its host terminal under that user's
 *     per-user HOME, the same HOME their agent spawns and the AWS settings
 *     login use. One user's `aws sso login` therefore never authenticates
 *     another user's terminal. Git and gh keep reading the server's global
 *     config (`GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`) so moving HOME does not
 *     change how the shell pushes or talks to GitHub.
 *   - An ownerless (operator) terminal keeps the server HOME.
 * The owner's AWS state goes through the same isolation check as every spawn
 * (`mergeProjectAwsSpawnEnv`); when it fails, AWS is disabled in the shell.
 *
 * The overlay also carries `AWS_PROFILE` when the project resolves a default
 * profile, because the generated config has no `[default]` section: without it
 * every un-flagged `aws` command dies with "Missing the following required SSO
 * configuration values".
 *
 * A value of `undefined` means "unset this inherited variable" — both SessionEnv
 * adapters drop undefined entries when materializing the PTY env.
 */

import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import config from '../config.js';
import { ensurePerUserHome } from '../per-user-home.js';
import type { Project } from '../types.js';
import type { SessionEnvKind } from '../session-env/session-env.js';
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
   * config files; a containerized shell would get paths that do not exist
   * inside its own filesystem.
   */
  envKind: SessionEnvKind;
  /** Session owner, or null for an ownerless operator terminal. */
  ownerUserId: string | null;
  /** HOME the PTY would otherwise inherit (tests). Defaults to the server HOME. */
  serverHome?: string;
}

/**
 * Pin HOME to the owner's per-user HOME and keep git/gh on the server's
 * config. Returns false when the per-user HOME cannot be created.
 */
function pinOwnerHome(
  overlay: TerminalShellEnvOverlay,
  ownerUserId: string,
  serverHome: string,
): boolean {
  try {
    overlay.HOME = ensurePerUserHome(ownerUserId, config.dataDir);
  } catch (err) {
    console.warn(
      `[terminal] per-user HOME unavailable for ${ownerUserId}: ${(err as Error).message.slice(0, 200)}`,
    );
    return false;
  }
  const gitConfig = path.join(serverHome, '.gitconfig');
  if (!process.env.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) {
    overlay.GIT_CONFIG_GLOBAL = gitConfig;
  }
  const ghConfig = path.join(serverHome, '.config', 'gh');
  if (!process.env.GH_CONFIG_DIR && existsSync(ghConfig)) overlay.GH_CONFIG_DIR = ghConfig;
  return true;
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
  if (opts.envKind !== 'host') return {};
  const overlay: TerminalShellEnvOverlay = {};
  const owner = opts.ownerUserId?.trim() || null;
  if (owner) pinOwnerHome(overlay, owner, opts.serverHome ?? process.env.HOME ?? os.homedir());
  if (!project || !projectHasAwsSsoProfiles(project)) return overlay;

  // Without a pinned HOME the isolation check sees no HOME for the owner and
  // disables AWS, which is the intended fail-closed result.
  const awsEnv = { ...overlay } as NodeJS.ProcessEnv;
  const applied = mergeProjectAwsSpawnEnv(awsEnv, project, { ownerUserId: owner });
  if (!applied && !awsEnv.AGENT_HUB_AWS_DISABLED_REASON) return overlay;
  Object.assign(overlay, awsEnv);

  // `mergeProjectAwsSpawnEnv` scrubs by deleting keys, which on an overlay just
  // lets the inherited value through. Re-state them as explicit unsets, but
  // never clobber a key the merge deliberately set afterwards (`AWS_PROFILE`,
  // the project's default profile).
  for (const key of AWS_AMBIENT_CREDENTIAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(overlay, key)) overlay[key] = undefined;
  }
  return overlay;
}
