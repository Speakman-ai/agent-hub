import React, { useState, useEffect, useCallback, memo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativePrTime } from '../utils/prFormatting';
import {
  normalizePrFiles,
  summarizePrFiles,
  fileStatusLabel,
  annotatePatchLines,
  commentAnchorFor,
  commentsForFile,
} from '../utils/prDiffRender';
import { buildInlineCommentPayload } from '../utils/prReviewActions';

/** Patch lines rendered per expanded file before truncating (mobile perf). */
const MAX_RENDER_LINES = 500;
/** Expand every file by default when the PR is small. */
const AUTO_EXPAND_MAX_FILES = 3;

function statusColor(status) {
  switch (String(status || '').toLowerCase()) {
    case 'added':
      return colors.emerald400;
    case 'removed':
    case 'deleted':
      return colors.rose400;
    case 'renamed':
    case 'copied':
      return colors.amber400;
    default:
      return colors.gray400;
  }
}

function lineStyles(kind) {
  switch (kind) {
    case 'add':
      return { row: styles.addRow, text: styles.addText };
    case 'del':
      return { row: styles.delRow, text: styles.delText };
    case 'hunk':
      return { row: styles.hunkRow, text: styles.hunkText };
    case 'meta':
      return { row: null, text: styles.metaText };
    default:
      return { row: null, text: styles.contextText };
  }
}

/**
 * One collapsible per-file diff block. Native PRs (when `onAddComment` is
 * provided) support line comments: tap a +/-/context line to select it,
 * then write in the composer below the diff. Existing inline comments are
 * listed beneath the diff with their line anchors.
 */
function FileSection({ file, initiallyOpen, comments, onAddComment }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [selectedAnchor, setSelectedAnchor] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState(null);

  const commentable = typeof onAddComment === 'function';
  const annotated = open && file.patch ? annotatePatchLines(file.patch) : [];
  const truncatedCount = Math.max(0, annotated.length - MAX_RENDER_LINES);
  const visible = truncatedCount > 0 ? annotated.slice(0, MAX_RENDER_LINES) : annotated;

  const toggleAnchor = (anchor) => {
    setPostError(null);
    setSelectedAnchor((prev) =>
      prev && anchor && prev.side === anchor.side && prev.line === anchor.line ? null : anchor,
    );
  };

  const submitComment = async () => {
    if (posting) return;
    const built = buildInlineCommentPayload({
      filePath: file.filename,
      line: selectedAnchor?.line,
      side: selectedAnchor?.side,
      body: commentText,
    });
    if (!built.ok) {
      setPostError(built.error);
      return;
    }
    setPosting(true);
    setPostError(null);
    try {
      await onAddComment(built.payload);
      setCommentText('');
      setSelectedAnchor(null);
    } catch (err) {
      setPostError(err?.message || 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  };

  return (
    <View style={styles.fileSection}>
      <TouchableOpacity
        style={styles.fileHeader}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.7}
        accessibilityLabel={`${file.filename}, ${file.additions} additions, ${file.deletions} deletions`}
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.fileChevron}>{open ? '▾' : '▸'}</Text>
        <Text style={[styles.fileStatus, { color: statusColor(file.status) }]}>
          {fileStatusLabel(file.status)}
        </Text>
        <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
          {file.previousFilename ? `${file.previousFilename} → ${file.filename}` : file.filename}
        </Text>
        {comments.length > 0 ? (
          <Text style={styles.fileCommentCount}>{comments.length} comments</Text>
        ) : null}
        {file.isBinary ? (
          <Text style={styles.fileBinary}>binary</Text>
        ) : (
          <Text style={styles.fileCounts}>
            <Text style={styles.fileAdds}>+{file.additions}</Text>{' '}
            <Text style={styles.fileDels}>{'−'}{file.deletions}</Text>
          </Text>
        )}
      </TouchableOpacity>

      {open && (
        <View style={styles.fileBody}>
          {file.isBinary ? (
            <Text style={styles.binaryNote}>Binary or oversized file — no text diff.</Text>
          ) : (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
                <View>
                  {visible.map((line, i) => {
                    const anchor = commentable ? commentAnchorFor(line) : null;
                    const selected =
                      anchor &&
                      selectedAnchor &&
                      anchor.side === selectedAnchor.side &&
                      anchor.line === selectedAnchor.line;
                    const s = lineStyles(line.kind);
                    const row = (
                      <View
                        key={i}
                        style={[styles.lineRow, s.row, selected && styles.lineRowSelected]}
                      >
                        <Text style={[styles.lineText, s.text]}>{line.text || ' '}</Text>
                      </View>
                    );
                    if (!anchor) return row;
                    return (
                      <TouchableOpacity
                        key={i}
                        onPress={() => toggleAnchor(anchor)}
                        activeOpacity={0.6}
                        accessibilityLabel={`Comment on ${anchor.side} line ${anchor.line}`}
                      >
                        {row}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
              {truncatedCount > 0 && (
                <Text style={styles.truncatedNote}>
                  {'…'} {truncatedCount} more lines — open on GitHub/desktop for the full file.
                </Text>
              )}
            </>
          )}

          {comments.map((c) => (
            <View key={c.id} style={styles.commentBubble}>
              <View style={styles.commentHeader}>
                <Text style={styles.commentUser}>@{c.user || 'unknown'}</Text>
                <Text style={styles.commentAnchor}>
                  line {c.line} ({c.side === 'old' ? 'old' : 'new'})
                </Text>
                <Text style={styles.commentTime}>{relativePrTime(c.created_at)}</Text>
              </View>
              <Text style={styles.commentBody}>{c.body}</Text>
            </View>
          ))}

          {commentable && selectedAnchor && (
            <View style={styles.composer}>
              <Text style={styles.composerLabel}>
                Comment on line {selectedAnchor.line} ({selectedAnchor.side})
              </Text>
              <TextInput
                style={styles.composerInput}
                value={commentText}
                onChangeText={(t) => {
                  setCommentText(t);
                  if (postError) setPostError(null);
                }}
                placeholder="Comment on this line…"
                placeholderTextColor={colors.gray500}
                multiline
                editable={!posting}
              />
              {postError ? <Text style={styles.composerError}>{postError}</Text> : null}
              <View style={styles.composerActions}>
                <TouchableOpacity
                  style={[
                    styles.composerSubmit,
                    (posting || !commentText.trim()) && styles.composerSubmitDisabled,
                  ]}
                  onPress={submitComment}
                  disabled={posting || !commentText.trim()}
                  accessibilityState={{ disabled: posting || !commentText.trim(), busy: posting }}
                >
                  {posting ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <Text style={styles.composerSubmitText}>Comment</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    setSelectedAnchor(null);
                    setPostError(null);
                  }}
                  disabled={posting}
                >
                  <Text style={styles.composerCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {commentable && !selectedAnchor && !file.isBinary && (
            <Text style={styles.commentHint}>Tap a diff line to comment on it.</Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * PR "Files changed" — mobile twin of the web `PrFilesChanged` +
 * `FileDiffView`. Loads per-file patches from `/api/pr/files` (JSON —
 * the `/api/pr/diff` endpoint is text/plain, which the mobile fetchJSON
 * helper can't consume) and renders one collapsible block per file.
 */
function PrDiffView({ prUrl, comments = [], onAddComment = null }) {
  const [files, setFiles] = useState(null);
  const [truncatedList, setTruncatedList] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!prUrl) {
      setError('No PR URL available for this pull request.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getPrFiles(prUrl);
      setFiles(normalizePrFiles(data));
      setTruncatedList(Boolean(data?.truncated));
    } catch (err) {
      setError(err?.message || 'Failed to load diff');
      setFiles(null);
    } finally {
      setLoading(false);
    }
  }, [prUrl]);

  useEffect(() => {
    setFiles(null);
    load();
  }, [load]);

  if (loading && files === null) {
    return (
      <View style={styles.stateBox}>
        <ActivityIndicator color={colors.gray400} />
        <Text style={styles.stateText}>Loading diff…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.stateBox}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={load}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!files) return null;
  if (files.length === 0) {
    return <Text style={styles.stateText}>No file changes.</Text>;
  }

  const totals = summarizePrFiles(files);
  return (
    <View>
      <Text style={styles.summaryLine}>
        {totals.count} {totals.count === 1 ? 'file' : 'files'} changed{'  '}
        <Text style={styles.fileAdds}>+{totals.additions}</Text>{' '}
        <Text style={styles.fileDels}>{'−'}{totals.deletions}</Text>
        {truncatedList ? '  (list truncated)' : ''}
      </Text>
      {files.map((file, i) => (
        <FileSection
          key={`${file.filename}-${i}`}
          file={file}
          initiallyOpen={
            files.length <= AUTO_EXPAND_MAX_FILES ||
            commentsForFile(comments, file.filename).length > 0
          }
          comments={commentsForFile(comments, file.filename)}
          onAddComment={onAddComment}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stateBox: { alignItems: 'center', paddingVertical: 16, gap: 8 },
  stateText: { color: colors.gray500, fontSize: 13, textAlign: 'center' },
  errorText: { color: colors.red400, fontSize: 13, textAlign: 'center' },
  retryButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.gray800,
    borderRadius: 6,
  },
  retryButtonText: { color: colors.white, fontSize: 13 },
  summaryLine: { color: colors.gray400, fontSize: 12, marginBottom: 8 },

  fileSection: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    marginBottom: 6,
    overflow: 'hidden',
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  fileChevron: { color: colors.gray500, fontSize: 12, width: 12 },
  fileStatus: { fontSize: 11, fontWeight: '700', width: 12, textAlign: 'center' },
  fileName: { flex: 1, color: colors.gray200, fontSize: 12, fontFamily: 'monospace' },
  fileCommentCount: { color: colors.amber400, fontSize: 10 },
  fileBinary: { color: colors.gray500, fontSize: 10 },
  fileCounts: { fontSize: 11, fontVariant: ['tabular-nums'] },
  fileAdds: { color: colors.emerald400, fontSize: 11 },
  fileDels: { color: colors.rose400, fontSize: 11 },
  fileBody: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray950,
    padding: 6,
  },
  binaryNote: { color: colors.gray500, fontSize: 11, padding: 6 },
  truncatedNote: { color: colors.gray500, fontSize: 10, paddingTop: 6, paddingHorizontal: 4 },

  lineRow: { flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 1 },
  lineRowSelected: {
    borderLeftWidth: 2,
    borderLeftColor: colors.amber400,
    backgroundColor: colors.amber900_40,
  },
  addRow: { backgroundColor: 'rgba(6, 78, 59, 0.25)' },
  delRow: { backgroundColor: 'rgba(136, 19, 55, 0.25)' },
  hunkRow: { backgroundColor: colors.gray700_40, marginVertical: 2 },
  lineText: { fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  addText: { color: colors.emerald400 },
  delText: { color: colors.rose400 },
  hunkText: { color: colors.gray400 },
  metaText: { color: colors.gray500 },
  contextText: { color: colors.gray400 },

  commentBubble: {
    marginTop: 6,
    padding: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
  },
  commentHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  commentUser: { color: colors.gray300, fontSize: 11, fontWeight: '600' },
  commentAnchor: { color: colors.amber400, fontSize: 10 },
  commentTime: { color: colors.gray500, fontSize: 10, marginLeft: 'auto' },
  commentBody: { color: colors.gray200, fontSize: 12, lineHeight: 17 },
  commentHint: { color: colors.gray600, fontSize: 10, paddingTop: 6, paddingHorizontal: 4 },

  composer: {
    marginTop: 6,
    padding: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.amber900_40,
    borderRadius: 6,
    gap: 6,
  },
  composerLabel: { color: colors.amber400, fontSize: 11, fontWeight: '600' },
  composerInput: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    color: colors.gray200,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  composerError: { color: colors.red400, fontSize: 11 },
  composerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  composerSubmit: {
    backgroundColor: colors.emerald500,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 88,
    alignItems: 'center',
  },
  composerSubmitDisabled: { opacity: 0.5 },
  composerSubmitText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  composerCancelText: { color: colors.gray400, fontSize: 12 },
});

export default memo(PrDiffView);
