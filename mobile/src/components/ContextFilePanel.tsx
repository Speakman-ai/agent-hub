import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

const mdStyles = {
  body: { color: colors.gray300, fontSize: 13 },
  paragraph: { marginTop: 0, marginBottom: 6 },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  fence: { backgroundColor: colors.gray800, borderRadius: 6, padding: 8 },
  code_block: { color: colors.gray200, fontSize: 12 },
  strong: { color: colors.white },
};

export default function ContextFilePanel({
  filename,
  content,
  agentId,
  onSaved,
  hint,
  defaultExpanded = false,
  loading = false,
  error = false,
  onRetry,
}: any) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  // `content` is null until the requested agent's file has loaded. Only seed
  // the editor from a real string so a pending/errored read never becomes
  // editable empty text the user could save over an existing file.
  const [editContent, setEditContent] = useState(typeof content === 'string' ? content : '');
  // The token of the save that currently owns the "saving" indicator for the
  // mounted view. A per-request token (not a boolean, not an agent id) is the
  // only thing that survives overlapping saves and A->B->A round-trips.
  const [activeSaveToken, setActiveSaveToken] = useState<number | null>(null);
  const saving = activeSaveToken !== null;
  // User-facing save failure for the current view. Compare-and-swap conflicts
  // (409) are an expected outcome now, so the editor must tell the user their
  // buffer was NOT written and how to recover — not just log to the console.
  const [saveError, setSaveError] = useState<string | null>(null);

  const ready = !loading && !error && typeof content === 'string';

  // Root of every "state leaked across agents" bug flagged on this panel: the
  // component instance is reused across agents (and across separate visits to
  // the same agent), so transient editor state and in-flight saves must be
  // bound to a UNIQUE mounted-view identity, not to the agent id alone.
  //
  // `genRef` is that identity: a monotonic generation bumped synchronously
  // during render whenever `agentId` changes. A -> B -> A therefore yields
  // generations 0, 1, 2 — the second visit to A is a DIFFERENT generation, so
  // an A save started in generation 0 is correctly stale when it resolves.
  const genRef = useRef(0);
  const prevAgentIdRef = useRef(agentId);
  if (prevAgentIdRef.current !== agentId) {
    prevAgentIdRef.current = agentId;
    genRef.current += 1;
  }
  // Monotonic id handed to each save so an older request can never clear or
  // apply on behalf of a newer one, even within the same generation.
  const saveSeqRef = useRef(0);

  // Re-seed the editor from the loaded content whenever the content OR the
  // mounted agent changes. Resetting on `agentId` is what drops agent A's
  // unsaved buffer on a switch to agent B, even when both files have identical
  // content so `content` alone never changes.
  useEffect(() => {
    setEditContent(typeof content === 'string' ? content : '');
  }, [content, agentId]);

  // Close the editor when the file becomes unavailable (load/error) or the view
  // switches agents, and drop any pending-save indicator inherited from the
  // previous view. The underlying request is still tracked by token/generation,
  // so clearing the indicator here only affects THIS view's UI.
  useEffect(() => {
    setEditing(false);
  }, [ready, agentId]);
  useEffect(() => {
    setActiveSaveToken(null);
    setSaveError(null);
  }, [agentId]);

  const handleSave = async () => {
    if (!agentId || !ready) return;
    // Bind this save to the exact mounted view (generation) and give it a unique
    // token. Both are checked at completion so nothing stale applies or clears.
    const myGen = genRef.current;
    const myToken = (saveSeqRef.current += 1);
    const targetAgent = agentId;
    const buffer = editContent;
    // The content this edit was based on — the server uses it as a
    // compare-and-swap base so a stale/out-of-order save cannot overwrite a
    // newer commit on disk.
    const base = typeof content === 'string' ? content : '';
    setActiveSaveToken(myToken);
    setSaveError(null);
    try {
      await api.saveContext(targetAgent, filename, buffer, base);
      // Apply only if we are still in the very same mounted view that started
      // this save. A -> B, or A -> B -> A, both change the generation, so an
      // older buffer can never be written into a later view.
      if (genRef.current !== myGen) return;
      setEditing(false);
      onSaved?.(filename, buffer);
    } catch (err: any) {
      console.error('Failed to save:', err);
      // Only surface the failure if we are still on the view that saved, so a
      // stale save can't paint an error over an unrelated agent. The buffer is
      // left intact (we do NOT exit editing) so the user can retry or copy it.
      if (genRef.current === myGen) {
        const msg = String(err?.message ?? '');
        const conflict = /\b409\b/.test(msg) || /stale_write/i.test(msg);
        setSaveError(
          conflict
            ? 'This file changed since you opened it (a newer save landed first). Reload to get the latest, then reapply your edit — your text is kept here.'
            : 'Could not save. Check your connection and try again — your text is kept here.',
        );
      }
    } finally {
      // Clear the indicator only if THIS exact request still owns it; a newer
      // save (any agent, any generation) holds a different token.
      setActiveSaveToken((prev) => (prev === myToken ? null : prev));
    }
  };

  return (
    <View style={styles.card} testID={`context-file-${filename}`}>
      <TouchableOpacity style={styles.header} onPress={() => setExpanded(!expanded)}>
        <Text style={styles.filename}>{filename}</Text>
        <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.body}>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
          {error ? (
            <View style={styles.stateRow} testID={`context-file-${filename}-error`}>
              <Text style={styles.errorText}>Failed to load {filename}.</Text>
              {onRetry ? (
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => onRetry()}
                  testID={`context-file-${filename}-retry`}
                >
                  <Text style={styles.editBtnText}>Retry</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : loading || typeof content !== 'string' ? (
            <View style={styles.stateRow} testID={`context-file-${filename}-loading`}>
              <Text style={styles.hint}>Loading {filename}…</Text>
            </View>
          ) : (
            <>
              <View style={styles.editRow}>
                <TouchableOpacity
                  style={[styles.editBtn, editing && styles.editBtnActive]}
                  onPress={() => setEditing(!editing)}
                >
                  <Text style={styles.editBtnText}>{editing ? 'Editing' : 'Edit'}</Text>
                </TouchableOpacity>
                {editing && (
                  <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
                    <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save'}</Text>
                  </TouchableOpacity>
                )}
              </View>
              {saveError ? (
                <Text style={styles.errorText} testID={`context-file-${filename}-save-error`}>
                  {saveError}
                </Text>
              ) : null}
              {editing ? (
                <TextInput
                  value={editContent}
                  onChangeText={(t: string) => {
                    setEditContent(t);
                    if (saveError) setSaveError(null);
                  }}
                  multiline
                  style={styles.textarea}
                  textAlignVertical="top"
                />
              ) : (
                <ScrollView style={styles.scroll} nestedScrollEnabled>
                  <Markdown style={mdStyles as any}>{content || '*(empty)*'}</Markdown>
                </ScrollView>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray900,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  filename: { fontSize: 14, fontWeight: '500', color: colors.gray300, flex: 1 },
  chevron: { color: colors.gray500 },
  body: { borderTopWidth: 1, borderTopColor: colors.gray800, padding: 12 },
  hint: { fontSize: 11, color: colors.gray500, marginBottom: 8, lineHeight: 16 },
  editRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  errorText: { fontSize: 12, color: colors.amber400 },
  editBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  editBtnActive: { backgroundColor: colors.blue900_40 },
  editBtnText: { fontSize: 12, color: colors.gray400 },
  saveBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.emerald800_50,
  },
  saveBtnText: { fontSize: 12, color: colors.emerald400 },
  textarea: {
    minHeight: 160,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.white,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  scroll: { maxHeight: 280 },
});
