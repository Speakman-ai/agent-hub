import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { formatReplayDuration, formatBytes, formatCaptureDate } from '../utils/replayFormat';

// Mobile Replay Playlists — parity port of the web ReplayPlaylistsPanel
// (client/src/components/ReplayPlaylistsPanel.tsx). Named, project-scoped
// groups of saved captures + the playlist-level Keep (extended-retention)
// toggle. Master/detail: the list surfaces create/delete + Keep; opening a
// playlist shows its member captures with watch + remove + rename.

/** Notification copy after adding a capture to a playlist. `createdName` is set
 *  when a new playlist was created inline (always a fresh add); otherwise the
 *  server's `added` flag distinguishes a fresh add from an already-member. Pure
 *  + exported so the add path is unit-testable without RN touch events. Mirrors
 *  the web AddToPlaylistModal message. */
export function addToPlaylistMessage(res: any, createdName?: string): string {
  const label = createdName || res?.name || 'playlist';
  return res?.added === false ? `Already in ${label}` : `Added to ${label}`;
}

// ── List + create ───────────────────────────────────────────────────
export function ReplayPlaylistsView({ projectId, onWatch, onNotify }: any) {
  const [playlists, setPlaylists] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const notify = useCallback(
    (msg: string, type: string = 'info') => onNotify?.(msg, type),
    [onNotify],
  );

  const load = useCallback(async () => {
    if (!projectId) return;
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

  const toggleKeep = async (pl: any) => {
    try {
      await api.setReplayPlaylistRetention(projectId, pl.id, !pl.extendedRetention);
      notify(pl.extendedRetention ? 'Extended retention cleared' : 'Playlist kept', 'success');
      load();
    } catch (e: any) {
      notify(e?.message || 'Failed to update retention', 'error');
    }
  };

  const remove = (pl: any) => {
    Alert.alert('Delete playlist', `Delete "${pl.name}"? Member captures are kept.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteReplayPlaylist(projectId, pl.id);
            notify('Playlist deleted', 'success');
            load();
          } catch (e: any) {
            notify(e?.message || 'Failed to delete playlist', 'error');
          }
        },
      },
    ]);
  };

  if (openId) {
    return (
      <PlaylistDetail
        projectId={projectId}
        playlistId={openId}
        onBack={() => {
          setOpenId(null);
          load();
        }}
        onWatch={onWatch}
        onNotify={notify}
      />
    );
  }

  const rows = playlists ?? [];

  return (
    <View style={styles.flex}>
      <View style={styles.headerRow}>
        <Text style={styles.blurb}>Named groups of saved captures.</Text>
        <TouchableOpacity
          testID="new-playlist"
          onPress={() => setCreating(true)}
          style={[styles.pill, styles.pillPrimary]}
        >
          <Text style={styles.pillPrimaryText}>+ New</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : loading && rows.length === 0 ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={colors.gray400} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>No playlists</Text>
          <Text style={styles.emptyDesc}>Create one, then add captures from the Replays tab.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item: any) => item.id}
          contentContainerStyle={styles.listPad}
          renderItem={({ item: pl }: any) => (
            <View testID="playlist-row" style={styles.card}>
              <TouchableOpacity onPress={() => setOpenId(pl.id)} style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {pl.name}
                </Text>
                {pl.extendedRetention ? <Text style={[styles.chip, styles.chipKept]}>★ Kept</Text> : null}
              </TouchableOpacity>
              <Text style={styles.cardSub}>
                {pl.itemCount} capture{pl.itemCount === 1 ? '' : 's'}
              </Text>
              <View style={styles.actionRow}>
                <TouchableOpacity
                  testID="playlist-keep"
                  onPress={() => toggleKeep(pl)}
                  style={[styles.actionBtn, pl.extendedRetention && styles.actionBtnKept]}
                >
                  <Text style={[styles.actionText, pl.extendedRetention && styles.actionTextKept]}>
                    {pl.extendedRetention ? '★ Kept' : '☆ Keep'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => remove(pl)} style={styles.actionBtn}>
                  <Text style={styles.actionTextDanger}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {creating ? (
        <PlaylistFormModal
          title="New playlist"
          submitLabel="Create"
          onClose={() => setCreating(false)}
          onSubmit={async ({ name, description }: any) => {
            await api.createReplayPlaylist(projectId, { name, description });
            setCreating(false);
            notify('Playlist created', 'success');
            load();
          }}
          onError={(msg: string) => notify(msg, 'error')}
        />
      ) : null}
    </View>
  );
}

// ── Detail (items + rename/keep) ────────────────────────────────────
function PlaylistDetail({ projectId, playlistId, onBack, onWatch, onNotify }: any) {
  const [playlist, setPlaylist] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const removeItem = (replayId: string) => {
    Alert.alert('Remove capture', 'Remove this capture from the playlist?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.removeReplayPlaylistItem(projectId, playlistId, replayId);
            onNotify?.('Capture removed', 'success');
            load();
          } catch (e: any) {
            onNotify?.(e?.message || 'Failed to remove capture', 'error');
          }
        },
      },
    ]);
  };

  const items = playlist?.items ?? [];

  return (
    <View style={styles.flex}>
      <View style={styles.headerRow}>
        <TouchableOpacity testID="playlist-back" onPress={onBack} style={styles.pill}>
          <Text style={styles.pillText}>‹ Playlists</Text>
        </TouchableOpacity>
        {playlist ? (
          <>
            <Text style={styles.detailTitle} numberOfLines={1}>
              {playlist.name}
            </Text>
            <TouchableOpacity onPress={() => setEditing(true)} style={styles.pill}>
              <Text style={styles.pillText}>Rename</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleKeep}
              style={[styles.pill, playlist.extendedRetention && styles.pillKept]}
            >
              <Text style={[styles.pillText, playlist.extendedRetention && styles.actionTextKept]}>
                {playlist.extendedRetention ? '★ Kept' : '☆ Keep'}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>

      {error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={colors.gray400} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>No captures</Text>
          <Text style={styles.emptyDesc}>Add captures from the Replays tab.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item: any) => item.replayId}
          contentContainerStyle={styles.listPad}
          renderItem={({ item: it }: any) => (
            <View testID="playlist-item-row" style={styles.card}>
              <Text style={styles.cardSub}>{formatCaptureDate(it.createdAt)}</Text>
              <View style={styles.statRow}>
                <Stat label="Time" value={formatReplayDuration(it.durationMs)} />
                <Stat label="Events" value={String(it.eventCount ?? 0)} />
                <Stat label="Size" value={formatBytes(it.size)} />
              </View>
              <View style={styles.actionRow}>
                <TouchableOpacity
                  testID="playlist-item-watch"
                  onPress={() => onWatch?.(it)}
                  style={[styles.actionBtn, styles.actionBtnPrimary]}
                >
                  <Text style={styles.actionTextPrimary}>▶ Watch</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => removeItem(it.replayId)} style={styles.actionBtn}>
                  <Text style={styles.actionTextDanger}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {editing && playlist ? (
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
      ) : null}
    </View>
  );
}

// ── Add-to-playlist modal (invoked from a capture row) ──────────────
export function AddToPlaylistModal({ projectId, replay, onClose, onAdded, onError }: any) {
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.listReplayPlaylists(projectId);
        if (alive) setPlaylists(res?.playlists ?? []);
      } catch (e: any) {
        if (alive) onError?.(e?.message || 'Failed to load playlists');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // `onError` is intentionally excluded: the parent passes it as a fresh
    // inline arrow, so including it would re-run this fetch on every parent
    // re-render while the modal is open. It's only read in the catch path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const addTo = async (playlistId: string) => {
    setSubmitting(playlistId);
    try {
      const res = await api.addReplayPlaylistItem(projectId, playlistId, replay.id);
      onAdded(addToPlaylistMessage(res));
    } catch (e: any) {
      onError?.(e?.message || 'Failed to add to playlist');
      setSubmitting(null);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setSubmitting('__new__');
    try {
      const created = await api.createReplayPlaylist(projectId, { name });
      const res = await api.addReplayPlaylistItem(projectId, created.id, replay.id);
      onAdded(addToPlaylistMessage(res, created.name));
    } catch (e: any) {
      onError?.(e?.message || 'Failed to create playlist');
      setSubmitting(null);
    }
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Add to a playlist</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            {loading ? (
              <ActivityIndicator size="small" color={colors.gray400} style={{ marginVertical: 16 }} />
            ) : (
              <>
                {playlists.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    testID={`add-to-${p.id}`}
                    disabled={submitting != null}
                    onPress={() => addTo(p.id)}
                    style={styles.pickRow}
                  >
                    <Text style={styles.pickName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text style={styles.pickCount}>{p.itemCount}</Text>
                  </TouchableOpacity>
                ))}
                {playlists.length === 0 ? (
                  <Text style={styles.emptyDesc}>No playlists yet — create one below.</Text>
                ) : null}
                <View style={styles.newRow}>
                  <TextInput
                    testID="new-playlist-name"
                    value={newName}
                    maxLength={200}
                    onChangeText={setNewName}
                    placeholder="New playlist name"
                    placeholderTextColor={colors.gray600}
                    style={styles.input}
                  />
                  <TouchableOpacity
                    testID="create-and-add"
                    disabled={!newName.trim() || submitting != null}
                    onPress={createAndAdd}
                    style={[
                      styles.pill,
                      styles.pillPrimary,
                      (!newName.trim() || submitting != null) && styles.pillDisabled,
                    ]}
                  >
                    <Text style={styles.pillPrimaryText}>Create + add</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
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
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.modalBody}>
            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              testID="playlist-name"
              autoFocus
              value={name}
              maxLength={200}
              onChangeText={setName}
              placeholder="e.g. Checkout errors"
              placeholderTextColor={colors.gray600}
              style={styles.input}
            />
            <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Description (optional)</Text>
            <TextInput
              testID="playlist-description"
              value={description}
              maxLength={2000}
              onChangeText={setDescription}
              multiline
              style={[styles.input, { height: 64, textAlignVertical: 'top' }]}
            />
            <View style={styles.modalFooter}>
              <TouchableOpacity onPress={onClose} style={styles.pill}>
                <Text style={styles.pillText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="playlist-submit"
                disabled={!name.trim() || submitting}
                onPress={submit}
                style={[styles.pill, styles.pillPrimary, (!name.trim() || submitting) && styles.pillDisabled]}
              >
                <Text style={styles.pillPrimaryText}>{submitting ? 'Saving…' : submitLabel}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Stat({ label, value }: any) {
  return (
    <View>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  blurb: { color: colors.gray500, fontSize: 12, flex: 1 },
  detailTitle: { color: colors.gray100, fontSize: 14, fontWeight: '600', flex: 1 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  pillPrimary: { borderColor: colors.indigo500, backgroundColor: colors.indigo600 },
  pillKept: { borderColor: colors.amber400, backgroundColor: colors.gray800 },
  pillDisabled: { opacity: 0.4 },
  pillText: { color: colors.gray300, fontSize: 12, fontWeight: '500' },
  pillPrimaryText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  listPad: { padding: 12, gap: 10 },
  card: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { color: colors.gray100, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  cardSub: { color: colors.gray500, fontSize: 12, marginTop: 4 },
  chip: {
    fontSize: 10,
    fontWeight: '600',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  chipKept: { color: colors.amber400, backgroundColor: colors.gray800 },
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 8 },
  statLabel: { color: colors.gray600, fontSize: 10, textTransform: 'uppercase' },
  statValue: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  actionBtnPrimary: { borderColor: colors.indigo500 },
  actionBtnKept: { borderColor: colors.amber400, backgroundColor: colors.gray800 },
  actionText: { color: colors.gray200, fontSize: 12 },
  actionTextPrimary: { color: colors.indigo300, fontSize: 12, fontWeight: '600' },
  actionTextKept: { color: colors.amber400, fontWeight: '600' },
  actionTextDanger: { color: colors.rose400, fontSize: 12 },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 6 },
  emptyTitle: { color: colors.gray300, fontSize: 15, fontWeight: '600' },
  emptyDesc: { color: colors.gray500, fontSize: 13, textAlign: 'center' },
  errorText: { color: colors.rose400, fontSize: 13, textAlign: 'center' },
  fieldLabel: { color: colors.gray500, fontSize: 11, marginBottom: 4 },
  input: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.black60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '80%',
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  modalTitle: { color: colors.gray100, fontSize: 14, fontWeight: '600' },
  modalClose: { color: colors.gray400, fontSize: 16 },
  modalBody: { padding: 14 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  pickName: { color: colors.gray100, fontSize: 14, flex: 1 },
  pickCount: { color: colors.gray500, fontSize: 12 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
});
