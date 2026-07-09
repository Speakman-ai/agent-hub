import { useCallback, useEffect, useState } from 'react';
import {
  Play,
  Trash2,
  Plus,
  RefreshCw,
  X,
  AlertCircle,
  ChevronLeft,
  ListVideo,
  Star,
  Pencil,
} from 'lucide-react';
import { api } from '../utils/api';
import ReplayPlayerModal from './ReplayPlayerModal';
import { formatReplayDuration, formatBytes } from '../utils/replayFormat';

// Replay playlists ("Playlists" tab of ReplaysDashboardPage). Named,
// project-scoped groups of saved captures (server/routes/replay-playlists.ts).
// Master/detail: the list surfaces create/rename/delete + the playlist-level
// Keep (extended-retention) toggle; opening a playlist shows its member
// captures with watch + remove. Adding captures happens from the Replays tab
// ("Add to playlist" per row), matching Datadog's flow.

function absDate(ts: any): string {
  if (!ts) return '';
  const d = ts.includes?.('T') ? new Date(ts) : new Date(ts + 'Z');
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

export default function ReplayPlaylistsPanel({ projectId, onNotify }: any) {
  const [playlists, setPlaylists] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const notify = useCallback(
    (msg: string, type: string = 'info') => onNotify?.(msg, type),
    [onNotify],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listReplayPlaylists(projectId);
      setPlaylists(res?.playlists ?? []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load playlists');
      setPlaylists(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setOpenId(null);
    load();
  }, [projectId, load]);

  if (openId) {
    return (
      <PlaylistDetail
        projectId={projectId}
        playlistId={openId}
        onBack={() => {
          setOpenId(null);
          load();
        }}
        onNotify={notify}
      />
    );
  }

  return (
    <ReplayPlaylistsList
      playlists={playlists}
      loading={loading}
      error={error}
      projectId={projectId}
      notify={notify}
      reload={load}
      onOpen={setOpenId}
    />
  );
}

// ── Playlist list + create form ─────────────────────────────────────
function ReplayPlaylistsList({
  playlists,
  loading,
  error,
  projectId,
  notify,
  reload,
  onOpen,
}: any) {
  const [creating, setCreating] = useState(false);
  const rows = playlists ?? [];

  const remove = async (pl: any) => {
    if (!window.confirm(`Delete playlist "${pl.name}"? Member captures are kept.`)) return;
    try {
      await api.deleteReplayPlaylist(projectId, pl.id);
      notify('Playlist deleted', 'success');
      reload();
    } catch (e: any) {
      notify(e?.message || 'Failed to delete playlist', 'error');
    }
  };

  const toggleKeep = async (pl: any) => {
    try {
      await api.setReplayPlaylistRetention(projectId, pl.id, !pl.extendedRetention);
      notify(pl.extendedRetention ? 'Extended retention cleared' : 'Playlist kept', 'success');
      reload();
    } catch (e: any) {
      notify(e?.message || 'Failed to update retention', 'error');
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        <p className="text-xs text-gray-500">
          Named groups of saved captures. Flag a whole playlist to keep its captures past the
          default retention window.
        </p>
        <button
          type="button"
          onClick={reload}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-indigo-200 border border-indigo-500/40 hover:bg-indigo-500/10"
        >
          <Plus size={13} />
          New playlist
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="p-8 text-center text-gray-500 text-sm">Loading playlists…</div>
      ) : rows.length === 0 ? (
        <div className="p-12 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
          No playlists yet. Create one, then add captures from the Replays tab.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((pl: any) => (
            <div
              key={pl.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-gray-800 bg-gray-900/60 hover:bg-gray-900"
            >
              <button
                type="button"
                onClick={() => onOpen(pl.id)}
                className="flex items-center gap-2 min-w-0 text-left flex-1"
                title="Open playlist"
              >
                <ListVideo size={16} className="text-indigo-400 shrink-0" />
                <span className="text-sm text-gray-100 truncate">{pl.name}</span>
                <span className="text-xs text-gray-500 shrink-0">
                  {pl.itemCount} capture{pl.itemCount === 1 ? '' : 's'}
                </span>
                {pl.extendedRetention && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0"
                    title={pl.retainedUntil ? `Kept until ${absDate(pl.retainedUntil)}` : 'Kept'}
                  >
                    <Star size={9} />
                    Kept
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => toggleKeep(pl)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
                  pl.extendedRetention
                    ? 'text-amber-200 border-amber-500/40 hover:bg-amber-500/10'
                    : 'text-gray-300 border-gray-700 hover:bg-gray-800'
                }`}
                title={
                  pl.extendedRetention
                    ? 'Clear extended retention for this playlist'
                    : 'Keep this playlist (extended retention)'
                }
              >
                <Star size={12} />
                {pl.extendedRetention ? 'Kept' : 'Keep'}
              </button>
              <button
                type="button"
                onClick={() => remove(pl)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-rose-300 border border-rose-500/30 hover:bg-rose-500/10"
                title="Delete playlist"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <PlaylistFormModal
          title="New playlist"
          submitLabel="Create"
          onClose={() => setCreating(false)}
          onSubmit={async ({ name, description }: any) => {
            await api.createReplayPlaylist(projectId, { name, description });
            setCreating(false);
            notify('Playlist created', 'success');
            reload();
          }}
          onError={(msg: string) => notify(msg, 'error')}
        />
      )}
    </>
  );
}

// ── Playlist detail (items + rename/delete/keep) ────────────────────
function PlaylistDetail({ projectId, playlistId, onBack, onNotify }: any) {
  const [playlist, setPlaylist] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getReplayPlaylist(projectId, playlistId);
      setPlaylist(res);
    } catch (e: any) {
      setError(e?.message || 'Failed to load playlist');
      setPlaylist(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, playlistId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleKeep = async () => {
    if (!playlist) return;
    try {
      await api.setReplayPlaylistRetention(projectId, playlistId, !playlist.extendedRetention);
      onNotify?.(
        playlist.extendedRetention ? 'Extended retention cleared' : 'Playlist kept',
        'success',
      );
      load();
    } catch (e: any) {
      onNotify?.(e?.message || 'Failed to update retention', 'error');
    }
  };

  const removeItem = async (replayId: string) => {
    try {
      await api.removeReplayPlaylistItem(projectId, playlistId, replayId);
      onNotify?.('Capture removed from playlist', 'success');
      load();
    } catch (e: any) {
      onNotify?.(e?.message || 'Failed to remove capture', 'error');
    }
  };

  const items = playlist?.items ?? [];

  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
        >
          <ChevronLeft size={14} />
          Playlists
        </button>
        {playlist && (
          <>
            <h2 className="text-sm font-semibold text-gray-100 truncate">{playlist.name}</h2>
            {playlist.extendedRetention && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30"
                title={
                  playlist.retainedUntil ? `Kept until ${absDate(playlist.retainedUntil)}` : 'Kept'
                }
              >
                <Star size={9} />
                Kept
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
                title="Rename playlist"
              >
                <Pencil size={12} />
                Rename
              </button>
              <button
                type="button"
                onClick={toggleKeep}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
                  playlist.extendedRetention
                    ? 'text-amber-200 border-amber-500/40 hover:bg-amber-500/10'
                    : 'text-gray-300 border-gray-700 hover:bg-gray-800'
                }`}
              >
                <Star size={12} />
                {playlist.extendedRetention ? 'Kept' : 'Keep'}
              </button>
            </div>
          </>
        )}
      </div>

      {playlist?.description && (
        <p className="text-xs text-gray-500 mb-3">{playlist.description}</p>
      )}

      {error ? (
        <div className="flex items-center gap-2 p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-red-300 text-sm">
          <AlertCircle size={16} />
          {error}
        </div>
      ) : loading ? (
        <div className="p-8 text-center text-gray-500 text-sm">Loading playlist…</div>
      ) : items.length === 0 ? (
        <div className="p-12 text-center text-gray-500 text-sm border border-dashed border-gray-800 rounded-lg">
          No captures in this playlist yet. Add captures from the Replays tab.
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-800 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 font-medium">Captured</th>
                <th className="px-3 py-2 font-medium text-right">Time Spent</th>
                <th className="px-3 py-2 font-medium text-right">Events</th>
                <th className="px-3 py-2 font-medium text-right">Size</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it: any) => (
                <tr key={it.replayId} className="border-b border-gray-800/60 hover:bg-gray-900/60">
                  <td className="px-3 py-2 text-gray-300 whitespace-nowrap" title={it.createdAt}>
                    {absDate(it.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-gray-300 text-right whitespace-nowrap">
                    {formatReplayDuration(it.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-gray-400 text-right">{it.eventCount}</td>
                  <td className="px-3 py-2 text-gray-400 text-right whitespace-nowrap">
                    {formatBytes(it.size)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPlayingId(it.replayId)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-200 border border-gray-700 hover:bg-gray-800"
                        title="Watch replay"
                      >
                        <Play size={12} />
                        Watch
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(it.replayId)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-rose-300 border border-rose-500/30 hover:bg-rose-500/10"
                        title="Remove from playlist"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {playingId && <ReplayPlayerModal replayId={playingId} onClose={() => setPlayingId(null)} />}

      {editing && playlist && (
        <PlaylistFormModal
          title="Rename playlist"
          submitLabel="Save"
          initialName={playlist.name}
          initialDescription={playlist.description}
          onClose={() => setEditing(false)}
          onSubmit={async ({ name, description }: any) => {
            await api.updateReplayPlaylist(projectId, playlistId, {
              name,
              description: description || null,
            });
            setEditing(false);
            onNotify?.('Playlist updated', 'success');
            load();
          }}
          onError={(msg: string) => onNotify?.(msg, 'error')}
        />
      )}
    </>
  );
}

// ── Create / rename modal ───────────────────────────────────────────
function PlaylistFormModal({
  title,
  submitLabel,
  initialName = '',
  initialDescription = '',
  onClose,
  onSubmit,
  onError,
}: any) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription || '');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onSubmit({ name: trimmed, description: description.trim() });
    } catch (e: any) {
      onError?.(e?.message || 'Failed to save playlist');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              autoFocus
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Checkout errors"
              className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description (optional)</label>
            <textarea
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-800">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-700 hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || submitting}
            onClick={submit}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
          >
            {submitting ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
