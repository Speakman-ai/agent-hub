import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { getAuthHeaders, getApiBase } from '../utils/connection';

interface GithubStatus {
  connected: boolean;
  login: string | null;
}

/**
 * Project toggle: author session commits as the session owner's GitHub
 * account instead of Agent Hub. The hint under the toggle reflects the
 * signed-in user's own GitHub connection, since that is the identity their
 * sessions will commit as.
 */
export default function CommitIdentitySection({ project, showToast, onProjectsChange }: any) {
  const enabled = project.commitAsOwner?.enabled === true;
  const [saving, setSaving] = useState(false);
  const [github, setGithub] = useState<GithubStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${getApiBase()}/auth/github/status`, { headers: getAuthHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setGithub({ connected: !!body.connected, login: body.login });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async () => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { commitAsOwner: { enabled: !enabled } });
      onProjectsChange?.();
    } catch (err: any) {
      const msg = String(err?.message || err || 'Failed to update');
      if (showToast) showToast(msg, 'error');
      else alert(msg);
    } finally {
      setSaving(false);
    }
  };

  let hint: string | null = null;
  if (github?.connected && github.login) {
    hint = `Your sessions will commit as @${github.login}.`;
  } else if (github && !github.connected) {
    hint =
      'You have not connected GitHub, so your sessions keep the Agent Hub identity. Connect it under Settings → GitHub.';
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-gray-200">Commit as my GitHub account</span>
        <p className="text-xs text-gray-500">
          Author session commits as the session owner&apos;s connected GitHub account (username and
          GitHub noreply email) instead of Agent Hub. Off by default.
        </p>
        {enabled && hint && (
          <p
            className="text-xs text-gray-400 mt-1"
            data-testid={`project-commit-as-owner-hint-${project.id}`}
          >
            {hint}
          </p>
        )}
      </div>
      <button
        onClick={toggle}
        disabled={saving}
        data-testid={`project-commit-as-owner-${project.id}`}
        aria-pressed={enabled}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${
          enabled ? 'bg-emerald-600' : 'bg-gray-600'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}
