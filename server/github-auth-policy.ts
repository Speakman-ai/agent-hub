/**
 * Shared copy for GitHub credential policy.
 *
 * GitHub access is strictly per-user: every human-facing route and spawn
 * uses the acting user's own connection (OAuth or PAT from Settings →
 * GitHub).
 */

import type { Response } from 'express';
import {
  AUTH_CODE_GITHUB_NOT_CONNECTED,
  GITHUB_NOT_CONNECTED_STATUS,
} from '../shared/utils/authErrorCodes.js';

export const CONNECT_GITHUB_HINT =
  'Connect your GitHub account in Settings → GitHub (Sign in with GitHub or paste a personal access token).';

/**
 * Reject a request from an authenticated caller who has no GitHub connection.
 *
 * Deliberately not `401`: the caller's own credentials are fine, and the web
 * client clears its token on any response tagged as a dead session. Returning
 * `401` here logged users out mid-session every time a project with a
 * `githubRepo` refreshed its open-PR count.
 */
export function respondGitHubNotConnected(res: Response): Response {
  return res
    .status(GITHUB_NOT_CONNECTED_STATUS)
    .json({ error: CONNECT_GITHUB_HINT, code: AUTH_CODE_GITHUB_NOT_CONNECTED });
}
