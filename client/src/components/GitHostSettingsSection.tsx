/**
 * GitHostSettingsSection — per-project "Git hosting" block rendered inside
 * the Projects settings expander (SettingsPage → projectSettingsBody).
 *
 * Surfaces the Agent Hub-hosted git feature (Project.gitHost): a toggle to
 * enable/disable hosting, the clone URL once enabled, background-import
 * progress, and GitHub mirror state. The enable/disable transitions go
 * through the dedicated endpoints (NOT the projects PATCH) because they
 * have filesystem side effects — bare repo creation/import and rewriting
 * the project cwd's origin.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, Copy, Check, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';

/** Default-branch picker — moves the hosted repo's HEAD symref. */
function DefaultBranchSelector({ project, status, onChanged, showToast }: any) {
  const [branches, setBranches] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      api
        .getGitHostBranches(project.id)
        .then((d: any) => alive && setBranches((d.branches || []).map((b: any) => b.name)))
        .catch(() => alive && setBranches([]));
    } catch {
      setBranches([]);
    }
    return () => {
      alive = false;
    };
  }, [project.id, status.defaultBranch]);

  const current = status.defaultBranch || '';
  const onPick = async (branch: any) => {
    if (!branch || branch === current || saving) return;
    setSaving(true);
    try {
      await api.setGitHostDefaultBranch(project.id, branch);
      if (showToast) showToast(`Default branch is now ${branch}.`, 'success');
      onChanged();
    } catch (err: any) {
      if (showToast) showToast(`Failed to set default branch: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-gray-200">Default branch</span>
        <p className="text-xs text-gray-500">
          New clones check this out; pull requests, mirroring, CI on push, and branch protection all
          key off it.
        </p>
      </div>
      <select
        value={current}
        onChange={(e: any) => onPick(e.target.value)}
        disabled={saving || branches === null}
        data-testid={`default-branch-select-${project.id}`}
        className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600 disabled:opacity-50 max-w-[45%]"
      >
        {current && <option value={current}>{current}</option>}
        {(branches || [])
          .filter((b: any) => b !== current)
          .map((b: any) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
      </select>
    </div>
  );
}

/**
 * GitHub mirror target — link an existing repo or create a fresh one.
 *
 * A project born on the Hub forge has no `repoUrl`, so mirroring is off
 * with nothing in the UI to turn it on. This panel is that missing step:
 * once a target is linked the server enables mirroring and seeds the
 * first push.
 */
function MirrorTargetPanel({ project, status, onChanged, showToast }: any) {
  const linked = status.mirror?.githubRepo || null;
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [repo, setRepo] = useState('');
  const [owner, setOwner] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [owners, setOwners] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [savingMirror, setSavingMirror] = useState(false);

  // Owner list only matters for the create path — fetch it on demand.
  useEffect(() => {
    if (linked || mode !== 'create' || owners !== null) return;
    let alive = true;
    api
      .getGitHostMirrorOwners(project.id)
      .then((d: any) => {
        if (!alive) return;
        setOwners(d);
        if (!owner && d?.owners?.length) setOwner(d.owners[0].login);
      })
      .catch(() => alive && setOwners({ connected: false, owners: [] }));
    return () => {
      alive = false;
    };
  }, [linked, mode, owners, owner, project.id]);

  const submit = async () => {
    if (!repo.trim() || busy) return;
    setBusy(true);
    try {
      const res = await api.linkGitHostMirror(project.id, {
        mode,
        repo: repo.trim(),
        ...(mode === 'create' ? { owner: owner || undefined, private: isPrivate } : {}),
      });
      setRepo('');
      if (showToast)
        showToast(
          res.created
            ? `Created ${res.githubRepo} on GitHub and started mirroring.`
            : `Mirroring to ${res.githubRepo}.`,
          'success',
        );
      onChanged();
    } catch (err: any) {
      if (showToast) showToast(err?.message || 'Failed to link the GitHub repository', 'error');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      await api.unlinkGitHostMirror(project.id);
      if (showToast)
        showToast('GitHub mirror unlinked — the repo on GitHub was left alone.', 'success');
      onChanged();
    } catch (err: any) {
      if (showToast) showToast(err?.message || 'Failed to unlink the mirror', 'error');
    } finally {
      setBusy(false);
    }
  };

  const patchMirror = async (patch: any) => {
    setSavingMirror(true);
    try {
      await api.updateProject(project.id, { gitMirror: patch });
      onChanged();
    } catch (err: any) {
      if (showToast) showToast(err?.message || 'Failed to save mirror settings', 'error');
    } finally {
      setSavingMirror(false);
    }
  };

  return (
    <div className="pt-2 space-y-2" data-testid={`project-mirror-target-${project.id}`}>
      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        GitHub mirror
      </span>

      {linked ? (
        <>
          <div className="flex items-center gap-2">
            <a
              href={`https://github.com/${linked}`}
              target="_blank"
              rel="noreferrer"
              className="flex-1 min-w-0 truncate text-sm text-blue-400 hover:text-blue-300"
              data-testid={`project-mirror-repo-${project.id}`}
            >
              {linked}
            </a>
            <button
              onClick={unlink}
              disabled={busy}
              data-testid={`project-mirror-unlink-${project.id}`}
              className="px-2 py-1 rounded-lg border border-gray-700 text-xs text-gray-400 hover:text-red-300 hover:border-red-700 transition-colors disabled:opacity-50"
            >
              Unlink
            </button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <span className="text-sm text-gray-200">Mirror pushes to GitHub</span>
              <p className="text-xs text-gray-500">
                Pushes and PR merges on the Hub are replayed to GitHub so Actions and deploys keep
                running.
              </p>
            </div>
            <button
              onClick={() => patchMirror({ enabled: !status.mirror?.enabled })}
              disabled={savingMirror}
              data-testid={`project-mirror-enabled-${project.id}`}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
                status.mirror?.enabled ? 'bg-emerald-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  status.mirror?.enabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-200 flex-1 min-w-0">Mirrored refs</span>
            <select
              value={status.mirror?.refs || 'default-branch'}
              onChange={(e: any) => patchMirror({ refs: e.target.value })}
              disabled={savingMirror}
              data-testid={`project-mirror-refs-${project.id}`}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600 disabled:opacity-50"
            >
              <option value="default-branch">Default branch + tags</option>
              <option value="all">All branches + tags</option>
            </select>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-gray-500">
            Optional. Link a GitHub repository to keep a copy of this project there — or create a
            new one on your account without leaving Agent Hub.
          </p>
          <div className="flex gap-1">
            {[
              { key: 'existing', label: 'Link existing' },
              { key: 'create', label: 'Create new repo' },
            ].map((opt: any) => (
              <button
                key={opt.key}
                onClick={() => setMode(opt.key)}
                data-testid={`project-mirror-mode-${opt.key}-${project.id}`}
                className={`px-2 py-1 rounded-lg text-xs border transition-colors ${
                  mode === opt.key
                    ? 'border-blue-600 text-blue-300 bg-blue-950/40'
                    : 'border-gray-700 text-gray-400 hover:text-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {mode === 'create' && owners && !owners.connected && (
            <p className="text-xs text-amber-300 flex items-center gap-1.5">
              <AlertTriangle size={12} />
              Connect your GitHub account in Settings → GitHub first.
            </p>
          )}

          <div className="flex items-center gap-2">
            {mode === 'create' && owners?.owners?.length > 0 && (
              <select
                value={owner}
                onChange={(e: any) => setOwner(e.target.value)}
                data-testid={`project-mirror-owner-${project.id}`}
                className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600 max-w-[40%]"
              >
                {owners.owners.map((o: any) => (
                  <option key={o.login} value={o.login}>
                    {o.login}
                  </option>
                ))}
              </select>
            )}
            <input
              value={repo}
              onChange={(e: any) => setRepo(e.target.value)}
              placeholder={mode === 'create' ? project.id : 'owner/repo or GitHub URL'}
              data-testid={`project-mirror-repo-input-${project.id}`}
              className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600"
            />
            <button
              onClick={submit}
              disabled={busy || !repo.trim()}
              data-testid={`project-mirror-submit-${project.id}`}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm text-white transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : mode === 'create' ? (
                'Create'
              ) : (
                'Link'
              )}
            </button>
          </div>

          {mode === 'create' && (
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e: any) => setIsPrivate(e.target.checked)}
                data-testid={`project-mirror-private-${project.id}`}
                className="accent-blue-600"
              />
              Private repository
            </label>
          )}
        </>
      )}
    </div>
  );
}

const PROTECTION_OPTIONS = [
  {
    key: 'requiredChecks',
    label: 'Require passing checks',
    hint: 'PRs into the default branch merge only when the head commit is Finalize-validated or its CI run succeeded.',
  },
  {
    key: 'requiredReview',
    label: 'Require an approving review',
    hint: 'An approving human review (or Finalize validation, which includes the in-hub reviewer) is required; changes-requested blocks merging.',
  },
  {
    key: 'blockDirectPushes',
    label: 'Block direct pushes to the default branch',
    hint: 'The default branch only moves via PR merges — git pushes to it are rejected at the repo.',
  },
];

export default function GitHostSettingsSection({ project, showToast, onProjectsChange }: any) {
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [protection, setProtection] = useState(project.branchProtection || {});
  const [savingProtection, setSavingProtection] = useState<any>(null);
  const [deleteOnMerge, setDeleteOnMerge] = useState(project.deleteBranchOnMerge !== false);
  const [savingDeleteOnMerge, setSavingDeleteOnMerge] = useState(false);
  const pollRef = useRef<any>(null);

  const toggleDeleteOnMerge = async () => {
    const next = !deleteOnMerge;
    setDeleteOnMerge(next);
    setSavingDeleteOnMerge(true);
    try {
      await api.updateProject(project.id, { deleteBranchOnMerge: next });
      if (onProjectsChange) onProjectsChange();
    } catch (err: any) {
      setDeleteOnMerge(!next); // revert optimistic flip
      if (showToast) showToast(`Failed to save: ${err.message}`, 'error');
    } finally {
      setSavingDeleteOnMerge(false);
    }
  };

  const toggleProtection = async (key: any) => {
    const next = { ...protection, [key]: !protection[key] };
    setProtection(next);
    setSavingProtection(key);
    try {
      await api.updateProject(project.id, { branchProtection: { [key]: !protection[key] } });
      if (onProjectsChange) onProjectsChange();
    } catch (err: any) {
      setProtection(protection); // revert optimistic flip
      if (showToast) showToast(`Failed to save: ${err.message}`, 'error');
    } finally {
      setSavingProtection(null);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const s = await api.getGitHostStatus(project.id);
      setStatus(s);
      return s;
    } catch {
      // Older server without the endpoint, or transient failure — hide the
      // controls rather than rendering a broken section.
      setStatus(null);
      return null;
    }
  }, [project.id]);

  useEffect(() => {
    refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // While an import runs in the background, poll until it settles.
  const startImportPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const s = await refresh();
      const st = s?.importState?.status;
      if (st && st !== 'importing') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        if (st === 'ready') {
          // gitHost flipped on the project record — refresh so the
          // sidebar's "Repository" entry appears without a reload.
          if (onProjectsChange) onProjectsChange();
          if (showToast) showToast('Agent Hub git hosting enabled', 'success');
        } else if (st === 'error' && showToast) {
          showToast(
            `Git hosting import failed: ${s.importState.error || 'unknown error'}`,
            'error',
          );
        }
      }
    }, 1500);
  }, [refresh, showToast, onProjectsChange]);

  const handleEnable = async () => {
    setBusy(true);
    try {
      await api.enableGitHost(project.id);
      await refresh();
      startImportPolling();
    } catch (err: any) {
      const msg = String(err?.message || err || 'Failed to enable git hosting');
      if (showToast) showToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      await api.disableGitHost(project.id);
      await refresh();
      if (onProjectsChange) onProjectsChange();
      if (showToast) showToast('Git hosting disabled — origin restored to GitHub', 'success');
    } catch (err: any) {
      const msg = String(err?.message || err || 'Failed to disable git hosting');
      if (showToast) showToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyCloneUrl = async () => {
    if (!status?.cloneUrl) return;
    try {
      await navigator.clipboard.writeText(status.cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (http origin) — the URL is selectable text */
    }
  };

  if (!status) return null;

  const importing = status.importState?.status === 'importing';
  const importError = status.importState?.status === 'error' ? status.importState.error : null;

  return (
    <div className="space-y-2" data-testid={`project-git-host-${project.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <span className="text-sm text-gray-200 flex items-center gap-1.5">
            <GitBranch size={14} className="text-gray-400" />
            Git hosting
          </span>
          <p className="text-xs text-gray-500">
            Host this project&apos;s repository on Agent Hub. Sessions push here and pull requests
            are managed in-app; when a GitHub repo is linked, merges to the default branch are
            mirrored to GitHub so Actions and deploys keep working.
          </p>
        </div>
        <button
          onClick={status.enabled ? handleDisable : handleEnable}
          disabled={busy || importing}
          data-testid={`project-git-host-toggle-${project.id}`}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
            status.enabled ? 'bg-emerald-600' : 'bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              status.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {importing && (
        <p className="text-xs text-amber-300 flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" />
          Importing repository into Agent Hub…
        </p>
      )}
      {importError && (
        <p className="text-xs text-red-400 flex items-center gap-1.5">
          <AlertTriangle size={12} />
          Import failed: {importError}
        </p>
      )}

      {status.enabled && status.cloneUrl && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <code
              className="flex-1 min-w-0 truncate bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 font-mono"
              title={status.cloneUrl}
              data-testid={`project-git-host-clone-url-${project.id}`}
            >
              {status.cloneUrl}
            </code>
            <button
              onClick={copyCloneUrl}
              className="p-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors flex-shrink-0"
              title="Copy clone URL"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>
          </div>
          <p className="text-xs text-gray-600">
            Authenticate with your username and your login password (or an API key from Settings →
            API Keys) as the password.
            {status.defaultBranch ? ` Default branch: ${status.defaultBranch}.` : ''}
            {status.mirror?.enabled
              ? ` Mirroring ${status.mirror.refs === 'all' ? 'all branches' : 'the default branch'} to GitHub.`
              : ' GitHub mirroring is off (no repo linked or disabled).'}
          </p>
        </div>
      )}

      {status.enabled && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex-1 min-w-0">
            <span className="text-sm text-gray-200">Delete branches on merge</span>
            <p className="text-xs text-gray-500">
              Automatically delete a pull request&apos;s head branch after it merges (GitHub-style).
              Recommended — agent session branches accumulate quickly.
            </p>
          </div>
          <button
            onClick={toggleDeleteOnMerge}
            disabled={savingDeleteOnMerge}
            data-testid={`delete-branch-on-merge-${project.id}`}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
              deleteOnMerge ? 'bg-emerald-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                deleteOnMerge ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      )}

      {status.enabled && (
        <DefaultBranchSelector
          project={project}
          status={status}
          onChanged={refresh}
          showToast={showToast}
        />
      )}

      {status.enabled && (
        <MirrorTargetPanel
          project={project}
          status={status}
          onChanged={() => {
            refresh();
            if (onProjectsChange) onProjectsChange();
          }}
          showToast={showToast}
        />
      )}

      {status.enabled && (
        <div className="pt-2 space-y-2" data-testid={`project-branch-protection-${project.id}`}>
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Branch protection{status.defaultBranch ? ` — ${status.defaultBranch}` : ''}
          </span>
          {PROTECTION_OPTIONS.map((opt: any) => (
            <div key={opt.key} className="flex items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-gray-200">{opt.label}</span>
                <p className="text-xs text-gray-500">{opt.hint}</p>
              </div>
              <button
                onClick={() => toggleProtection(opt.key)}
                disabled={savingProtection !== null}
                data-testid={`branch-protection-${opt.key}-${project.id}`}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
                  protection[opt.key] ? 'bg-emerald-600' : 'bg-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    protection[opt.key] ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
