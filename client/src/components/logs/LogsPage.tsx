/**
 * Project Logs module (LOG-QUERY UI). A single project surface with three
 * tabs:
 *   - Live    — the raw committed-log tail (`LiveLogsView`).
 *   - Issues  — grouped, deduplicated error issues (`IssuesView`).
 *   - Sources — write-only ingest-credential management (`LogSourcesSettingsSection`).
 *
 * This is distinct from Settings → Server Logs, which shows the Agent Hub
 * server's own process logs. Here we show the application logs a project's
 * sources ingest.
 */
import { useState } from 'react';
import { ScrollText, Radio, Bug, KeyRound } from 'lucide-react';
import LiveLogsView from './LiveLogsView';
import IssuesView from './IssuesView';
import LogSourcesSettingsSection from '../LogSourcesSettingsSection';
import type { UseLogTailOptions } from '../../hooks/useLogTail';

type LogsTab = 'live' | 'issues' | 'sources';

interface LogsPageProps {
  projectId: string;
  projectName?: string;
  showToast?: (message: string, kind?: string) => void;
  onOpenSession?: (target: { sessionId: string; agentId: string }) => void;
  /** Forwarded to the Live view's `useLogTail` (tests inject a socket). */
  tailOptions?: UseLogTailOptions;
  initialTab?: LogsTab;
}

const TABS: ReadonlyArray<{ key: LogsTab; label: string; icon: React.ReactNode }> = [
  { key: 'live', label: 'Live', icon: <Radio size={14} /> },
  { key: 'issues', label: 'Issues', icon: <Bug size={14} /> },
  { key: 'sources', label: 'Sources', icon: <KeyRound size={14} /> },
];

export default function LogsPage({
  projectId,
  projectName,
  showToast,
  onOpenSession,
  tailOptions,
  initialTab = 'live',
}: LogsPageProps): React.ReactElement {
  const [tab, setTab] = useState<LogsTab>(initialTab);

  return (
    <div className="flex h-full flex-col">
      <header className="mb-3 flex items-center gap-2">
        <ScrollText size={18} className="text-gray-400" />
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Logs</h2>
          <p className="text-xs text-gray-500">
            Live application logs and grouped error issues
            {projectName ? ` for ${projectName}` : ''}.
          </p>
        </div>
      </header>

      <nav className="mb-3 flex items-center gap-1 border-b border-gray-800" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? 'border-sky-500 text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1">
        {tab === 'live' ? (
          <LiveLogsView projectId={projectId} tailOptions={tailOptions} />
        ) : tab === 'issues' ? (
          <IssuesView projectId={projectId} showToast={showToast} onOpenSession={onOpenSession} />
        ) : (
          <LogSourcesSettingsSection
            projects={[{ id: projectId, name: projectName || projectId }]}
            showToast={showToast}
          />
        )}
      </div>
    </div>
  );
}
