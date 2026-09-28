/**
 * Live lookup of an open GitHub PR for a head branch.
 *
 * Kanban placement and cached card fields do not establish whether a GitHub
 * PR is open, so callers that must not act on an open PR (session discard)
 * ask GitHub directly and treat any failure as "unknown".
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AppConfig } from './types.js';
import {
  autoGitChildEnv,
  resolveAutoGitGithubToken,
  resolveOrgOwnerGithubToken,
} from './auto-git.js';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 20_000;

export type BranchPrState =
  | { kind: 'open'; ref: string }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: string };

export async function lookupGithubOpenPr(args: {
  /** `owner/repo`. */
  repo: string;
  branch: string;
  sessionId: string;
  config: Pick<AppConfig, 'personalOAuth'>;
}): Promise<BranchPrState> {
  try {
    const token =
      (await resolveAutoGitGithubToken(args.sessionId, args.config)) ??
      (await resolveOrgOwnerGithubToken(args.config, args.repo));
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        args.repo,
        '--head',
        args.branch,
        '--state',
        'open',
        '--json',
        'number,url',
        '--limit',
        '1',
      ],
      { env: autoGitChildEnv(token), timeout: GH_TIMEOUT_MS },
    );
    const parsed: unknown = JSON.parse(String(stdout));
    if (!Array.isArray(parsed)) return { kind: 'unknown', reason: 'unexpected gh output' };
    const first = parsed[0] as { url?: unknown; number?: unknown } | undefined;
    if (!first) return { kind: 'none' };
    return {
      kind: 'open',
      ref: typeof first.url === 'string' ? first.url : `#${String(first.number)}`,
    };
  } catch (err) {
    return { kind: 'unknown', reason: (err as Error).message.split('\n')[0] ?? 'gh failed' };
  }
}
