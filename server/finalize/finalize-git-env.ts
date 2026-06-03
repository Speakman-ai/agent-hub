import {
  autoGitChildEnv,
  resolveAutoGitGithubToken,
  resolveOrgOwnerGithubToken,
} from '../auto-git.js';
import type { AppConfig, Project } from '../types.js';

/**
 * Git/gh env for Finalize phases that spawn `git fetch`, `git rebase`, etc.
 * Session worktrees clone over HTTPS without persisted credentials — the
 * same token wiring auto-git uses for push must be injected here.
 */
export async function mergeFinalizeGitSpawnEnv(
  spawnEnv: NodeJS.ProcessEnv,
  args: {
    config: Pick<AppConfig, 'personalOAuth' | 'githubApp'>;
    project: Pick<Project, 'githubRepo'>;
    sessionId?: string | null;
  },
): Promise<void> {
  const sessionToken = args.sessionId
    ? await resolveAutoGitGithubToken(args.sessionId, args.config)
    : null;
  const token =
    sessionToken ??
    (await resolveOrgOwnerGithubToken(args.config, args.project.githubRepo ?? null));
  const gitEnv = autoGitChildEnv(token);
  Object.assign(spawnEnv, gitEnv);
}
