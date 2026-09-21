/**
 * RepositoryPage — GitHub Code-tab parity for Agent Hub-hosted repos
 * (gitHost: 'agenthub'): file tree with last-commit columns, blob viewer,
 * rendered README, commit history, and the branch list.
 *
 * Mounted from App as the `repo:<projectId>` view. Data comes from the
 * read-only endpoints in server/routes/git-host.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GitBranch,
  GitCommitHorizontal,
  ArrowLeft,
  ChevronDown,
  Copy,
  Check,
  FileText,
  File,
  Folder,
  FolderGit2,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  History,
  Search,
  Code,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import { relativePrTime } from '../utils/prFormatting';
import { splitUnifiedDiff } from '../utils/commitDiff';
import { FileDiffSection } from './FileDiffView';
import { MarkdownContent } from './MarkdownRenderer';
import { resolveRepoImageUrl } from '../utils/resolveRepoMediaUrl';
import GitHostMirrorStatusBanner from './GitHostMirrorStatusBanner';
import GitHubRepoChrome from './github/GitHubRepoChrome';

function shortSha(sha: any) {
  return (sha || '').slice(0, 8);
}

function languageFromPath(filePath: string) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    json: 'json',
    md: 'md',
    markdown: 'md',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    css: 'css',
    scss: 'scss',
    html: 'html',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
  };
  return map[ext] || '';
}

function isMarkdownPath(filePath: string) {
  return (
    /\.(md|markdown|mdown|mkd)$/i.test(filePath) ||
    /^readme$/i.test(filePath.split('/').pop() || '')
  );
}

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} Bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Full commit page: metadata header + per-file diff sections. Rendered
 * in place of the list when a commit is selected.
 */
function CommitDetailView({ projectId, sha, onBack, onOpenCommit }: any) {
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Same scope-guard rule as the page. Today `sha` only changes across an
    // unmount, so this is hardening rather than a reachable repro (hence no
    // regression test) — it stops the class returning if a caller ever swaps
    // the prop in place.
    let current = true;
    setDetail(null);
    setError(null);
    api
      .getGitHostCommitDetail(projectId, sha)
      .then((d: any) => {
        if (current) setDetail(d);
      })
      .catch((err: any) => {
        if (current) setError(String(err?.message || err || 'Failed to load commit'));
      });
    return () => {
      current = false;
    };
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
    (acc: any, f: any) => ({
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
        className="flex items-center gap-1.5 text-sm text-gh-accent hover:underline"
        data-testid="repo-commit-back"
      >
        <ArrowLeft size={14} /> Commits
      </button>

      {!detail && !error && (
        <p className="text-sm text-gh-muted flex items-center gap-2 py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading commit…
        </p>
      )}
      {error && <p className="text-sm text-gh-danger py-4">{error}</p>}

      {detail && (
        <>
          <div className="border border-gh-border rounded-xl bg-gh-subtle p-4 space-y-2">
            <p className="text-xl font-semibold text-gh-fg">{detail.subject}</p>
            {detail.body && (
              <pre className="text-sm text-gh-muted whitespace-pre-wrap font-sans">
                {detail.body}
              </pre>
            )}
            <div className="flex items-center gap-3 flex-wrap text-xs text-gh-muted">
              <span className="font-semibold text-gh-fg">{detail.author}</span>
              <span className="tabular-nums">committed {relativePrTime(detail.date)}</span>
              <span className="flex items-center gap-1">
                <code className="font-mono text-gh-accent">{shortSha(detail.sha)}</code>
                <button
                  type="button"
                  onClick={copySha}
                  className="text-gh-muted hover:text-gh-fg"
                  title="Copy full sha"
                  data-testid="repo-commit-copy-sha"
                >
                  {copied ? <Check size={11} className="text-gh-success" /> : <Copy size={11} />}
                </button>
              </span>
              {(detail.parents || []).map((p: any) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onOpenCommit(p)}
                  className="font-mono text-gh-accent hover:underline"
                  title={`Open parent ${p}`}
                >
                  parent {shortSha(p)}
                </button>
              ))}
              <span className="tabular-nums">
                {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
                <span className="text-gh-success">+{totals.additions}</span>{' '}
                <span className="text-gh-danger">−{totals.deletions}</span>
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            {files.map((section: any, i: any) => (
              <FileDiffSection
                key={`${section.filename}-${i}`}
                section={section}
                defaultOpen={files.length <= 25}
              />
            ))}
            {files.length === 0 && (
              <p className="text-sm text-gh-muted italic py-4">
                No textual changes (empty or merge commit).
              </p>
            )}
          </div>
          {detail.patchTruncated && (
            <p className="text-[11px] text-gh-attention">
              Diff truncated at 1 MiB — clone the repo to see the full change.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ReadmeCard({ readme, projectId }: any) {
  const baseDir = readme?.path ? readme.path.split('/').slice(0, -1).join('/') : '';
  const imageSrcTransform = useCallback(
    (src: any) =>
      resolveRepoImageUrl(src, {
        projectId,
        branch: readme?.branch,
        mediaToken: readme?.mediaToken,
        baseDir,
      }),
    [projectId, readme?.branch, readme?.mediaToken, baseDir],
  );
  if (!readme) return null;
  return (
    <div
      className="border border-gh-border rounded-xl bg-gh-canvas overflow-hidden"
      data-testid="repo-readme"
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gh-border bg-gh-subtle">
        <FileText size={16} className="text-gh-muted flex-shrink-0" />
        <span className="text-sm font-semibold text-gh-fg" data-testid="repo-readme-toggle">
          {readme.path}
        </span>
      </div>
      <div className="px-8 py-6">
        <div
          className="prose prose-invert prose-sm max-w-none text-gh-fg"
          data-testid="repo-readme-content"
        >
          <MarkdownContent content={readme.content || ''} imageSrcTransform={imageSrcTransform} />
        </div>
        {readme.truncated && (
          <p className="text-[11px] text-gh-attention mt-2">
            README truncated — clone the repo to read the rest.
          </p>
        )}
      </div>
    </div>
  );
}

function FileBlobView({ projectId, branch, filePath, onBack }: any) {
  const [file, setFile] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  // A Markdown blob resolves relative images the same way the README card
  // does. Without this the same `![](img.png)` that renders in the root README
  // resolves against the SPA URL once the file is opened, and 404s. The base is
  // the file's OWN directory, so nested docs (docs/guide.md) work too.
  const blobBaseDir = filePath ? String(filePath).split('/').slice(0, -1).join('/') : '';
  const imageSrcTransform = useCallback(
    (src: any) =>
      resolveRepoImageUrl(src, {
        projectId,
        branch: file?.branch || branch,
        mediaToken: file?.mediaToken,
        baseDir: blobBaseDir,
      }),
    [projectId, file?.branch, file?.mediaToken, branch, blobBaseDir],
  );

  useEffect(() => {
    // Scope guard, same rule as the page. Today `filePath`/`branch` only change
    // across an unmount, so this is hardening rather than a reachable repro
    // (hence no regression test); it stops the class returning if a caller ever
    // swaps these props in place.
    let current = true;
    setFile(null);
    setError(null);
    api
      .getGitHostFile(projectId, { branch, path: filePath })
      .then((f: any) => {
        if (current) setFile(f);
      })
      .catch((err: any) => {
        if (current) setError(String(err?.message || err || 'Failed to load file'));
      });
    return () => {
      current = false;
    };
  }, [projectId, branch, filePath]);

  const copy = async () => {
    if (!file?.content) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const lines =
    typeof file?.content === 'string' ? file.content.replace(/\n$/, '').split('\n') : [];
  const lang = languageFromPath(filePath);
  const markdown = isMarkdownPath(filePath) && file?.content;

  return (
    <div className="space-y-3" data-testid="repo-file-page">
      <button
        type="button"
        onClick={onBack}
        data-testid="repo-blob-back"
        aria-label="Back to file tree"
        className="flex items-center gap-1.5 text-sm text-gh-accent hover:underline"
      >
        <ArrowLeft size={14} /> Files
      </button>
      {!file && !error && (
        <p className="text-sm text-gh-muted flex items-center gap-2 py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading file…
        </p>
      )}
      {error && <p className="text-sm text-gh-danger py-4">{error}</p>}
      {file && (
        <div className="border border-gh-border rounded-xl overflow-hidden bg-gh-canvas">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gh-border bg-gh-subtle flex-wrap">
            <File size={16} className="text-gh-muted" />
            <span className="text-sm font-semibold text-gh-fg font-mono">
              {filePath.split('/').pop()}
            </span>
            <span className="text-xs text-gh-muted tabular-nums">
              {lines.length} lines · {formatBytes(file.size)}
            </span>
            <span className="flex-1" />
            {!file.binary && (
              <button type="button" onClick={copy} className="gh-btn text-xs py-0.5">
                {copied ? <Check size={12} /> : <Copy size={12} />}
                Copy
              </button>
            )}
          </div>
          {file.binary ? (
            <p className="text-sm text-gh-muted p-6">Binary file — clone the repo to view it.</p>
          ) : markdown ? (
            <div
              className="px-8 py-6 prose prose-invert prose-sm max-w-none"
              data-testid="repo-blob-markdown"
            >
              <MarkdownContent content={file.content} imageSrcTransform={imageSrcTransform} />
            </div>
          ) : (
            <pre className="text-[12px] leading-[20px] overflow-x-auto m-0 rounded-none bg-gh-canvas p-0">
              <code className={lang ? `language-${lang}` : undefined}>
                {lines.map((line: string, i: number) => (
                  <span key={i} className="flex hover:bg-gh-subtle">
                    <span className="w-12 flex-shrink-0 text-right pr-4 text-gh-muted select-none">
                      {i + 1}
                    </span>
                    <span className="flex-1 whitespace-pre text-gh-fg">{line || ' '}</span>
                  </span>
                ))}
              </code>
            </pre>
          )}
          {file.truncated && (
            <p className="text-[11px] text-gh-attention px-3 py-2 border-t border-gh-border">
              File truncated at 512 KiB — clone the repo to read the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Breadcrumbs({ repoName, dirPath, onOpenRoot, onOpenDir }: any) {
  const parts = (dirPath || '').split('/').filter(Boolean);
  return (
    <nav className="flex items-center gap-1 text-sm flex-wrap" aria-label="Files">
      <button
        type="button"
        onClick={onOpenRoot}
        className="text-gh-accent font-semibold hover:underline"
      >
        {repoName}
      </button>
      {parts.map((part: string, i: number) => {
        const sub = parts.slice(0, i + 1).join('/');
        const last = i === parts.length - 1;
        return (
          <span key={sub} className="flex items-center gap-1">
            <span className="text-gh-muted">/</span>
            {last ? (
              <span className="font-semibold text-gh-fg">{part}</span>
            ) : (
              <button
                type="button"
                onClick={() => onOpenDir(sub)}
                className="text-gh-accent hover:underline"
              >
                {part}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** Identity of a tree fetch: which project, which branch, which directory. */
/** Per-scope cache entries retained (History / Go to file). */
const MAX_SCOPE_CACHE_ENTRIES = 8;

/**
 * A lazily-loaded, branch-scoped resource (History, Go to file).
 *
 * data, pending and error ALL describe one scope, so all three live in one
 * per-scope entry. Keying only the data — which is what this file used to do —
 * let a pending flag from branch A block branch B's request, and let A's later
 * rejection surface as B's error without B ever being fetched.
 */
interface ScopeEntry<T> {
  data?: T;
  pending?: boolean;
  error?: string | null;
}

function useScopedResource<T>(activeKeyRef: { current: string }) {
  const [entries, setEntries] = useState<Record<string, ScopeEntry<T>>>({});
  /**
   * Two levels, because "is this response still wanted?" has two independent
   * answers and a single shared counter conflates them:
   *
   * - epochRef: resource-wide, bumped only by reset() (refresh / unmount).
   *   Invalidates EVERY scope at once.
   * - genByKey: per scope. Only a newer request FOR THE SAME SCOPE supersedes
   *   an earlier one.
   *
   * With one shared counter, fetching branch B superseded branch A's in-flight
   * request, so A's response returned early without ever clearing A's pending
   * flag — orphaning that entry at pending:true. The self-heal refuses to fetch
   * a pending entry and no error means no Retry, so branch A showed "Loading…"
   * forever.
   */
  const epochRef = useRef(0);
  const genByKey = useRef<Record<string, number>>({});

  /**
   * Claim a request for `key`. The returned predicate reports whether this
   * particular request is still the one that scope is waiting for.
   */
  const begin = useCallback((key: string) => {
    const epoch = epochRef.current;
    const gen = (genByKey.current[key] ?? 0) + 1;
    genByKey.current[key] = gen;
    return () => epochRef.current === epoch && genByKey.current[key] === gen;
  }, []);

  const patch = useCallback(
    (key: string, next: ScopeEntry<T>) => {
      setEntries((prev) => {
        const merged: Record<string, ScopeEntry<T>> = {
          ...prev,
          [key]: { ...prev[key], ...next },
        };
        const keys = Object.keys(merged);
        if (keys.length > MAX_SCOPE_CACHE_ENTRIES) {
          const active = activeKeyRef.current;
          for (const stale of keys.slice(0, keys.length - MAX_SCOPE_CACHE_ENTRIES)) {
            // Never evict the entry just written, the one on screen, or one
            // with a request in flight (its response would find no entry and
            // the self-heal would then issue a duplicate).
            if (stale === key || stale === active || merged[stale]?.pending) continue;
            delete merged[stale];
          }
        }
        return merged;
      });
    },
    [activeKeyRef],
  );

  /** Drop every scope and supersede every in-flight request. */
  const reset = useCallback(() => {
    epochRef.current += 1;
    genByKey.current = {};
    setEntries({});
  }, []);

  return { entries, patch, begin, reset };
}

function treeKeyFor(projectId: any, branch: any, path: any): string {
  return `${projectId || ''}\u0000${branch || ''}\u0000${path || ''}`;
}

/**
 * Remount the page whenever the project changes.
 *
 * This is the structural fix for a defect class that recurred across seven
 * review rounds: project-scoped state surviving a project switch. The previous
 * approach — a hand-maintained list of resets in a `projectId` effect — is
 * guaranteed to drift, and did: at the time this wrapper was added, 7 of 24
 * state variables were still leaking (selectedBranch pinned retries to a branch
 * the new project may not have; cloneUrl offered project A's clone URL under
 * project B).
 *
 * Keying here rather than at the call site means the component guarantees its
 * own isolation instead of trusting every caller to remember a `key`.
 */
export default function RepositoryPage(props: any) {
  return <RepositoryPageInner key={props?.projectId} {...props} />;
}

function RepositoryPageInner({ projectId, project, onOpenPulls, onToast }: any) {
  const [view, setView] = useState<'code' | 'commits' | 'branches'>('code');
  const [branchData, setBranchData] = useState<any>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  /**
   * Tagged with the project/branch/dir it was fetched for. A failed navigation
   * leaves the previous tree in state while selectedBranch/dirPath already name
   * the NEW location, so an identity-free tree would hand the user stale rows
   * that fetch against the wrong branch when clicked.
   */
  /**
   * The tree keeps a single slot and GLOBAL pending/error, unlike the per-scope
   * resources below — and it is safe precisely because it is never served from
   * cache. Every path that renders a tree (refresh, branch change, openDir)
   * issues a request, so the generation always advances and a stale response is
   * always rejected before it can write data OR an error.
   *
   * Both hazards this file has hit need the same missing precondition: a scope
   * that RENDERS WITHOUT STARTING A REQUEST. That is what let a stale response
   * evict a displayed cache entry, and what let one branch's pending flag block
   * another's fetch. The tree never skips its request, so neither applies.
   */
  const [treeState, setTreeState] = useState<{ key: string; data: any } | null>(null);
  /** A tree request for the current branch/dir is in flight; `treeState` is stale. */
  const [treePending, setTreePending] = useState(false);
  /** Message from the most recent failed tree request, cleared on navigation. */
  const [treeError, setTreeError] = useState<string | null>(null);
  /** Hosted repo with no branch ref yet — empty, not broken. */
  const [isEmptyRepo, setIsEmptyRepo] = useState(false);
  const [dirPath, setDirPath] = useState('');
  const [filePath, setFilePath] = useState<string | null>(null);
  /**
   * Cached under the `${projectId}/${branch}` they were fetched for. App
   * reuses this component across projects without a `key`, so an identity-free
   * cache would let project A's commits/paths render under project B (the
   * fetch is skipped when the cache is merely non-null).
   */
  const [readme, setReadme] = useState<any>(null);
  const [openPrCount, setOpenPrCount] = useState<any>(null);
  const [commitSha, setCommitSha] = useState<any>(null);
  const [cloneUrl, setCloneUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [confirmDeleteBranch, setConfirmDeleteBranch] = useState<any>(null);
  const [deletingBranch, setDeletingBranch] = useState<any>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [codeMenuOpen, setCodeMenuOpen] = useState(false);
  const [copiedClone, setCopiedClone] = useState(false);
  const [goToFileOpen, setGoToFileOpen] = useState(false);
  const [goToQuery, setGoToQuery] = useState('');

  const handleDeleteBranch = async (branch: any) => {
    if (confirmDeleteBranch !== branch) {
      setConfirmDeleteBranch(branch);
      setTimeout(() => setConfirmDeleteBranch((cur: any) => (cur === branch ? null : cur)), 8000);
      return;
    }
    setConfirmDeleteBranch(null);
    setDeletingBranch(branch);
    const stillCurrentProject = captureProjectScope();
    try {
      await api.deleteGitHostBranch(projectId, branch);
      if (onToast) onToast(`Deleted ${branch}.`, 'success', 4000);
      // The delete may land after a project switch. loadBranches' own guard
      // cannot help here: this call would START a fresh request and win a new
      // generation, writing THIS project's branches over the current one.
      if (!stillCurrentProject()) return;
      await loadBranches();
    } catch (err: any) {
      if (stillCurrentProject() && onToast) {
        onToast(String(err?.message || err || 'Delete failed'), 'error', 6000);
      }
    } finally {
      if (stillCurrentProject()) setDeletingBranch(null);
    }
  };

  /** Identity every project/branch-scoped cache is keyed on. */
  /** Scope currently rendered; kept out of eviction by useScopedResource. */
  const activeScopeRef = useRef('');
  const scopeKey = `${projectId}\u0000${selectedBranch}`;
  activeScopeRef.current = scopeKey;

  const commitsRes = useScopedResource<any>(activeScopeRef);
  const pathsRes = useScopedResource<string[]>(activeScopeRef);
  // The hook returns a fresh wrapper object each render; only these members are
  // stable (useCallback / useRef). Effects and callbacks must depend on THESE,
  // never on the wrapper — depending on the wrapper re-runs the mount effect on
  // every render, which is an infinite refresh loop.
  const { patch: commitsPatch, begin: commitsBegin, reset: commitsReset } = commitsRes;
  const { patch: pathsPatch, begin: pathsBegin, reset: pathsReset } = pathsRes;
  // Per-scope entries, NOT a single keyed slot. With one slot, a response for
  // scope A landing while scope B is displayed overwrites the slot with an
  // A-keyed entry and B's derived value silently becomes null — and B's own
  // generation guard cannot help, because B was served from cache so it never
  // started a request to bump it. Writing under its own key makes a stale
  // response harmless by construction.
  const commitsEntry = commitsRes.entries[scopeKey];
  const pathsEntry = pathsRes.entries[scopeKey];
  const commits = commitsEntry?.data ?? null;
  const commitsPending = Boolean(commitsEntry?.pending);
  const commitsError = commitsEntry?.error ?? null;
  const allPaths = pathsEntry?.data ?? null;
  const pathsPending = Boolean(pathsEntry?.pending);
  const pathsError = pathsEntry?.error ?? null;

  /**
   * Generation guards. Branch and directory switches fire a new request while
   * the previous one is still in flight; without these a slow response for the
   * old branch/dir lands last and paints a tree the user is no longer on
   * (clicking an entry then 404s against the branch actually selected).
   */
  /**
   * Resource-wide generations, and correctly so: the state each protects is
   * itself resource-wide (one `treePending`, one `readme`, one `branchData`,
   * one `openPrCount`).
   *
   * That pairing is the rule this file took a long time to learn: THE
   * GRANULARITY OF A REQUEST GENERATION MUST MATCH THE GRANULARITY OF THE
   * STATE IT PROTECTS. A global flag with a global counter always has exactly
   * one live owner to clear it. A PER-SCOPE flag with a global counter does
   * not — another scope's fetch supersedes the response that was going to
   * clear it, orphaning that scope forever. History and Go to file hit exactly
   * that, which is why useScopedResource pairs per-scope entries with per-key
   * generations plus a resource-wide epoch.
   */
  const treeReqRef = useRef(0);
  const branchesReqRef = useRef(0);
  const openPrCountReqRef = useRef(0);
  const readmeReqRef = useRef(0);
  /**
   * Continuation scopes. A loader's own generation rejects a response that was
   * superseded WHILE IN FLIGHT, but a continuation that resumes and then STARTS
   * a new request wins a brand-new generation and looks current. So any
   * operation that awaits and then kicks off follow-on work must re-check the
   * scope that owns that work. There are two, because the follow-ups differ:
   *
   * - navGenRef  — bumped by EVERY navigation (project switch, branch
   *   selection, directory change, refresh). Guards follow-ups that are
   *   specific to a branch/directory, e.g. loadCommits after loadTree. Note a
   *   superseded loadTree still RESOLVES normally (it just discards its
   *   response), so the continuation runs and only this check stops it.
   * - projectGenRef — bumped only by a project switch. Guards follow-ups that
   *   are project-scoped but branch-agnostic, e.g. re-listing branches after a
   *   delete, which must survive an unrelated branch selection.
   */
  const navGenRef = useRef(0);
  const projectGenRef = useRef(0);
  /**
   * Bumped by every refresh AND by a project switch. `refresh` awaits
   * loadBranches before it touches state, so without this a pending refresh for
   * project A could resolve after the switch, set selectedBranch, and kick off
   * a loadTree that wins a FRESH generation and overwrites project B's tree.
   */
  const refreshGenRef = useRef(0);

  /**
   * Supersede EVERY in-flight request and continuation, and clear the UI state
   * those operations own.
   *
   * Both halves matter, and they are here together because each half alone is
   * a bug we have already shipped:
   *
   * 1. Listing every generation ref in ONE place — a hand-written bump list per
   *    call site is what let `readmeReqRef` be missed, so project A's README
   *    could render under project B.
   * 2. Clearing operation-scoped UI state — a superseded operation's guarded
   *    `finally` deliberately does NOT run, so whatever it would have reset is
   *    this function's responsibility. Miss it and the flag sticks forever:
   *    `deletingBranch` left set disables a same-named branch in the NEW
   *    project permanently, and a carried-over `confirmDeleteBranch` means the
   *    new project's branch deletes on the FIRST click.
   */
  const supersedeAllOperations = useCallback(() => {
    treeReqRef.current += 1;
    branchesReqRef.current += 1;
    readmeReqRef.current += 1;
    openPrCountReqRef.current += 1;
    navGenRef.current += 1;
    projectGenRef.current += 1;
    refreshGenRef.current += 1;
    // Cleanup the superseded operations will never run themselves.
    setTreePending(false);
    commitsReset();
    pathsReset();
    setDeletingBranch(null);
    setConfirmDeleteBranch(null);
  }, [commitsReset, pathsReset]);

  /**
   * Invalidate the branch-scoped lazy caches (History, Go to file).
   *
   * Bumping the generations is NOT optional, which is why clearing and bumping
   * live in one function instead of at each call site: clearing the state alone
   * leaves an already in-flight request free to resolve afterwards and
   * repopulate the cache under the SAME project/branch key with
   * pre-invalidation data. That then reads as a valid cache hit and suppresses
   * the refetch entirely, so the user sees stale history/paths.
   */
  const invalidateBranchCaches = useCallback(() => {
    // reset() bumps the generation AND drops every scope's data, pending and
    // error together — the three cannot drift apart.
    commitsReset();
    pathsReset();
  }, [commitsReset, pathsReset]);

  /**
   * Start a navigation: supersedes every in-flight continuation and returns the
   * predicate this navigation should re-check after each await.
   */
  const beginNavigation = useCallback(() => {
    const gen = ++navGenRef.current;
    return () => navGenRef.current === gen;
  }, []);

  /**
   * Capture (without superseding) for operations that are not themselves a
   * navigation but whose follow-up is project-scoped.
   */
  const captureProjectScope = useCallback(() => {
    const gen = projectGenRef.current;
    return () => projectGenRef.current === gen;
  }, []);

  const loadBranches = useCallback(async () => {
    const reqId = ++branchesReqRef.current;
    const data = await api.getGitHostBranches(projectId);
    if (branchesReqRef.current !== reqId) return data;
    setBranchData(data);
    return data;
  }, [projectId]);

  const loadTree = useCallback(
    async (branch: any, path = '') => {
      const reqId = ++treeReqRef.current;
      const key = treeKeyFor(projectId, branch, path);
      setTreePending(true);
      setTreeError(null);
      try {
        const data = await api.getGitHostTree(projectId, { branch: branch || undefined, path });
        if (treeReqRef.current !== reqId) return data;
        setTreeState({ key, data });
        setTreePending(false);
        return data;
      } catch (err: any) {
        if (treeReqRef.current === reqId) {
          // Deliberately do NOT write treeState: leaving the previous tree
          // tagged with its own location makes it invisible here, instead of
          // masquerading as the location that just failed to load.
          setTreePending(false);
          setTreeError(String(err?.message || err || 'Failed to load this location'));
        }
        throw err;
      }
    },
    [projectId],
  );

  const loadCommits = useCallback(
    async (branch: any) => {
      const key = `${projectId}\u0000${branch || ''}`;
      const isCurrent = commitsBegin(key);
      commitsPatch(key, { pending: true, error: null });
      try {
        const data = await api.getGitHostCommits(projectId, { branch: branch || undefined });
        if (!isCurrent()) return data;
        commitsPatch(key, { data: data.commits, pending: false, error: null });
        return data;
      } catch (err: any) {
        // Recorded against the scope that FAILED, so another branch neither
        // inherits this error nor waits behind this request's pending flag.
        if (isCurrent()) {
          commitsPatch(key, {
            pending: false,
            error: String(err?.message || err || 'Failed to load commits'),
          });
        }
        throw err;
      }
    },
    [projectId, commitsPatch, commitsBegin],
  );

  const loadPaths = useCallback(
    async (branch: any) => {
      const key = `${projectId}\u0000${branch || ''}`;
      const isCurrent = pathsBegin(key);
      pathsPatch(key, { pending: true, error: null });
      try {
        const data = await api.getGitHostPaths(projectId, { branch: branch || undefined });
        if (!isCurrent()) return;
        pathsPatch(key, { data: data?.paths || [], pending: false, error: null });
      } catch (err: any) {
        if (!isCurrent()) return;
        pathsPatch(key, {
          pending: false,
          error: String(err?.message || err || 'Failed to load paths'),
        });
      }
    },
    [projectId, pathsPatch, pathsBegin],
  );

  const loadReadme = useCallback(
    async (branch: any) => {
      const reqId = ++readmeReqRef.current;
      setReadme(null);
      try {
        const data = await api.getGitHostReadme(projectId, { branch: branch || undefined });
        if (readmeReqRef.current !== reqId) return;
        setReadme(data?.readme || null);
      } catch {
        if (readmeReqRef.current !== reqId) return;
        setReadme(null);
      }
    },
    [projectId],
  );

  const refresh = useCallback(
    async (branch?: any, path = '') => {
      const gen = ++refreshGenRef.current;
      const stillCurrentNav = beginNavigation();
      setLoading(true);
      setError(null);
      // A refresh re-reads the branch, so anything cached FOR that branch is
      // now suspect. The caches are keyed by project+branch, which does not
      // change on refresh, so History / Go to file would otherwise keep serving
      // pre-refresh data and skip re-fetching entirely.
      invalidateBranchCaches();
      // Started before anything that can fail. The clone URL is what a user
      // needs MOST when the repo is empty or the tree errors, so it must not
      // depend on a successful tree lookup.
      api
        .getGitHostStatus(projectId)
        .then((st: any) => {
          if (refreshGenRef.current === gen) setCloneUrl(st?.cloneUrl || null);
        })
        .catch(() => {
          if (refreshGenRef.current === gen) setCloneUrl(null);
        });
      try {
        const branches = await loadBranches();
        // A project switch (or a newer refresh) while loadBranches was in
        // flight makes everything below obsolete. Bail BEFORE touching state or
        // starting loadTree — a late loadTree would win a fresh generation and
        // clobber the current project's tree.
        if (refreshGenRef.current !== gen || !stillCurrentNav()) return;
        const target = branch || branches.defaultBranch || '';
        setSelectedBranch(target);
        // An unborn repository (initialized, never pushed to) has no branch ref
        // at all, so ls-tree fails and the tree endpoint 404s. That is an empty
        // repo, not an error: sending it down the error path hides codeBody and
        // with it the clone instructions the user needs to push a first commit.
        if (!target) {
          setIsEmptyRepo(true);
          return;
        }
        setIsEmptyRepo(false);
        try {
          await loadTree(target, path);
        } catch {
          // loadTree has already recorded treeError. Deliberately not rethrown:
          // the page-level error path hides codeBody, and with it the clone
          // menu, branch picker and Refresh. A tree that fails to load is a
          // tree-level problem, not a reason to make the repo unreachable.
        }
        if (refreshGenRef.current !== gen || !stillCurrentNav()) return;
        loadReadme(target);
      } catch (err: any) {
        if (refreshGenRef.current !== gen) return;
        setError(String(err?.message || err || 'Failed to load repository'));
      } finally {
        if (refreshGenRef.current === gen) setLoading(false);
      }
    },
    [loadBranches, loadTree, loadReadme, projectId, beginNavigation, invalidateBranchCaches],
  );

  useEffect(() => {
    // Mount-only: the wrapper remounts this component per project, so there is
    // no stale state to clear here and no reset list to keep in sync.
    refresh();
    const countGen = ++openPrCountReqRef.current;
    api
      .getProjectPulls(projectId, { state: 'open', limit: 100 })
      .then((d: any) => {
        if (openPrCountReqRef.current !== countGen) return;
        setOpenPrCount(Array.isArray(d?.pulls) ? d.pulls.length : null);
      })
      .catch(() => {
        if (openPrCountReqRef.current !== countGen) return;
        setOpenPrCount(null);
      });
    // On unmount every continuation is dead. React already makes their setState
    // calls no-ops, but a continuation can still FIRE A REQUEST (the delete
    // handler's loadBranches), so they have to be superseded explicitly.
    return () => {
      supersedeAllOperations();
    };
  }, [projectId, refresh, supersedeAllOperations]);

  const handleBranchChange = async (branch: any) => {
    setSelectedBranch(branch);
    setCommitSha(null);
    setFilePath(null);
    setDirPath('');
    setBranchMenuOpen(false);
    const stillCurrentNav = beginNavigation();
    loadReadme(branch);
    try {
      await loadTree(branch, '');
      // Selecting branch A then B: A's loadTree RESOLVES normally even though
      // its response was discarded, so a project-only check still passes here.
      // Without the nav check A would start loadCommits and overwrite B's
      // commits cache with an A-keyed one, blanking the history B is showing.
      if (!stillCurrentNav()) return;
      if (view === 'commits') {
        await loadCommits(branch);
      }
    } catch (err: any) {
      if (stillCurrentNav() && onToast) onToast(String(err?.message || err), 'error');
    }
  };

  const openDir = async (path: string) => {
    setDirPath(path);
    setFilePath(null);
    setView('code');
    const stillCurrentNav = beginNavigation();
    try {
      await loadTree(selectedBranch, path);
    } catch (err: any) {
      if (stillCurrentNav() && onToast) onToast(String(err?.message || err), 'error');
    }
  };

  const copyClone = async () => {
    if (!cloneUrl) return;
    try {
      await navigator.clipboard.writeText(cloneUrl);
      setCopiedClone(true);
      setTimeout(() => setCopiedClone(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  /**
   * Self-heal: whenever a view needs its scope's data and that data is absent,
   * load it. Absent covers never-fetched AND evicted, so an eviction can never
   * leave a blank view with no path back — the failure mode that recurred here.
   * `pending`/`error` make this converge: each is a terminal state the effect
   * will not re-enter until the scope changes.
   */
  useEffect(() => {
    if (view !== 'commits' || isEmptyRepo) return;
    if (commits !== null || commitsPending || commitsError) return;
    void loadCommits(selectedBranch).catch(() => {});
  }, [view, isEmptyRepo, commits, commitsPending, commitsError, selectedBranch, loadCommits]);

  useEffect(() => {
    if (!goToFileOpen || isEmptyRepo) return;
    if (allPaths !== null || pathsPending || pathsError) return;
    void loadPaths(selectedBranch);
  }, [goToFileOpen, isEmptyRepo, allPaths, pathsPending, pathsError, selectedBranch, loadPaths]);

  const openGoToFile = () => {
    setGoToFileOpen(true);
    setGoToQuery('');
    // Loading is owned by the self-heal effect, so the modal recovers whether
    // the scope was never fetched or was evicted while it was closed.
  };

  const filteredPaths = useMemo(() => {
    const q = goToQuery.trim().toLowerCase();
    const list = allPaths || [];
    if (!q) return list.slice(0, 50);
    return list.filter((p) => p.toLowerCase().includes(q)).slice(0, 50);
  }, [allPaths, goToQuery]);

  const filteredBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    const list = branchData?.branches || [];
    if (!q) return list;
    return list.filter((b: any) => b.name.toLowerCase().includes(q));
  }, [branchData, branchFilter]);

  const repoName = project?.name || projectId;
  /**
   * Only the tree fetched for exactly this project/branch/dir is rendered, so a
   * pending or failed navigation can never surface another location's rows.
   */
  const treeScopeKey = treeKeyFor(projectId, selectedBranch, dirPath);
  const activeTree =
    !treePending && treeState && treeState.key === treeScopeKey ? treeState.data : null;
  const entries = activeTree?.entries || [];

  const branchPicker = (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setBranchMenuOpen((o) => !o);
          setCodeMenuOpen(false);
        }}
        className="gh-btn font-mono"
        data-testid="repo-branch-select"
      >
        <GitBranch size={14} />
        {selectedBranch || 'branch'}
        <ChevronDown size={12} />
      </button>
      {branchMenuOpen && (
        <div className="absolute z-20 mt-1 w-72 rounded-xl border border-gh-border bg-gh-overlay shadow-xl">
          <div className="p-2 border-b border-gh-border">
            <input
              autoFocus
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              placeholder="Find a branch..."
              className="w-full bg-gh-inset border border-gh-border rounded-md px-2 py-1 text-sm text-gh-fg focus:outline-none focus:border-gh-accent"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filteredBranches.map((b: any) => (
              <button
                key={b.name}
                type="button"
                onClick={() => handleBranchChange(b.name)}
                className={`w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-gh-subtle ${
                  b.name === selectedBranch ? 'text-gh-fg font-semibold' : 'text-gh-muted'
                }`}
              >
                {b.name}
                {b.isDefault ? ' (default)' : ''}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setView('branches');
              setBranchMenuOpen(false);
            }}
            className="w-full text-left px-3 py-2 text-sm text-gh-accent border-t border-gh-border hover:bg-gh-subtle"
          >
            View all branches
          </button>
        </div>
      )}
    </div>
  );

  const codeBody = () => {
    if (isEmptyRepo) {
      return (
        <div className="space-y-4" data-testid="repo-empty">
          <div className="border border-gh-border rounded-xl bg-gh-canvas p-6 space-y-3">
            <h2 className="text-base font-semibold text-gh-fg">This repository is empty</h2>
            <p className="text-sm text-gh-muted">
              Nothing has been pushed yet. Clone it and push a first commit to get started.
            </p>
            <div className="space-y-1">
              <p className="text-[11px] text-gh-muted">HTTPS</p>
              <div className="flex items-center gap-1">
                <code
                  className="flex-1 text-[11px] bg-gh-inset border border-gh-border rounded-md px-2 py-1 truncate"
                  data-testid="repo-empty-clone-url"
                >
                  {cloneUrl || 'Clone URL unavailable'}
                </code>
                <button
                  type="button"
                  onClick={copyClone}
                  className="gh-btn px-2"
                  disabled={!cloneUrl}
                  aria-label="Copy clone URL"
                >
                  {copiedClone ? <Check size={12} /> : <Copy size={12} />}
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => refresh(undefined, '')}
            className="gh-btn"
            data-testid="repo-refresh"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      );
    }
    if (commitSha) {
      return (
        <CommitDetailView
          projectId={projectId}
          sha={commitSha}
          onBack={() => setCommitSha(null)}
          onOpenCommit={(sha: any) => setCommitSha(sha)}
        />
      );
    }
    if (filePath) {
      return (
        <FileBlobView
          projectId={projectId}
          branch={selectedBranch}
          filePath={filePath}
          onBack={() => setFilePath(null)}
        />
      );
    }
    if (view === 'commits') {
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">{branchPicker}</div>
          <div className="space-y-1.5" data-testid="repo-commit-list">
            {(commits || []).map((c: any) => (
              <button
                key={c.sha}
                type="button"
                onClick={() => setCommitSha(c.sha)}
                className="w-full flex items-center gap-3 px-3 py-2 text-left border-b border-gh-borderMuted hover:bg-gh-subtle"
                data-testid={`repo-commit-${shortSha(c.sha)}`}
              >
                <GitCommitHorizontal size={14} className="text-gh-muted flex-shrink-0" />
                <span
                  className="text-sm text-gh-accent font-semibold truncate flex-1"
                  title={c.subject}
                >
                  {c.subject}
                </span>
                <code className="text-[12px] text-gh-muted font-mono flex-shrink-0">
                  {shortSha(c.sha)}
                </code>
                <span className="text-xs text-gh-muted flex-shrink-0 hidden sm:inline">
                  {c.author}
                </span>
                <span className="text-xs text-gh-muted flex-shrink-0 tabular-nums">
                  {relativePrTime(c.date)}
                </span>
              </button>
            ))}
            {commitsPending && (
              <p className="text-sm text-gh-muted flex items-center gap-2 py-4">
                <Loader2 size={14} className="animate-spin" /> Loading history…
              </p>
            )}
            {!commitsPending && commitsError && (
              <div className="flex flex-col items-start gap-2 py-4">
                <p className="text-sm text-gh-danger" data-testid="repo-commits-error">
                  {commitsError}
                </p>
                <button
                  type="button"
                  // Fetch directly rather than clearing the error and leaving
                  // it to the self-heal effect: that effect only fires when the
                  // scope has NO data, so after a failed RELOAD of an already
                  // populated scope (switching back to a cached branch) it
                  // would decline and Retry would do nothing at all.
                  onClick={() => {
                    void loadCommits(selectedBranch).catch(() => {});
                  }}
                  className="gh-btn"
                  data-testid="repo-commits-retry"
                >
                  <RefreshCw size={14} />
                  Retry
                </button>
              </div>
            )}
            {!commitsPending && !commitsError && commits && commits.length === 0 && (
              <p className="text-sm text-gh-muted italic py-4">No commits on this branch yet.</p>
            )}
          </div>
        </div>
      );
    }
    if (view === 'branches' && branchData) {
      return (
        <div
          className="border border-gh-border rounded-xl overflow-hidden"
          data-testid="repo-branch-list"
        >
          {branchData.branches.map((b: any) => (
            <div
              key={b.name}
              className="flex items-center gap-3 px-3 py-2 border-b border-gh-borderMuted last:border-b-0"
            >
              <GitBranch size={14} className="text-gh-muted flex-shrink-0" />
              <button
                type="button"
                onClick={() => {
                  setView('code');
                  handleBranchChange(b.name);
                }}
                className="text-sm text-gh-accent hover:underline font-mono truncate"
                title={`Browse ${b.name}`}
              >
                {b.name}
              </button>
              {b.isDefault && (
                <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-gh-border text-gh-muted flex-shrink-0">
                  <Star size={10} /> default
                </span>
              )}
              {!b.isDefault && (b.ahead !== null || b.behind !== null) && (
                <span className="text-[10px] text-gh-muted tabular-nums flex-shrink-0">
                  {b.ahead ?? '?'} ahead · {b.behind ?? '?'} behind
                </span>
              )}
              <span className="text-xs text-gh-muted truncate flex-1 text-right" title={b.subject}>
                {b.subject}
              </span>
              <span className="text-xs text-gh-muted flex-shrink-0 tabular-nums">
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
                  className={`flex items-center gap-1 rounded flex-shrink-0 ${
                    confirmDeleteBranch === b.name
                      ? 'px-2 py-1 text-xs font-medium text-white bg-gh-danger'
                      : 'p-1 text-gh-muted hover:text-gh-danger'
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
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          {branchPicker}
          <button
            type="button"
            onClick={openGoToFile}
            className="gh-btn"
            data-testid="repo-go-to-file"
          >
            <Search size={14} />
            Go to file
          </button>
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => {
                setCodeMenuOpen((o) => !o);
                setBranchMenuOpen(false);
              }}
              className="gh-btn-primary gh-btn"
              data-testid="repo-code-menu"
            >
              <Code size={14} />
              Code
              <ChevronDown size={12} />
            </button>
            {codeMenuOpen && (
              <div className="absolute right-0 z-20 mt-1 w-80 rounded-xl border border-gh-border bg-gh-overlay shadow-xl p-3 space-y-2">
                <p className="text-xs font-semibold text-gh-fg">Clone</p>
                <p className="text-[11px] text-gh-muted">HTTPS</p>
                <div className="flex items-center gap-1">
                  <code className="flex-1 text-[11px] bg-gh-inset border border-gh-border rounded-md px-2 py-1 truncate">
                    {cloneUrl || 'Clone URL unavailable'}
                  </code>
                  <button
                    type="button"
                    onClick={copyClone}
                    className="gh-btn px-2"
                    disabled={!cloneUrl}
                  >
                    {copiedClone ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setView('commits');
              setFilePath(null);
              setCommitSha(null);
            }}
            className="gh-btn"
            data-testid="repo-commits-link"
          >
            <History size={14} />
            {activeTree?.commitCount != null ? `${activeTree.commitCount} Commits` : 'Commits'}
          </button>
          <button
            type="button"
            onClick={() => refresh(selectedBranch, dirPath)}
            className="gh-btn px-2"
            title="Refresh"
            data-testid="repo-refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <Breadcrumbs
          repoName={repoName}
          dirPath={dirPath}
          onOpenRoot={() => openDir('')}
          onOpenDir={openDir}
        />

        <div
          className="border border-gh-border rounded-xl overflow-hidden"
          data-testid="repo-file-tree"
        >
          {activeTree?.latestCommit && (
            <div className="flex items-center gap-2 px-3 py-2 bg-gh-subtle border-b border-gh-border text-sm">
              <span className="font-semibold text-gh-fg truncate">
                {activeTree.latestCommit.author}
              </span>
              <button
                type="button"
                onClick={() => setCommitSha(activeTree.latestCommit.sha)}
                className="text-gh-fg truncate hover:text-gh-accent hover:underline flex-1 text-left"
              >
                {activeTree.latestCommit.subject}
              </button>
              <code className="text-[12px] text-gh-muted font-mono">
                {shortSha(activeTree.latestCommit.sha)}
              </code>
              <span className="text-xs text-gh-muted tabular-nums">
                {relativePrTime(activeTree.latestCommit.date)}
              </span>
            </div>
          )}
          {dirPath ? (
            <button
              type="button"
              onClick={() => openDir(dirPath.split('/').slice(0, -1).join('/'))}
              className="w-full flex items-center gap-3 px-3 py-2 text-left border-b border-gh-borderMuted hover:bg-gh-subtle text-sm text-gh-accent"
            >
              <span className="w-4" />
              ..
            </button>
          ) : null}
          {entries.map((e: any) => (
            <button
              key={e.path}
              type="button"
              // A submodule is a gitlink: there is no tree to browse and no
              // blob to read on this side, so it is inert rather than a click
              // that would 404.
              disabled={e.type === 'commit'}
              onClick={() => {
                if (e.type === 'commit') return;
                if (e.type === 'tree') openDir(e.path);
                else setFilePath(e.path);
              }}
              title={e.type === 'commit' ? `${e.name} is a submodule` : undefined}
              className={`w-full flex items-center gap-3 px-3 py-[6px] text-left border-b border-gh-borderMuted last:border-b-0 ${
                e.type === 'commit' ? 'cursor-default' : 'hover:bg-gh-subtle'
              }`}
              data-testid={`repo-entry-${e.path}`}
            >
              {e.type === 'tree' ? (
                <Folder size={16} className="text-sky-400/80 flex-shrink-0" />
              ) : e.type === 'commit' ? (
                <FolderGit2 size={16} className="text-amber-400/80 flex-shrink-0" />
              ) : (
                <File size={16} className="text-gray-500 flex-shrink-0" />
              )}
              <span
                className={`text-sm truncate w-[30%] min-w-[8rem] ${
                  e.type === 'tree' ? 'text-gray-100 font-medium' : 'text-gray-200'
                }`}
              >
                {e.name}
                {e.type === 'commit' && (
                  <span
                    className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-400/80"
                    data-testid={`repo-submodule-${e.path}`}
                  >
                    submodule
                  </span>
                )}
              </span>
              <span className="text-sm text-gh-muted truncate flex-1">
                {e.lastCommit?.subject || ''}
              </span>
              <span className="text-xs text-gh-muted tabular-nums flex-shrink-0">
                {e.lastCommit?.date ? relativePrTime(e.lastCommit.date) : ''}
              </span>
            </button>
          ))}
          {treePending && (
            <p className="text-sm text-gh-muted flex items-center gap-2 px-3 py-4">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </p>
          )}
          {!treePending && treeError && (
            <div className="flex flex-col items-start gap-2 px-3 py-4">
              <p className="text-sm text-gh-danger" data-testid="repo-tree-error">
                {treeError}
              </p>
              {/* Direct action, like the other two error surfaces: recovery
                  must not depend on some other effect's precondition. */}
              <button
                type="button"
                onClick={() => {
                  void loadTree(selectedBranch, dirPath).catch(() => {});
                }}
                className="gh-btn"
                data-testid="repo-tree-retry"
              >
                <RefreshCw size={14} />
                Retry
              </button>
            </div>
          )}
          {!treePending && !treeError && entries.length === 0 && (
            <p className="text-sm text-gh-muted italic px-3 py-4">This directory is empty.</p>
          )}
        </div>

        {!dirPath && <ReadmeCard readme={readme} projectId={projectId} />}
      </div>
    );
  };

  /**
   * The Code tab is the way back to the file tree from History / Branches /
   * a blob / a commit. Without it GitHubRepoChrome renders Code disabled and
   * those views have no direct exit.
   */
  const showCodeTree = () => {
    setView('code');
    setFilePath(null);
    setCommitSha(null);
    setGoToFileOpen(false);
    setBranchMenuOpen(false);
  };

  return (
    <GitHubRepoChrome
      project={project}
      projectId={projectId}
      active="code"
      openPrCount={openPrCount}
      onOpenCode={showCodeTree}
      onOpenPulls={onOpenPulls}
    >
      <GitHostMirrorStatusBanner projectId={projectId} onToast={onToast} />

      {loading && (
        <p className="text-sm text-gh-muted flex items-center gap-2 py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> Loading repository…
        </p>
      )}
      {error && !loading && (
        <div className="py-4 flex flex-col items-start gap-3" data-testid="repo-error">
          <p className="text-sm text-gh-danger">
            {error.includes('not hosted')
              ? 'This project is not hosted on Agent Hub. Enable Git hosting in Project settings.'
              : error}
          </p>
          {/* codeBody() — which owns the Refresh button — is suppressed while
              `error` is set, so without this the page is a dead end after a
              transient failure until the user navigates away and remounts. */}
          <button
            type="button"
            onClick={() => refresh(selectedBranch || undefined, dirPath)}
            className="gh-btn"
            data-testid="repo-error-retry"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      )}
      {!loading && !error && codeBody()}

      {goToFileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 flex items-start justify-center pt-[15vh]"
          onClick={() => setGoToFileOpen(false)}
        >
          <div
            className="w-full max-w-xl rounded-xl border border-gh-border bg-gh-overlay shadow-xl"
            onClick={(e) => e.stopPropagation()}
            data-testid="repo-go-to-file-modal"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gh-border">
              <Search size={14} className="text-gh-muted" />
              <input
                autoFocus
                value={goToQuery}
                onChange={(e) => setGoToQuery(e.target.value)}
                placeholder="Go to file"
                className="flex-1 bg-transparent text-sm text-gh-fg focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setGoToFileOpen(false)}
                className="text-gh-muted"
                aria-label="Close go to file"
                data-testid="repo-go-to-file-close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {allPaths === null && !pathsError && (
                <p className="px-3 py-3 text-sm text-gh-muted flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Loading paths…
                </p>
              )}
              {allPaths === null && pathsError && (
                <div className="px-3 py-3 flex flex-col items-start gap-2">
                  <p className="text-sm text-gh-danger" data-testid="repo-paths-error">
                    {pathsError}
                  </p>
                  <button
                    type="button"
                    // Same reasoning as the History retry above: fetch
                    // directly, so a populated-but-failed scope still retries.
                    onClick={() => {
                      void loadPaths(selectedBranch);
                    }}
                    className="gh-btn"
                    data-testid="repo-paths-retry"
                  >
                    <RefreshCw size={14} />
                    Retry
                  </button>
                </div>
              )}
              {filteredPaths.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setGoToFileOpen(false);
                    setFilePath(p);
                    setView('code');
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm font-mono text-gh-fg hover:bg-gh-subtle truncate"
                >
                  {p}
                </button>
              ))}
              {allPaths && filteredPaths.length === 0 && (
                <p className="px-3 py-3 text-sm text-gh-muted">No matching files.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </GitHubRepoChrome>
  );
}
