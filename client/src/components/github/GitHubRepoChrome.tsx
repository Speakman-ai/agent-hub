import { Code, FolderGit2, GitPullRequest } from 'lucide-react';
import { githubRepoIdentity } from './githubRepoIdentity';

/**
 * Repository header + underline nav shared by the Code tab (RepositoryPage)
 * and the Pull requests list/detail (PullRequestsPage).
 */
export default function GitHubRepoChrome({
  project,
  projectId,
  active,
  openPrCount = null,
  onOpenCode = null,
  onOpenPulls = null,
  children,
}: any) {
  const { owner, repo } = githubRepoIdentity(project, projectId);
  const isPrivate = project?.gitHost === 'agenthub' || project?.visibility === 'private';

  return (
    <div className="gh-page flex-1 overflow-y-auto" data-testid="github-repo-chrome">
      <div className="border-b border-gray-800">
        <div className="px-4 pt-4 pb-3 md:px-6">
          <div className="flex items-center gap-2 flex-wrap">
            <FolderGit2 size={16} className="text-sky-400/80 flex-shrink-0" aria-hidden />
            <h1 className="text-lg font-semibold leading-7 flex items-center gap-1 min-w-0">
              <span className="text-gray-400 truncate">{owner}</span>
              <span className="text-gray-600">/</span>
              <span className="text-gray-100 truncate">{repo}</span>
            </h1>
            <span className="text-[11px] leading-[18px] px-2 rounded-md border border-gray-700 bg-gray-900 text-gray-400 font-medium">
              {isPrivate ? 'Private' : 'Public'}
            </span>
          </div>
        </div>
        <nav className="gh-underline-nav px-2 md:px-4" aria-label="Repository">
          <button
            type="button"
            className={`gh-underline-nav-item ${active === 'code' ? 'is-active' : ''}`}
            aria-current={active === 'code' ? 'page' : undefined}
            data-testid="repo-tab-code"
            onClick={() => onOpenCode?.(projectId)}
            disabled={typeof onOpenCode !== 'function'}
            title={
              typeof onOpenCode === 'function'
                ? undefined
                : 'Code browsing is available for Agent Hub-hosted repositories'
            }
          >
            <Code size={16} aria-hidden />
            Code
          </button>
          <button
            type="button"
            className={`gh-underline-nav-item ${active === 'pulls' ? 'is-active' : ''}`}
            aria-current={active === 'pulls' ? 'page' : undefined}
            data-testid="repo-tab-pulls"
            onClick={() => onOpenPulls?.(projectId)}
            disabled={typeof onOpenPulls !== 'function'}
          >
            <GitPullRequest size={16} aria-hidden />
            Pull requests
            {openPrCount != null && (
              <span className="gh-counter" data-testid="repo-open-pr-count">
                {openPrCount}
              </span>
            )}
          </button>
        </nav>
      </div>
      <div className="px-4 py-4 md:px-6 md:py-5">{children}</div>
    </div>
  );
}
