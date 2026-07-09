import { useState } from 'react';
import { MonitorPlay } from 'lucide-react';
import RumSessionsExplorer from './RumSessionsExplorer';
import ReplayCaptureTable from './ReplayCaptureTable';
import ReplayPlaylistsPanel from './ReplayPlaylistsPanel';

// Replays dashboard shell. Three views:
//   - "Sessions" — the Datadog-parity, session-grain Explorer (rum_sessions
//     rollup, facet + time-range filters). Default view.
//   - "Replays" — the capture-grain table (session_replays), one row per rrweb
//     blob, with support-ticket linking and add-to-playlist.
//   - "Playlists" — named, project-scoped groups of saved captures plus the
//     playlist-level Keep (extended-retention) toggle.

const VIEWS: { id: 'sessions' | 'replays' | 'playlists'; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'replays', label: 'Replays' },
  { id: 'playlists', label: 'Playlists' },
];

export default function ReplaysDashboardPage({ projectId, onNotify }: any) {
  const [view, setView] = useState<'sessions' | 'replays' | 'playlists'>('sessions');

  return (
    <div className="h-full overflow-y-auto bg-gray-950">
      <div className="max-w-6xl mx-auto p-4">
        {/* Header + view toggle */}
        <div className="flex items-center gap-3 mb-3">
          <MonitorPlay size={22} className="text-indigo-400" />
          <h1 className="text-xl font-semibold text-gray-100">Replays</h1>
          <div className="ml-auto inline-flex items-center gap-1 p-0.5 rounded-lg border border-gray-800 bg-gray-900">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  view === v.id
                    ? 'bg-indigo-500/20 text-indigo-200'
                    : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>

        {view === 'sessions' ? (
          <RumSessionsExplorer projectId={projectId} />
        ) : view === 'replays' ? (
          <ReplayCaptureTable projectId={projectId} onNotify={onNotify} />
        ) : (
          <ReplayPlaylistsPanel projectId={projectId} onNotify={onNotify} />
        )}
      </div>
    </div>
  );
}
