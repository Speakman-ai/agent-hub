/** Owner / repo labels matching GitHub's `owner/repo` header. */

export function githubRepoIdentity(project: any, projectId: string) {
  const slug = typeof project?.githubRepo === 'string' ? project.githubRepo.trim() : '';
  const match = slug.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  const owner = match?.[1] || (typeof project?.orgName === 'string' && project.orgName) || 'hub';
  const repo = match?.[2] || (typeof project?.name === 'string' && project.name) || projectId;
  return { owner, repo, slug: `${owner}/${repo}` };
}

/**
 * Is this project's repository hosted by Agent Hub?
 *
 * The Code tab (RepositoryPage) is backed entirely by `git-host` endpoints,
 * which reject any project without `gitHost: 'agenthub'`. Callers use this to
 * decide whether to offer Code navigation at all, rather than routing the user
 * to a guaranteed error page.
 */
export function isHubHostedProject(project: any): boolean {
  return project?.gitHost === 'agenthub';
}
