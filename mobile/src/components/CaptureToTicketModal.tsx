import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import type { CaptureCardDraft } from '@shared/utils/captureCard';

/**
 * Mobile project/column picker for the direct capture path (spec
 * CAPTURE-PROVENANCE): turn a Gmail message / Calendar event into a kanban card
 * on a chosen project board. 1:1 peer of the web `CaptureToTicketModal`. The
 * `draft` carries the pre-built title / description / provenance triple; this
 * modal collects the destination (project + column) and an editable title, then
 * POSTs the card with its `source` stamped.
 */

interface BoardColumn {
  id: string;
  name: string;
}

export default function CaptureToTicketModal({
  draft,
  onClose,
  onCreated,
}: {
  draft: CaptureCardDraft;
  onClose: () => void;
  onCreated?: (result: { projectId: string; card: unknown }) => void;
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [columnId, setColumnId] = useState<string>('');
  const [title, setTitle] = useState<string>(draft.title);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingProjects(true);
    api
      .getProjects()
      .then((list: any) => {
        if (cancelled) return;
        const rows = Array.isArray(list) ? list : [];
        setProjects(rows);
        if (rows.length) setProjectId(String(rows[0].id));
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setError(null);
    setLoadingColumns(true);
    setColumns([]);
    setColumnId('');
    api
      .getProjectBoard(projectId)
      .then((board: any) => {
        if (cancelled) return;
        const cols: BoardColumn[] = Array.isArray(board?.columns)
          ? board.columns.map((c: any) => ({ id: String(c.id), name: String(c.name) }))
          : [];
        setColumns(cols);
        if (cols.length) setColumnId(cols[0].id);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load board columns');
      })
      .finally(() => {
        if (!cancelled) setLoadingColumns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const canSubmit = !!projectId && !!columnId && !!title.trim() && !submitting && !loadingColumns;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const card = await api.createKanbanCard(projectId, {
        title: title.trim(),
        ...(draft.description ? { description: draft.description } : {}),
        columnId,
        source: draft.source,
      });
      setCreated(true);
      onCreated?.({ projectId, card });
      setTimeout(() => onClose(), 700);
    } catch (err: any) {
      setError(err?.message || 'Failed to create ticket');
      setSubmitting(false);
    }
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.heading}>Create ticket from capture</Text>
          <ScrollView>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Text style={styles.label}>Title</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              style={styles.input}
              placeholder="Ticket title"
              placeholderTextColor={colors.gray400}
            />

            <Text style={styles.label}>Project</Text>
            {loadingProjects ? (
              <ActivityIndicator color={colors.blue400} style={styles.loader} />
            ) : !projects.length ? (
              <Text style={styles.muted}>No projects available</Text>
            ) : (
              <View style={styles.chipWrap}>
                {projects.map((p) => {
                  const id = String(p.id);
                  const active = id === projectId;
                  return (
                    <TouchableOpacity
                      key={id}
                      onPress={() => setProjectId(id)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {p.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <Text style={styles.label}>Column</Text>
            {loadingColumns ? (
              <ActivityIndicator color={colors.blue400} style={styles.loader} />
            ) : !columns.length ? (
              <Text style={styles.muted}>No columns</Text>
            ) : (
              <View style={styles.chipWrap}>
                {columns.map((c) => {
                  const active = c.id === columnId;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      onPress={() => setColumnId(c.id)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {c.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={submit}
              disabled={!canSubmit}
              style={[styles.primaryButton, !canSubmit && styles.disabledButton]}
              accessibilityLabel="Create ticket"
            >
              <Text style={styles.primaryButtonText}>
                {submitting ? 'Creating…' : created ? '✓ Created' : 'Create ticket'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.black60, justifyContent: 'center', padding: 16 },
  card: {
    maxHeight: '85%',
    borderRadius: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 16,
  },
  heading: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  label: { color: colors.gray400, fontSize: 12, marginBottom: 6, marginTop: 12 },
  input: {
    color: colors.white,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  muted: { color: colors.gray400, fontSize: 13 },
  loader: { alignSelf: 'flex-start', marginTop: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.white },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 6 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  secondaryButtonText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  primaryButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  disabledButton: { opacity: 0.5 },
});
