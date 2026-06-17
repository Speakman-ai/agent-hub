/**
 * RepositoryPage — browse an Agent Hub-hosted repository (gitHost:
 * 'agenthub'): commit history per branch, a full commit page per commit
 * (metadata + per-file diffs), the branch list with ahead/behind counts
 * vs the default branch, and a shortcut to the project's pull requests.
 *
 * Mounted from App.jsx as the `repo:<projectId>` view; the sidebar shows
 * the "Repository" entry only for Hub-hosted projects. Data comes from
 * the read-only endpoints in server/routes/git-host.ts. The commit page
 * is in-component navigation (selected sha in state) — consistent with
 * how PullRequestsPage handles its detail view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  FileText,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { relativePrTime } from '../utils/prFormatting.js';
import { splitUnifiedDiff } from '../utils/commitDiff.js';
import { FileDiffSection } from './FileDiffView.jsx';
import { MarkdownContent } from './MarkdownRenderer.jsx';
import GitHostMirrorStatusBanner from './GitHostMirrorStatusBanner.jsx';

function shortSha(sha) {
  return (sha || '').slice(0, 8);
}

/**
 * Full commit page: metadata header + per-file diff sections. Rendered
 * in place of the list when a commit is selected.
 */
function CommitDetailView({ projectId, sha, onBack, onOpenCommit }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api
      .getGitHostCommitDetail(projectId, sha)
      .then(setDetail)
      .catch((err) => setError(String(err?.message || err || 'Failed to load commit')));
  }, [projectId, sha]);

  const copySha = async () => {
    try {
      await navigator.clipboard.writeText(detail?.sha || sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — sha is selectable text */
    }
  };

  const files = detail ? splitUnifiedDiff(detail.patch) : [];
  const totals = files.reduce(
    (acc, f) => ({
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="space-y-3" data-testid="repo-commit-page">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        data-testid="repo-commit-back"
      >
        <ArrowLeft size={14} /> Commits
      </button>

      {!detail && !error && (
        <p className="text-sm text-gray-500 flex items-center gap-2 py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading commit…
        </p>
      )}
      {error && <p className="text-sm text-red-400 py-4">{error}</p>}

      {detail && (
        <>
          <div className="border border-gray-700/60 rounded-lg bg-gray-900/40 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <GitCommitHorizontal size={16} className="text-gray-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-gray-100 font-medium flex-1">{detail.subject}</p>
            </div>
            {detail.body && (
              <pre className="text-xs text-gray-400 whitespace-pre-wrap font-sans pl-6">
                {detail.body}
              </pre>
            )}
            <div className="flex items-center gap-3 flex-wrap pl-6 text-xs text-gray-500">
              <span>{detail.author}</span>
              <span className="tabular-nums">{relativePrTime(detail.date)}</span>
              <span className="flex items-center gap-1">
                <code className="font-mono text-gray-400">{shortSha(detail.sha)}</code>
                <button
                  type="button"
                  onClick={copySha}
                  className="text-gray-500 hover:text-gray-300 transition-colors"
                  title="Copy full sha"
                  data-testid="repo-commit-copy-sha"
                >
                  {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
              </span>
              {(detail.parents || []).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onOpenCommit(p)}
                  className="font-mono text-sky-500 hover:text-sky-300 transition-colors"
                  title={`Open parent ${p}`}
                >
                  parent {shortSha(p)}
                </button>
              ))}
              <span className="tabular-nums">
                {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
                <span className="text-emerald-400">+{totals.additions}</span>{' '}
                <span className="text-red-400">−{totals.deletions}</span>
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            {files.map((section, i) => (
              <FileDiffSection
                key={`${section.filename}-${i}`}
                section={section}
                // Auto-collapse very large commits so the page stays usable.
                defaultOpen={files.length <= 25}
              />
            ))}
            {files.length === 0 && (
              <p className="text-sm text-gray-600 italic py-4">
                No textual changes (empty or merge commit).
              </p>
            )}
          </div>
          {detail.patchTruncated && (
            <p className="text-[11px] text-amber-400">
              Diff truncated at 1 MiB — clone the repo to see the full change.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function CommitRow({ commit, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-3 py-2 text-left border border-gray-700/60 rounded-lg bg-gray-900/40 hover:bg-gray-900/70 hover:border-gray-600 transition-colors"
      data-testid={`repo-commit-${shortSha(commit.sha)}`}
    >
      <GitCommitHorizontal size={14} className="text-gray-500 flex-shrink-0" />
      <span className="text-sm text-gray-200 truncate flex-1" title={commit.subject}>
        {commit.subject}
      </span>
      <code className="text-[11px] text-gray-500 font-mono flex-shrink-0">
        {shortSha(commit.sha)}
      </code>
      <span className="text-xs text-gray-500 flex-shrink-0 hidden sm:inline">{commit.author}</span>
      <span className="text-xs text-gray-600 flex-shrink-0 tabular-nums">
        {relativePrTime(commit.date)}
      </span>
    </button>
  );
}

/**
 * Collapsible README card rendered above the commit list. `readme` is the
 * `{ path, content, truncated }` payload from the git-host readme endpoint,
 * or null when the branch has no root README (the card hides itself).
 */
function ReadmeCard({ readme }) {
  const [open, setOpen] = useState(true);
  if (!readme) return null;
  return (
    <div
      className="border border-gray-700/60 rounded-lg bg-gray-900/40 overflow-hidden"
      data-testid="repo-readme"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-900/70 transition-colors"
        data-testid="repo-readme-toggle"
      >
        {open ? (
          <ChevronDown size={14} className="text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-gray-500 flex-shrink-0" />
        )}
        <FileText size={14} className="text-gray-500 flex-shrink-0" />
        <span className="text-sm text-gray-200 font-mono">{readme.path}</span>
      </button>
      {open && (
        <div className="border-t border-gray-700/60 px-4 py-3">
          <div
            className="prose prose-invert prose-sm max-w-none text-gray-300"
            data-testid="repo-readme-content"
          >
            <MarkdownContent content={readme.content || ''} />
          </div>
          {readme.truncated && (
            <p className="text-[11px] text-amber-400 mt-2">
              README truncated — clone the repo to read the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function RepositoryPage({ projectId, project, onOpenPulls, onToast }) {
  const [tab, setTab] = useState('commits');
  const [branchData, setBranchData] = useState(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [commits, setCommits] = useState(null);
  const [readme, setReadme] = useState(null);
  const [openPrCount, setOpenPrCount] = useState(null);
  const [commitSha, setCommitSha] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Two-click branch delete: first click arms, second click deletes.
  const [confirmDeleteBranch, setConfirmDeleteBranch] = useState(null);
  const [deletingBranch, setDeletingBranch] = useState(null);

  const handleDeleteBranch = async (branch) => {
    if (confirmDeleteBranch !== branch) {
      setConfirmDeleteBranch(branch);
      setTimeout(() => setConfirmDeleteBranch((cur) => (cur === branch ? null : cur)), 8000);
      return;
    }
    setConfirmDeleteBranch(null);
    setDeletingBranch(branch);
    try {
      await api.deleteGitHostBranch(projectId, branch);
      if (onToast) onToast(`Deleted ${branch}.`, 'success', 4000);
      const data = await api.getGitHostBranches(projectId);
      setBranchData(data);
    } catch (err) {
      if (onToast) onToast(String(err?.message || err || 'Delete failed'), 'error', 6000);
    } finally {
      setDeletingBranch(null);
    }
  };

  const loadBranches = useCallback(async () => {
    const data = await api.getGitHostBranches(projectId);
    setBranchData(data);
    return data;
  }, [projectId]);

  const loadCommits = useCallback(
    async (branch) => {
      const data = await api.getGitHostCommits(projectId, { branch: branch || undefined });
      setCommits(data.commits);
      return data;
    },
    [projectId],
  );

  // README is a nice-to-have — never block the page (or surface a toast) on it.
  // A monotonic request id guards against a slow earlier fetch (older branch)
  // resolving after a newer branch was selected and overwriting its README.
  const readmeReqRef = useRef(0);
  const loadReadme = useCallback(
    async (branch) => {
      const reqId = ++readmeReqRef.current;
      setReadme(null);
      try {
        const data = await api.getGitHostReadme(projectId, { branch: branch || undefined });
        if (readmeReqRef.current !== reqId) return; // superseded by a later request
        setReadme(data?.readme || null);
      } catch {
        if (readmeReqRef.current !== reqId) return;
        setReadme(null);
      }
    },
    [projectId],
  );

  const refresh = useCallback(
    async (branch) => {
      setLoading(true);
      setError(null);
      try {
        const branches = await loadBranches();
        const target = branch || branches.defaultBranch || '';
        setSelectedBranch(target);
        await loadCommits(target);
        loadReadme(target);
      } catch (err) {
        setError(String(err?.message || err || 'Failed to load repository'));
      } finally {
        setLoading(false);
      }
    },
    [loadBranches, loadCommits, loadReadme],
  );

  useEffect(() => {
    setBranchData(null);
    setCommits(null);
    setReadme(null);
    setCommitSha(null);
    refresh();
    // Open-PR count is a nice-to-have — never block the page on it.
    api
      .getProjectPulls(projectId, { state: 'open', limit: 100 })
      .then((d) => setOpenPrCount(Array.isArray(d?.pulls) ? d.pulls.length : null))
      .catch(() => setOpenPrCount(null));
  }, [projectId, refresh]);

  const handleBranchChange = async (branch) => {
    setSelectedBranch(branch);
    setCommitSha(null);
    loadReadme(branch);
    try {
      await loadCommits(branch);
    } catch (err) {
      if (onToast) onToast(String(err?.message || err), 'error');
    }
  };

  const tabClass = (active) =>
    `px-3 py-1.5 text-sm rounded-lg transition-colors ${
      active ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'
    }`;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="w-full space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <GitBranch size={18} className="text-gray-400" />
            Repository
            <span className="text-gray-500 font-normal">· {project?.name || projectId}</span>
          </h3>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => refresh(selectedBranch)}
              className="p-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
              title="Refresh"
              data-testid="repo-refresh"
            >
              <RefreshCw size={14} />
            </button>
            {onOpenPulls && (
              <button
                type="button"
                onClick={() => onOpenPulls(projectId)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 transition-colors"
                data-testid="repo-open-pulls"
              >
                <GitPullRequest size={14} />
                {openPrCount === null
                  ? 'Pull requests'
                  : `${openPrCount} open PR${openPrCount === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>

        <GitHostMirrorStatusBanner projectId={projectId} onToast={onToast} />

        {/* Commit page replaces the tabbed lists while a commit is open. */}
        {commitSha ? (
          <CommitDetailView
            projectId={projectId}
            sha={commitSha}
            onBack={() => setCommitSha(null)}
            onOpenCommit={(sha) => setCommitSha(sha)}
          />
        ) : (
          <>
            <div className="flex items-center gap-1 bg-gray-800 rounded-xl p-1 w-fit">
              <button
                type="button"
                onClick={() => setTab('commits')}
                className={tabClass(tab === 'commits')}
              >
                Commits
              </button>
              <button
                type="button"
                onClick={() => setTab('branches')}
                className={tabClass(tab === 'branches')}
              >
                Branches{branchData ? ` (${branchData.branches.length})` : ''}
              </button>
            </div>

            {loading && (
              <p className="text-sm text-gray-500 flex items-center gap-2 py-6 justify-center">
                <Loader2 size={16} className="animate-spin" /> Loading repository…
              </p>
            )}
            {error && !loading && (
              <p className="text-sm text-red-400 py-4">
                {error.includes('not hosted')
                  ? 'This project is not hosted on Agent Hub. Enable Git hosting in Project settings.'
                  : error}
              </p>
            )}

            {!loading && !error && tab === 'commits' && (
              <div className="space-y-3">
                {branchData && (
                  <select
                    value={selectedBranch}
                    onChange={(e) => handleBranchChange(e.target.value)}
                    className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-600 max-w-full"
                    data-testid="repo-branch-select"
                  >
                    {branchData.branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                )}
                <ReadmeCard readme={readme} />
                <div className="space-y-1.5" data-testid="repo-commit-list">
                  {(commits || []).map((c) => (
                    <CommitRow key={c.sha} commit={c} onOpen={() => setCommitSha(c.sha)} />
                  ))}
                  {commits && commits.length === 0 && (
                    <p className="text-sm text-gray-600 italic py-4">
                      No commits on this branch yet.
                    </p>
                  )}
                </div>
              </div>
            )}

            {!loading && !error && tab === 'branches' && branchData && (
              <div className="space-y-1.5" data-testid="repo-branch-list">
                {branchData.branches.map((b) => (
                  <div
                    key={b.name}
                    className="flex items-center gap-3 px-3 py-2 border border-gray-700/60 rounded-lg bg-gray-900/40"
                  >
                    <GitBranch size={14} className="text-gray-500 flex-shrink-0" />
                    <button
                      type="button"
                      onClick={() => {
                        setTab('commits');
                        handleBranchChange(b.name);
                      }}
                      className="text-sm text-sky-400 hover:text-sky-300 font-mono truncate"
                      title={`Browse commits on ${b.name}`}
                    >
                      {b.name}
                    </button>
                    {b.isDefault && (
                      <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 flex-shrink-0">
                        <Star size={10} /> default
                      </span>
                    )}
                    {!b.isDefault && (b.ahead !== null || b.behind !== null) && (
                      <span className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">
                        {b.ahead ?? '?'} ahead · {b.behind ?? '?'} behind
                      </span>
                    )}
                    <span
                      className="text-xs text-gray-500 truncate flex-1 text-right"
                      title={b.subject}
                    >
                      {b.subject}
                    </span>
                    <span className="text-xs text-gray-600 flex-shrink-0 tabular-nums">
                      {relativePrTime(b.date)}
                    </span>
                    {!b.isDefault && (
                      <button
                        type="button"
                        onClick={() => handleDeleteBranch(b.name)}
                        disabled={deletingBranch === b.name}
                        title={
                          confirmDeleteBranch === b.name
                            ? 'Click again to permanently delete this branch'
                            : `Delete ${b.name}`
                        }
                        data-testid={`delete-branch-${b.name}`}
                        className={`flex items-center gap-1 rounded flex-shrink-0 transition-colors ${
                          confirmDeleteBranch === b.name
                            ? 'px-2 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-500'
                            : 'p-1 text-gray-600 hover:text-red-400'
                        }`}
                      >
                        {deletingBranch === b.name ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                        {confirmDeleteBranch === b.name && 'Delete branch?'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
