import { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import {
  computerToolErrorMessage,
  computerToolResetLabel,
  computerToolSourceLabel,
} from '@shared/utils/computerTool';
import {
  organizationComputerOwnerLabel,
  organizationComputerStatus,
  type DesktopRuntimeInfo,
} from '@shared/utils/organizationComputer';
import type { OrganizationAgent } from '@shared/utils/organization-agents';
import { api } from '../utils/api';

const STATE_TONE: Record<string, string> = {
  ready: 'text-emerald-300',
  off: 'text-gray-300',
  unavailable: 'text-amber-300',
  'not-permitted': 'text-amber-300',
  'agent-inactive': 'text-amber-300',
};
const button =
  'rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Computer status for an organization agent chat: whose desktop it is, whether
 * it is on (and whether that comes from the agent default or this chat), and
 * why it can't run. A failed change shows inline and never blocks the chat.
 */
export default function OrganizationComputerBar({
  agent,
  organizationName,
  user,
  sessionValue,
  onChange,
  onOpenViewer,
  loadRuntime = api.getDesktopRuntime,
}: {
  agent: Partial<OrganizationAgent> & { name?: string };
  organizationName: string | null | undefined;
  user: { name?: string | null; email?: string | null } | null | undefined;
  sessionValue: unknown;
  /** `null` drops the chat override so the agent default applies. */
  onChange: (enabled: boolean | null) => Promise<unknown>;
  onOpenViewer?: () => void;
  loadRuntime?: () => Promise<DesktopRuntimeInfo>;
}) {
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    loadRuntime()
      .then((r) => {
        if (live && r && typeof r.available === 'boolean') setRuntime(r);
      })
      .catch(() => {
        // Unknown backend status is not the same as unavailable; say nothing.
      });
    return () => {
      live = false;
    };
  }, [loadRuntime]);

  const status = organizationComputerStatus({ agent, sessionValue, runtime });
  const { setting } = status;
  const change = async (value: boolean | null) => {
    setSaving(true);
    setError('');
    try {
      await onChange(value);
    } catch (err) {
      setError(computerToolErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 md:px-6 py-1.5 border-b border-gray-800 bg-gray-900/40 text-xs electron-no-drag"
      data-testid="organization-computer-bar"
      data-state={status.state}
    >
      <span className="inline-flex items-center gap-1 font-medium text-gray-200">
        <Monitor size={13} aria-hidden className="text-sky-300" />
        Computer
      </span>
      <span className={STATE_TONE[status.state]} data-testid="organization-computer-state">
        {status.title}
      </span>
      {status.canToggle && (
        <span className="text-gray-500" data-testid="organization-computer-source">
          {computerToolSourceLabel(setting)}
        </span>
      )}
      <span className="text-gray-400 truncate" data-testid="organization-computer-owner">
        {organizationComputerOwnerLabel({ organizationName, agentName: agent.name, user })}
      </span>
      <span className="flex-1" />
      {status.canToggle && (
        <button
          type="button"
          className={button}
          disabled={saving}
          aria-pressed={setting.enabled}
          onClick={() => void change(!setting.enabled)}
        >
          {setting.enabled ? 'Turn off for this chat' : 'Turn on for this chat'}
        </button>
      )}
      {status.canToggle && setting.overridden && (
        <button
          type="button"
          className={button}
          disabled={saving}
          onClick={() => void change(null)}
        >
          {computerToolResetLabel(setting)}
        </button>
      )}
      {onOpenViewer && (status.state === 'ready' || status.state === 'unavailable') && (
        <button type="button" className={button} onClick={onOpenViewer}>
          Open Computer
        </button>
      )}
      <p className="w-full text-gray-500" data-testid="organization-computer-detail">
        {status.detail}
      </p>
      {error && (
        <p className="w-full text-rose-300" role="alert" data-testid="organization-computer-error">
          {error}
        </p>
      )}
    </div>
  );
}
