import { useEffect, useState } from 'react';
import { PRE_PUSH_HOOK_EXAMPLE } from '@shared/utils/prePushHookExample';
import { api } from '../utils/api';

/**
 * Project setting: a shell command Finalize runs right before it pushes to
 * GitHub. Only shown for GitHub-backed projects; the server refuses changes
 * from anyone below Admin.
 */
export default function PrePushHookSection({ project, showToast, onProjectsChange }: any) {
  const stored = project.prePushHook ?? {};
  const enabled = stored.enabled === true;
  const [command, setCommand] = useState<string>(stored.command ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCommand(project.prePushHook?.command ?? '');
  }, [project.id, project.prePushHook?.command]);

  if (project.gitHost === 'agenthub') return null;

  const save = async (patch: { enabled?: boolean; command?: string }) => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { prePushHook: patch });
      onProjectsChange?.();
      if (patch.command !== undefined) showToast?.('Pre-push hook saved', 'success');
    } catch (err: any) {
      const msg = String(err?.message || err || 'Failed to update');
      if (showToast) showToast(msg, 'error');
      else alert(msg);
    } finally {
      setSaving(false);
    }
  };

  const dirty = command !== (stored.command ?? '');

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <span className="text-sm text-gray-200">Pre-push hook</span>
          <p className="text-xs text-gray-500">
            Shell command Finalize runs in the checkout right before it pushes to GitHub, with the
            push&apos;s GitHub token. It can rename the branch (Finalize pushes the new name) or add
            text to the PR body by writing to <code>$AGENT_HUB_PR_BODY_APPEND</code>. A non-zero
            exit stops the push. Requires the <strong>Admin</strong> role.
          </p>
        </div>
        <button
          onClick={() => save({ enabled: !enabled })}
          disabled={saving}
          data-testid={`project-pre-push-hook-enabled-${project.id}`}
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
      {enabled && (
        <div className="space-y-2">
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={PRE_PUSH_HOOK_EXAMPLE}
            rows={8}
            spellCheck={false}
            data-testid={`project-pre-push-hook-command-${project.id}`}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 focus:outline-none focus:border-gray-500"
          />
          <p className="text-xs text-gray-500">
            Also available: <code>AGENT_HUB_BRANCH</code>, <code>AGENT_HUB_BASE_BRANCH</code>,{' '}
            <code>AGENT_HUB_HEAD_SHA</code>, <code>AGENT_HUB_CARD_TITLE</code>,{' '}
            <code>AGENT_HUB_GITHUB_REPO</code>, <code>AGENT_HUB_EXISTING_PR_URL</code> (set when the
            branch already has an open PR). The hook must not commit.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => save({ command })}
              disabled={saving || !dirty}
              data-testid={`project-pre-push-hook-save-${project.id}`}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs px-3 py-1.5 rounded-lg"
            >
              Save hook
            </button>
            {!command && (
              <button
                onClick={() => setCommand(PRE_PUSH_HOOK_EXAMPLE)}
                className="bg-gray-700 hover:bg-gray-600 text-white text-xs px-3 py-1.5 rounded-lg"
              >
                Use issue + branch example
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
