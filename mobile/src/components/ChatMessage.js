import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  Modal,
  Dimensions,
  TextInput,
  Pressable,
  ToastAndroid,
  Platform,
  Alert,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { getApiBaseUrl } from '../utils/config';
import { extractCoordinationBlocks, pickHandoffRow } from '../utils/coordinationBlocks';
import { copyToClipboard, canCopy } from '../utils/clipboard';
import { attachmentKind } from '../utils/attachmentKind';
import { createSelectableMarkdownRules } from '../utils/selectableMarkdownRules';
import { parsePrCreatedMetadata, shortSha } from '../utils/prMessage';
import { parseShipRequestedMetadata } from '../utils/shipRequestedMessage';
import { stripAskAnswerBlocks } from '../utils/askAnswers';
import { getUserMessageFlags } from '../utils/chatMessageUserFlags.js';
import { resolveAgentDisplayName } from '../utils/agentDisplayName.js';
import { parseRawReviewVerdictContent } from '../utils/reviewVerdictContent.js';
import HandoffCard from './HandoffCard';

// Built once — overrides the Markdown library's default text/code rules so
// every leaf <Text> is `selectable`, enabling browser-like drag-select copy
// inside assistant bubbles.
const selectableMarkdownRules = createSelectableMarkdownRules(Text);

function notifyCopied(success) {
  const msg = success ? 'Copied to clipboard' : 'Nothing to copy';
  if (Platform.OS === 'android') {
    ToastAndroid.show(msg, ToastAndroid.SHORT);
  } else {
    // iOS has no native toast; a lightweight alert avoids a hard dep.
    Alert.alert(msg);
  }
}

const ENGINE_BADGES = {
  'claude-code': { color: '#8B5CF6', label: 'Claude Code' },
  'cursor-agent': { color: '#10B981', label: 'Cursor Agent' },
  'codex-cli': { color: '#10A37F', label: 'Codex' },
  'grok-cli': { color: '#1D9BF0', label: 'Grok' },
};

const markdownStyles = {
  body: {
    color: colors.gray200,
    fontSize: 14,
    lineHeight: 20,
  },
  heading1: {
    color: colors.white,
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 12,
    marginBottom: 6,
  },
  heading2: {
    color: colors.white,
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 10,
    marginBottom: 6,
  },
  heading3: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 10,
    marginBottom: 4,
  },
  paragraph: {
    marginTop: 4,
    marginBottom: 4,
  },
  code_inline: {
    backgroundColor: colors.gray800,
    color: colors.emerald400,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  code_block: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    marginVertical: 6,
  },
  fence: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    marginVertical: 6,
  },
  blockquote: {
    borderLeftWidth: 4,
    borderLeftColor: colors.gray600,
    paddingLeft: 12,
    marginVertical: 6,
    color: colors.gray400,
    fontStyle: 'italic',
  },
  link: {
    color: colors.blue400,
  },
  list_item: {
    color: colors.gray200,
    marginVertical: 2,
  },
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.gray700,
    marginVertical: 6,
  },
  thead: {
    backgroundColor: colors.gray800,
  },
  th: {
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 6,
    color: colors.gray200,
    fontSize: 12,
  },
  td: {
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 6,
    color: colors.gray200,
    fontSize: 12,
  },
  hr: {
    backgroundColor: colors.gray700,
    marginVertical: 12,
  },
  strong: {
    color: colors.white,
    fontWeight: 'bold',
  },
  em: {
    color: colors.gray300,
    fontStyle: 'italic',
  },
};

function MessageAttachments({ attachments }) {
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const screenWidth = Dimensions.get('window').width;

  const parsed = useMemo(() => {
    if (!attachments) return [];
    try {
      return typeof attachments === 'string' ? JSON.parse(attachments) : attachments;
    } catch {
      return [];
    }
  }, [attachments]);

  if (parsed.length === 0) return null;

  const getDisplayUrl = (att) => {
    if (att.url) return `${getApiBaseUrl().replace('/api', '')}${att.url}`;
    if (att.dataUrl) return att.dataUrl;
    return null;
  };

  const openFile = (src) => {
    if (!src) return;
    Linking.openURL(src).catch(() => {
      Alert.alert('Unable to open file', 'The attachment could not be opened.');
    });
  };

  return (
    <>
      <View style={imageStyles.row}>
        {parsed.map((att, i) => {
          const src = getDisplayUrl(att);
          if (!src) return null;
          const kind = attachmentKind(att);
          const key = att.id || i;

          if (kind === 'image') {
            return (
              <TouchableOpacity key={key} onPress={() => setLightboxUrl(src)} activeOpacity={0.8}>
                <Image source={{ uri: src }} style={imageStyles.thumb} />
              </TouchableOpacity>
            );
          }

          if (kind === 'video') {
            return (
              <TouchableOpacity
                key={key}
                onPress={() => openFile(src)}
                activeOpacity={0.8}
                accessibilityLabel={`Open video ${att.originalName || att.filename || ''}`}
                style={[imageStyles.thumb, imageStyles.videoChip]}
              >
                <Ionicons name="play-circle" size={36} color={colors.gray200} />
                <Text style={imageStyles.mediaBadge}>VIDEO</Text>
              </TouchableOpacity>
            );
          }

          // Generic file — open via default handler (browser / native viewer).
          return (
            <TouchableOpacity
              key={key}
              onPress={() => openFile(src)}
              activeOpacity={0.8}
              accessibilityLabel={`Open file ${att.originalName || att.filename || ''}`}
              style={[imageStyles.thumb, imageStyles.fileChip]}
            >
              <Ionicons name="document-outline" size={26} color={colors.gray200} />
              <Text style={imageStyles.fileName} numberOfLines={2}>
                {att.originalName || att.filename || 'file'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {lightboxUrl && (
        <Modal transparent visible animationType="fade" onRequestClose={() => setLightboxUrl(null)}>
          <TouchableOpacity
            style={imageStyles.lightbox}
            activeOpacity={1}
            onPress={() => setLightboxUrl(null)}
          >
            <Image
              source={{ uri: lightboxUrl }}
              style={{ width: screenWidth * 0.9, height: screenWidth * 0.9 }}
              resizeMode="contain"
            />
          </TouchableOpacity>
        </Modal>
      )}
    </>
  );
}

const imageStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  thumb: {
    width: 120,
    height: 120,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  videoChip: {
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileChip: {
    backgroundColor: colors.gray800,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  mediaBadge: {
    color: colors.gray400,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
  },
  fileName: {
    color: colors.gray200,
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
  },
  lightbox: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

function SystemShipRequestedMessage({ message }) {
  const meta = parseShipRequestedMetadata(message.metadata);
  if (!meta) {
    return (
      <View style={prStyles.fallbackContainer}>
        <Text style={prStyles.fallbackText}>{message.content || 'System event'}</Text>
      </View>
    );
  }
  return (
    <View style={prStyles.container}>
      <View style={shipStyles.card}>
        <View style={prStyles.headerRow}>
          <Ionicons name="git-pull-request" size={16} color={colors.purple400} />
          <Text style={shipStyles.headerText}>
            {meta.auto ? 'Shipping automatically' : 'Create ticket & PR'}
          </Text>
        </View>
        <Text style={shipStyles.subtext}>
          {meta.auto
            ? 'Agent Hub is rebasing on the base branch, then committing, pushing, and opening or updating the pull request.'
            : 'Agent Hub is creating a kanban ticket, committing, pushing, and opening a pull request.'}
        </Text>
        {message.created_at ? (
          <Text style={prStyles.timestamp}>{relativeTime(message.created_at)}</Text>
        ) : null}
      </View>
    </View>
  );
}

const shipStyles = StyleSheet.create({
  card: {
    width: '95%',
    backgroundColor: colors.purple900_40,
    borderWidth: 1,
    borderColor: 'rgba(126, 34, 206, 0.5)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.purple400,
  },
  subtext: {
    fontSize: 11,
    color: 'rgba(233, 213, 255, 0.7)',
    marginTop: 4,
    lineHeight: 16,
  },
});

function SystemPrCreatedMessage({ message }) {
  const meta = parsePrCreatedMetadata(message.metadata);
  const handleOpenPr = useCallback(() => {
    if (!meta?.prUrl) return;
    Linking.openURL(meta.prUrl).catch(() => {
      Alert.alert('Unable to open PR', 'The pull request link could not be opened.');
    });
  }, [meta]);

  if (!meta) {
    // Malformed metadata — render a minimal generic system callout so we
    // never crash the timeline on unexpected payloads. Mirrors the web
    // client's fallback in client/src/components/ChatMessage.jsx.
    return (
      <View style={prStyles.fallbackContainer}>
        <Text style={prStyles.fallbackText}>{message.content || 'System event'}</Text>
      </View>
    );
  }

  const prLabel = meta.prNumber ? `#${meta.prNumber}` : 'View PR';
  return (
    <View style={prStyles.container}>
      <View style={prStyles.card}>
        <View style={prStyles.headerRow}>
          <Ionicons name="git-pull-request" size={16} color={colors.emerald400} />
          <Text style={prStyles.headerText}>Pull request created from these changes</Text>
        </View>
        <View style={prStyles.metaRow}>
          <TouchableOpacity onPress={handleOpenPr} accessibilityRole="link">
            <Text style={prStyles.prLink}>{prLabel}</Text>
          </TouchableOpacity>
          {meta.commitSha ? (
            <View style={prStyles.shaPill}>
              <Text style={prStyles.shaText}>{shortSha(meta.commitSha)}</Text>
            </View>
          ) : null}
          {meta.commitTitle ? (
            <Text style={prStyles.commitTitle} numberOfLines={1}>
              {meta.commitTitle}
            </Text>
          ) : null}
        </View>
        {meta.cardTitle ? (
          <Text style={prStyles.cardLine}>
            Linked card: <Text style={prStyles.cardTitle}>{meta.cardTitle}</Text>
          </Text>
        ) : null}
        {message.created_at ? (
          <Text style={prStyles.timestamp}>{relativeTime(message.created_at)}</Text>
        ) : null}
      </View>
    </View>
  );
}

const prStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  card: {
    width: '95%',
    backgroundColor: colors.emerald900_40,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  headerText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.emerald400,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  prLink: {
    color: colors.emerald400,
    textDecorationLine: 'underline',
    fontSize: 14,
    fontWeight: '600',
  },
  shaPill: {
    backgroundColor: 'rgba(17, 24, 39, 0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  shaText: {
    color: colors.gray400,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  commitTitle: {
    color: colors.gray300,
    fontSize: 13,
    flexShrink: 1,
  },
  cardLine: {
    color: colors.gray500,
    fontSize: 11,
    marginTop: 6,
  },
  cardTitle: {
    color: colors.gray400,
  },
  timestamp: {
    color: colors.gray600,
    fontSize: 10,
    marginTop: 6,
  },
  fallbackContainer: {
    alignItems: 'center',
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  fallbackText: {
    fontSize: 11,
    fontStyle: 'italic',
    color: colors.gray500,
  },
});

function ChatMessage({
  message,
  agentColor,
  agentName,
  onDequeue,
  onEditQueued,
  onInterrupt,
  inFlightWhileStreaming = false,
  fromAgent,
  agents,
  sessionHandoffs,
  onOpenSession,
}) {
  if (message.role === 'system') {
    if (parseShipRequestedMetadata(message.metadata)) {
      return <SystemShipRequestedMessage message={message} />;
    }
    return <SystemPrCreatedMessage message={message} />;
  }
  const { isUser, isQueued, isInterrupted, showInFlightActions } = getUserMessageFlags(
    message,
    inFlightWhileStreaming,
  );
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const engineBadge = !isUser && message.engine ? ENGINE_BADGES[message.engine] : null;
  const modelLabel = !isUser && message.model
    ? message.model.replace('claude-', '').replace('-', ' ')
    : null;

  const displayContent = useMemo(() => {
    if (message.content === '(image attached)' && message.attachments) return '';
    // Only user bubbles carry `agenthub:ask:answer` payloads (mirrors web).
    if (isUser) return stripAskAnswerBlocks(message.content);
    return typeof message.content === 'string' ? message.content : message.content;
  }, [message.content, message.attachments, isUser]);

  // For assistant messages, extract any `<handoff>` block so the JSON wall
  // doesn't render as raw text. The block is shown as a HandoffCard instead.
  const assistantBlocks = useMemo(() => {
    if (isUser) return { stripped: message.content, handoff: null };
    return extractCoordinationBlocks(message.content);
  }, [isUser, message.content]);

  // Correlate the parsed block to the matching DB row so HandoffCard can
  // surface status (pending/delivered/failed) and a tappable "Open session"
  // link. Returns null when no rows are loaded yet — the card still renders
  // in that case, just without the link / status pill.
  const handoffRow = useMemo(
    () => (assistantBlocks.handoff ? pickHandoffRow(assistantBlocks.handoff, sessionHandoffs) : null),
    [assistantBlocks.handoff, sessionHandoffs],
  );

  // Long-press on any bubble copies its text to the system clipboard.
  // For assistant bubbles we copy the stripped (markdown) content so any
  // <handoff>/<delegate> JSON blocks don't pollute the paste target.
  const copyPayload = isUser ? displayContent : assistantBlocks.stripped;
  const copyEnabled = canCopy(copyPayload);
  const handleLongPress = useCallback(async () => {
    if (!copyEnabled) {
      notifyCopied(false);
      return;
    }
    const ok = await copyToClipboard(copyPayload);
    notifyCopied(ok);
  }, [copyPayload, copyEnabled]);

  // If a user message had nothing but an ask-answer payload (no prose, no
  // attachments, not queued), suppress the bubble entirely — the picker
  // already reflects the submission. Mirrors web's ChatMessage.jsx.
  if (
    isUser &&
    !displayContent &&
    !message.attachments &&
    !isQueued &&
    typeof message.content === 'string' &&
    message.content.includes('agenthub:ask:answer')
  ) {
    return null;
  }

  const rawReviewVerdict = !isUser ? parseRawReviewVerdictContent(displayContent) : null;
  if (rawReviewVerdict) {
    return null;
  }

  return (
    <View style={[styles.container, isUser ? styles.containerUser : styles.containerAssistant]}>
      <Pressable
        onLongPress={handleLongPress}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel="Long press to copy message"
        style={({ pressed }) => [
          styles.bubble,
          isUser ? (isQueued ? styles.bubbleQueued : styles.bubbleUser) : styles.bubbleAssistant,
          pressed && styles.bubblePressed,
        ]}
      >
        {/* Assistant header */}
        {!isUser && (
          <View style={styles.assistantHeader}>
            <View style={[styles.headerDot, { backgroundColor: agentColor }]} />
            <Text style={styles.headerLabel}>{resolveAgentDisplayName(message, agentName)}</Text>
            {engineBadge && (
              <View style={styles.engineBadgeRow}>
                <View style={[styles.engineDot, { backgroundColor: engineBadge.color }]} />
                <Text style={styles.engineBadge}>{engineBadge.label}</Text>
              </View>
            )}
            {modelLabel && (
              <Text style={styles.modelLabel}>· {modelLabel}</Text>
            )}
          </View>
        )}

        {/* Image attachments */}
        <MessageAttachments attachments={message.attachments} />

        {/* Content */}
        {isUser ? (
          <>
            {isQueued && (
              <View style={styles.queuedBadge}>
                <View style={styles.queuedDot} />
                <Text style={styles.queuedText}>Queued</Text>
              </View>
            )}
            {editing ? (
              <View style={styles.editContainer}>
                <TextInput
                  style={styles.editInput}
                  value={editText}
                  onChangeText={setEditText}
                  multiline
                  autoFocus
                />
                <View style={styles.editActions}>
                  <TouchableOpacity
                    style={styles.editSaveBtn}
                    onPress={() => { onEditQueued?.(message.id, editText); setEditing(false); }}
                  >
                    <Text style={styles.editSaveBtnText}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setEditing(false); setEditText(message.content); }}>
                    <Text style={styles.editCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              displayContent ? (
                <Text style={styles.userText} selectable>
                  {displayContent}
                </Text>
              ) : null
            )}
            {isQueued && !editing && (
              <View style={styles.queuedActions}>
                <TouchableOpacity onPress={() => setEditing(true)}>
                  <Text style={styles.queuedActionText}>Edit</Text>
                </TouchableOpacity>
                {showInFlightActions && onInterrupt && (
                  <TouchableOpacity onPress={() => onInterrupt(message)}>
                    <Text style={[styles.queuedActionText, { color: '#fbbf24' }]}>Interrupt</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() =>
                    onDequeue?.(message.id, showInFlightActions ? { cancelStream: true } : undefined)
                  }
                >
                  <Text style={[styles.queuedActionText, { color: colors.red400 }]}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        ) : (
          <>
            {assistantBlocks.stripped ? (
              <Markdown style={markdownStyles} rules={selectableMarkdownRules}>
                {assistantBlocks.stripped}
              </Markdown>
            ) : null}
            {assistantBlocks.handoff && (
              <HandoffCard
                toAgentId={assistantBlocks.handoff.toAgent}
                note={assistantBlocks.handoff.note}
                fromAgent={fromAgent}
                agents={agents}
                handoff={handoffRow}
                onOpenSession={onOpenSession}
              />
            )}
          </>
        )}

        {/* Timestamp */}
        <Text style={[styles.timestamp, isUser ? styles.timestampUser : styles.timestampAssistant]}>
          {message.created_at && relativeTime(message.created_at)}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  containerUser: {
    justifyContent: 'flex-end',
  },
  containerAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 16,
  },
  bubblePressed: {
    opacity: 0.7,
  },
  bubbleUser: {
    backgroundColor: colors.blue600,
    borderBottomRightRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bubbleAssistant: {
    backgroundColor: colors.gray800,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  assistantHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  headerLabel: {
    fontSize: 11,
    color: colors.gray500,
    fontWeight: '500',
  },
  engineBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  engineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  engineBadge: {
    fontSize: 10,
    color: colors.gray600,
  },
  modelLabel: {
    fontSize: 10,
    color: colors.gray600,
  },
  userText: {
    color: colors.white,
    fontSize: 14,
    lineHeight: 20,
  },
  timestamp: {
    fontSize: 10,
    marginTop: 4,
  },
  timestampUser: {
    color: colors.blue300,
  },
  timestampAssistant: {
    color: colors.gray600,
  },
  bubbleQueued: {
    backgroundColor: 'rgba(59, 130, 246, 0.3)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    borderBottomRightRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  queuedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  queuedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.blue400,
  },
  queuedText: {
    fontSize: 10,
    color: colors.blue400,
    fontWeight: '600',
  },
  queuedActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6,
  },
  queuedActionText: {
    fontSize: 11,
    color: colors.gray400,
  },
  editContainer: {
    marginTop: 4,
  },
  editInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.4)',
    borderRadius: 8,
    padding: 8,
    color: colors.white,
    fontSize: 14,
    minHeight: 40,
    maxHeight: 120,
  },
  editActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
    alignItems: 'center',
  },
  editSaveBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  editSaveBtnText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  editCancelText: {
    color: colors.gray500,
    fontSize: 12,
  },
});

export default memo(ChatMessage);
