/**
 * host.ts — the single predicate + path helpers shared by every native-PR
 * branch point (routes, finalize push step, client-facing URL builders).
 */

import type { Project } from '../types.js';
import { gitHostRepoPath, hostedRepoExists } from '../git-host/repo-store.js';

/** True when the project's canonical git remote is Agent Hub itself. */
export function isAgentHubHosted(project: Pick<Project, 'gitHost'>): boolean {
  return project.gitHost === 'agenthub';
}

/** Bare repo path for a hosted project (throws on invalid id shapes). */
export function bareRepoPath(projectId: string): string {
  return gitHostRepoPath(projectId);
}

export { hostedRepoExists };
