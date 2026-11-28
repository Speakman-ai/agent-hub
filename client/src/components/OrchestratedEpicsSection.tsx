import { useState } from 'react';
import { api } from '../utils/api';

/**
 * Project toggle: run autonomous epics through one Orchestrate manager thread
 * per epic. Off, the server starts a worker session for each ready ticket.
 */
export default function OrchestratedEpicsSection({ project, showToast, onProjectsChange }: any) {
  const enabled = project.orchestratedEpics === true;
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { orchestratedEpics: !enabled });
      onProjectsChange?.();
    } catch (err: any) {
      const msg = String(err?.message || err || 'Failed to update');
      if (showToast) showToast(msg, 'error');
      else alert(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <span className="text-sm text-gray-200">Run epics through a manager thread</span>
        <p className="text-xs text-gray-500">
          Ready tickets go to the epic&apos;s manager, an Orchestrate chat that writes each
          worker&apos;s brief and starts it. Off by default: the server starts a session for each
          ready ticket itself.
        </p>
      </div>
      <button
        onClick={toggle}
        disabled={saving}
        data-testid={`project-orchestrated-epics-${project.id}`}
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
