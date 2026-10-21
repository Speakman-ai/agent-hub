import { useEffect, useReducer, type ReactNode } from 'react';
import { ArrowLeft, Bot, Settings } from 'lucide-react';
import { SERVER_AGENT_LIMITS } from '@shared/utils/hub';
import {
  initialServerAgentDraft,
  nextServerAgentSave,
  serverAgentDraftReducer,
} from '@shared/utils/serverAgentDraft';
import {
  DEFAULT_SERVER_AGENT_NAME,
  saveServerAgentSettings,
  serverAgentDisplayName,
  useServerAgentAccountKey,
  useServerAgentLoadError,
  useServerAgentSettings,
} from '../utils/serverAgentSettings';

/**
 * The Server Agent: the user's assistant for everything Agent Hub. It acts
 * with the user's own permissions, so it only sees projects they can access.
 */
export function ServerAgentPage({
  children,
  onOpenSettings,
}: {
  /** The transcript and composer for the user's Server Agent session. */
  children: ReactNode;
  onOpenSettings: () => void;
}) {
  const settings = useServerAgentSettings();
  const name = serverAgentDisplayName(settings);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="server-agent-page">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-4 py-2">
        <Bot size={16} className="shrink-0 text-cyan-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white" data-testid="server-agent-name">
            {name}
          </div>
          <div className="truncate text-[11px] text-gray-500">
            Works across the projects you can access, with your permissions
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          data-testid="server-agent-open-settings"
          title="Server Agent settings"
          aria-label="Server Agent settings"
          className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white"
        >
          <Settings size={16} />
        </button>
      </div>
      {children}
    </div>
  );
}

export function ServerAgentSettingsPage({ onBack }: { onBack: () => void }) {
  const accountKey = useServerAgentAccountKey();
  const settings = useServerAgentSettings();
  const { error: loadError, retry: retryLoad } = useServerAgentLoadError();
  const [draft, dispatch] = useReducer(serverAgentDraftReducer, initialServerAgentDraft);
  // Only the account the draft was loaded for may see or save it.
  const loaded = draft.owner !== null && draft.owner === accountKey;
  const name = loaded ? draft.name : '';
  const instructions = loaded ? draft.instructions : '';
  const saving = loaded && draft.pending !== null;
  const status = loaded ? draft.status : null;

  useEffect(() => {
    if (draft.owner !== null && draft.owner !== accountKey) dispatch({ type: 'clear' });
    else if (draft.owner === null && settings) {
      dispatch({ type: 'load', owner: accountKey, settings });
    }
  }, [settings, accountKey, draft.owner]);

  const dirty =
    loaded && !!settings && (name !== settings.name || instructions !== settings.instructions);

  const save = async () => {
    const next = loaded ? nextServerAgentSave(draft) : null;
    if (!next) return;
    dispatch({ type: 'saveStart' });
    try {
      const saved = await saveServerAgentSettings(next.owner, {
        name: next.name,
        instructions: next.instructions,
      });
      dispatch({ type: 'saveDone', seq: next.seq, owner: next.owner, saved });
    } catch (err) {
      dispatch({
        type: 'saveFailed',
        seq: next.seq,
        owner: next.owner,
        message: err instanceof Error ? err.message : 'Could not save settings.',
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="server-agent-settings">
      <div className="flex shrink-0 items-center gap-2 border-b border-gray-800 px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="server-agent-settings-back"
          aria-label="Back to Server Agent"
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="truncate text-sm font-medium text-white">
          {serverAgentDisplayName(settings)} settings
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-4">
          {!loaded && loadError && (
            <div
              role="alert"
              data-testid="server-agent-settings-load-error"
              className="flex items-center gap-3 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300"
            >
              <span className="min-w-0 flex-1">Could not load your settings: {loadError}</span>
              <button
                type="button"
                onClick={retryLoad}
                data-testid="server-agent-settings-retry"
                className="shrink-0 rounded-lg border border-red-800 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-900/50"
              >
                Retry
              </button>
            </div>
          )}
          <label className="block">
            <span className="text-sm font-medium text-gray-200">Name</span>
            <input
              type="text"
              value={name}
              maxLength={SERVER_AGENT_LIMITS.name}
              placeholder={settings?.defaultName || DEFAULT_SERVER_AGENT_NAME}
              onChange={(e) => dispatch({ type: 'edit', field: 'name', value: e.target.value })}
              disabled={!loaded}
              data-testid="server-agent-settings-name"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-gray-500">
              Shown in the sidebar and used by the agent to refer to itself. Leave empty for the
              default.
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-200">Instructions</span>
            <textarea
              value={instructions}
              maxLength={SERVER_AGENT_LIMITS.instructions}
              rows={12}
              placeholder="e.g. Keep answers short. Start every day by listing my assigned cards."
              onChange={(e) =>
                dispatch({ type: 'edit', field: 'instructions', value: e.target.value })
              }
              disabled={!loaded}
              data-testid="server-agent-settings-instructions"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-gray-500">
              Added to the agent&apos;s built-in prompt on every message. The Agent Hub skills
              always load, and the agent always acts with your own permissions: it only sees
              projects you can access.
            </span>
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              data-testid="server-agent-settings-save"
              className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {status && (
              <span
                role="status"
                data-testid="server-agent-settings-status"
                className={`text-xs ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {status.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
