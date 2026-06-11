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
import { api } from '../utils/api.js';

/** Default-branch picker — moves the hosted repo's HEAD symref. */
function DefaultBranchSelector({ project, status, onChanged, showToast }) {
  const [branches, setBranches] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    try {
      api
        .getGitHostBranches(project.id)
        .then((d) => alive && setBranches((d.branches || []).map((b) => b.name)))
        .catch(() => alive && setBranches([]));
    } catch {
      setBranches([]);
    }
    return () => {
      alive = false;
    };
  }, [project.id, status.defaultBranch]);

  const current = status.defaultBranch || '';
  const onPick = async (branch) => {
    if (!branch || branch === current || saving) return;
    setSaving(true);
    try {
      await api.setGitHostDefaultBranch(project.id, branch);
      if (showToast) showToast(`Default branch is now ${branch}.`, 'success');
      onChanged();
    } catch (err) {
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
        onChange={(e) => onPick(e.target.value)}
        disabled={saving || branches === null}
        data-testid={`default-branch-select-${project.id}`}
        className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-600 disabled:opacity-50 max-w-[45%]"
      >
        {current && <option value={current}>{current}</option>}
        {(branches || [])
          .filter((b) => b !== current)
          .map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
      </select>
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

export default function GitHostSettingsSection({ project, showToast, onProjectsChange }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [protection, setProtection] = useState(project.branchProtection || {});
  const [savingProtection, setSavingProtection] = useState(null);
  const [deleteOnMerge, setDeleteOnMerge] = useState(project.deleteBranchOnMerge !== false);
  const [savingDeleteOnMerge, setSavingDeleteOnMerge] = useState(false);
  const pollRef = useRef(null);

  const toggleDeleteOnMerge = async () => {
    const next = !deleteOnMerge;
    setDeleteOnMerge(next);
    setSavingDeleteOnMerge(true);
    try {
      await api.updateProject(project.id, { deleteBranchOnMerge: next });
      if (onProjectsChange) onProjectsChange();
    } catch (err) {
      setDeleteOnMerge(!next); // revert optimistic flip
      if (showToast) showToast(`Failed to save: ${err.message}`, 'error');
    } finally {
      setSavingDeleteOnMerge(false);
    }
  };

  const toggleProtection = async (key) => {
    const next = { ...protection, [key]: !protection[key] };
    setProtection(next);
    setSavingProtection(key);
    try {
      await api.updateProject(project.id, { branchProtection: { [key]: !protection[key] } });
      if (onProjectsChange) onProjectsChange();
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
        <div className="pt-2 space-y-2" data-testid={`project-branch-protection-${project.id}`}>
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Branch protection{status.defaultBranch ? ` — ${status.defaultBranch}` : ''}
          </span>
          {PROTECTION_OPTIONS.map((opt) => (
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
