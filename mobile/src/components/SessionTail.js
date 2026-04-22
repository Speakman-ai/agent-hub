import React, { useState, useEffect, useMemo, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { isFileModifyingTool } from '../utils/diff';
import { eventsToBlocks, summarizeToolInput } from '../utils/sessionTailBlocks';
import { shouldAutoLoadEvents } from '../utils/shouldAutoLoadEvents';
import { applyLazyMessageEventsResult } from '../utils/sessionTailEventsLoad.js';
import DiffView from './DiffView';
import SubagentCard from './SubagentCard';
import AskUserQuestion from './AskUserQuestion';

const TOOL_COLORS = {
  Bash: colors.emerald400,
  Read: colors.blue400,
  Write: '#f43f5e',
  Edit: '#f59e0b',
  Grep: colors.purple500,
  Glob: colors.purple500,
  WebFetch: '#06b6d4',
  WebSearch: '#06b6d4',
  Agent: '#8b5cf6',
};

function SessionTail({
  message,
  events,
  agentColor,
  streaming,
  onEventsLoaded,
  onAskSubmit,
  askSubmittedIds,
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedBlocks, setExpandedBlocks] = useState({});
  const [loading, setLoading] = useState(false);
  /** True after a lazy events GET fails — never cache [] on failure (web SessionTail parity). */
  const [eventsFetchFailed, setEventsFetchFailed] = useState(false);
  const [eventsFetchRetry, setEventsFetchRetry] = useState(0);

  useEffect(() => {
    setEventsFetchFailed(false);
    setEventsFetchRetry(0);
  }, [message?.id]);

  // Eagerly lazy-load events for historical (non-streaming) assistant messages
  // so any persisted `ask_user_question` events surface their picker without
  // the user having to expand the timeline. Mirrors the web SessionTail's
  // on-mount fetch (see client/src/components/SessionTail.jsx).
  useEffect(() => {
    if (!shouldAutoLoadEvents({ messageId: message?.id, streaming, events })) return;
    if (loading) return;
    if (eventsFetchFailed) return;
    let cancelled = false;
    setLoading(true);
    api
      .getMessageEvents(message.id)
      .then((data) => {
        applyLazyMessageEventsResult({
          cancelled,
          ok: true,
          data,
          messageId: message.id,
          onEventsLoaded,
        });
        if (!cancelled) setEventsFetchFailed(false);
      })
      .catch(() => {
        applyLazyMessageEventsResult({
          cancelled,
          ok: false,
          data: null,
          messageId: message.id,
          onEventsLoaded,
        });
        if (!cancelled) setEventsFetchFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, streaming, events, eventsFetchFailed, eventsFetchRetry]);

  // Lazy-load events on expand (covers the edge case where a user manually
  // expands before the auto-load effect has run, e.g. mid-fetch retries).
  useEffect(() => {
    if (expanded && !events && !loading) {
      setLoading(true);
      api
        .getMessageEvents(message.id)
        .then((data) => {
          applyLazyMessageEventsResult({
            cancelled: false,
            ok: true,
            data,
            messageId: message.id,
            onEventsLoaded,
          });
          setEventsFetchFailed(false);
        })
        .catch(() => {
          applyLazyMessageEventsResult({
            cancelled: false,
            ok: false,
            data: null,
            messageId: message.id,
            onEventsLoaded,
          });
          setEventsFetchFailed(true);
        })
        .finally(() => setLoading(false));
    }
  }, [expanded, events, message.id, loading, onEventsLoaded, eventsFetchRetry]);

  const blocks = useMemo(() => eventsToBlocks(events), [events]);

  const askBlocks = useMemo(() => blocks.filter((b) => b.kind === 'ask_question'), [blocks]);

  const toolCount = blocks.filter((b) => b.kind === 'tool' || b.kind === 'subagent').length;
  const thinkingCount = blocks.filter((b) => b.kind === 'thinking').length;
  const resultBlock = blocks.find((b) => b.kind === 'result');

  if (!expanded) {
    const hasMeta = toolCount > 0 || thinkingCount > 0 || resultBlock;
    if (!hasMeta && !events && askBlocks.length === 0) {
      if (eventsFetchFailed) {
        return (
          <View style={styles.retryBanner}>
            <TouchableOpacity
              onPress={() => {
                setEventsFetchFailed(false);
                setEventsFetchRetry((n) => n + 1);
              }}
              accessibilityRole="button"
            >
              <Text style={styles.retryText}>Could not load timeline. Tap to retry.</Text>
            </TouchableOpacity>
          </View>
        );
      }
      return null;
    }

    return (
      <View>
        {askBlocks.map((b) => (
          <AskUserQuestion
            key={b.askId}
            askId={b.askId}
            questions={b.questions || []}
            onSubmit={(text) => onAskSubmit?.(b.askId, text)}
            submitted={askSubmittedIds?.has(b.askId)}
          />
        ))}
        {hasMeta && (
          <TouchableOpacity style={styles.summaryBar} onPress={() => setExpanded(true)}>
            <View style={[styles.barDot, { backgroundColor: agentColor || colors.gray500 }]} />
            {toolCount > 0 && (
              <Text style={styles.summaryText}>
                {'\uD83D\uDD27'} {toolCount} tool{toolCount > 1 ? 's' : ''}
              </Text>
            )}
            {thinkingCount > 0 && <Text style={styles.summaryText}>{'\uD83D\uDCAD'} thinking</Text>}
            {resultBlock && (
              <Text style={styles.summaryText}>
                {'\u23F1'} {((resultBlock.durationMs || 0) / 1000).toFixed(1)}s
                {resultBlock.costUsd ? ` \u00B7 $${resultBlock.costUsd.toFixed(4)}` : ''}
              </Text>
            )}
            <Text style={styles.expandHint}>{'\u25B8'}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={styles.tailContainer}>
      <TouchableOpacity style={styles.collapseBar} onPress={() => setExpanded(false)}>
        <View style={[styles.barDot, { backgroundColor: agentColor || colors.gray500 }]} />
        <Text style={styles.collapseText}>Event Timeline</Text>
        <Text style={styles.expandHint}>{'\u25BE'}</Text>
      </TouchableOpacity>

      {askBlocks.map((b) => (
        <AskUserQuestion
          key={b.askId}
          askId={b.askId}
          questions={b.questions || []}
          onSubmit={(text) => onAskSubmit?.(b.askId, text)}
          submitted={askSubmittedIds?.has(b.askId)}
        />
      ))}

      {loading && <Text style={styles.loadingText}>Loading events...</Text>}

      {eventsFetchFailed && !loading && (
        <TouchableOpacity
          style={styles.retryBanner}
          onPress={() => {
            setEventsFetchFailed(false);
            setEventsFetchRetry((n) => n + 1);
          }}
        >
          <Text style={styles.retryText}>Could not load timeline. Tap to retry.</Text>
        </TouchableOpacity>
      )}

      {blocks.map((block, idx) => {
        const isBlockExpanded = expandedBlocks[idx];
        const toggle = () => setExpandedBlocks((prev) => ({ ...prev, [idx]: !prev[idx] }));

        switch (block.kind) {
          case 'thinking':
            return (
              <TouchableOpacity key={idx} style={styles.eventRow} onPress={toggle}>
                <Text style={styles.eventIcon}>{'\uD83D\uDCAD'}</Text>
                <View style={styles.eventContent}>
                  <Text style={styles.eventLabel}>Thinking</Text>
                  {isBlockExpanded ? (
                    <ScrollView style={styles.expandedContent} nestedScrollEnabled>
                      <Text style={styles.thinkingText}>{block.text}</Text>
                    </ScrollView>
                  ) : (
                    <Text style={styles.eventPreview} numberOfLines={1}>
                      {block.text.slice(0, 80)}…
                    </Text>
                  )}
                </View>
                <Text style={styles.expandIcon}>{isBlockExpanded ? '\u25BE' : '\u25B8'}</Text>
              </TouchableOpacity>
            );

          case 'subagent':
            return (
              <View key={idx} style={styles.cardWrapper}>
                <SubagentCard use={block.use} result={block.result} />
              </View>
            );

          case 'tool': {
            const toolColor = TOOL_COLORS[block.tool] || colors.gray400;
            const hasResult = block.result;
            const isError = block.result?.isError;
            const showDiffLayout = isFileModifyingTool(block.tool) && block.input;

            // For Edit/Write: render the diff card inline (always visible),
            // matching the web behaviour. Keep the diff visible when the tool
            // result is an error so the attempted change and the CLI message stay
            // aligned (same fix as web SessionTail ToolCard).
            if (showDiffLayout) {
              return (
                <View key={idx} style={[styles.diffWrapper, isError && styles.diffWrapperError]}>
                  <View style={styles.diffHeader}>
                    <View style={[styles.toolStripe, { backgroundColor: toolColor }]} />
                    <Text style={[styles.toolName, { color: toolColor }]}>{block.tool}</Text>
                    {!hasResult && <Text style={styles.runningBadge}>running…</Text>}
                    {hasResult && isError && <Text style={styles.errorBadge}>error</Text>}
                  </View>
                  <DiffView tool={block.tool} input={block.input} />
                  {hasResult && isError && block.result?.output ? (
                    <View style={styles.diffErrorOutput}>
                      <Text style={styles.codeLabel}>error</Text>
                      <ScrollView nestedScrollEnabled style={styles.diffErrorScroll}>
                        <Text style={[styles.codeText, { color: colors.red400 }]}>
                          {block.result.output.length > 4000
                            ? `${block.result.output.slice(0, 4000)}…`
                            : block.result.output}
                        </Text>
                      </ScrollView>
                    </View>
                  ) : null}
                </View>
              );
            }

            const toolSummary = summarizeToolInput(block.tool, block.input);

            return (
              <TouchableOpacity
                key={idx}
                style={[styles.eventRow, isError && styles.errorEventRow]}
                onPress={toggle}
              >
                <View style={[styles.toolStripe, { backgroundColor: toolColor }]} />
                <View style={styles.eventContent}>
                  <View style={styles.toolHeader}>
                    <Text style={[styles.toolName, { color: toolColor }]}>{block.tool}</Text>
                    {!hasResult && <Text style={styles.runningBadge}>running…</Text>}
                    {isError && <Text style={styles.errorBadge}>error</Text>}
                  </View>
                  {toolSummary ? (
                    <Text style={styles.eventPreview} numberOfLines={1}>
                      {toolSummary}
                    </Text>
                  ) : null}
                  {isBlockExpanded && (
                    <ScrollView style={styles.expandedContent} nestedScrollEnabled>
                      {block.input && (
                        <View style={styles.codeBox}>
                          <Text style={styles.codeLabel}>Input</Text>
                          <Text style={styles.codeText}>
                            {typeof block.input === 'string'
                              ? block.input
                              : JSON.stringify(block.input, null, 2)}
                          </Text>
                        </View>
                      )}
                      {block.result?.output && (
                        <View style={[styles.codeBox, isError && styles.errorCodeBox]}>
                          <Text style={styles.codeLabel}>Output</Text>
                          <Text style={[styles.codeText, isError && { color: colors.red400 }]}>
                            {block.result.output.slice(0, 2000)}
                          </Text>
                        </View>
                      )}
                    </ScrollView>
                  )}
                </View>
                <Text style={styles.expandIcon}>{isBlockExpanded ? '\u25BE' : '\u25B8'}</Text>
              </TouchableOpacity>
            );
          }

          case 'ask_question':
            // Rendered above the timeline via <AskUserQuestion> so the
            // picker is always reachable regardless of expand/collapse.
            return null;

          case 'checkpoint':
            return (
              <View key={idx} style={styles.checkpointRow}>
                <Text style={styles.checkpointText}>
                  {'\uD83D\uDD16'} checkpoint
                  {block.uuid ? ` · ${String(block.uuid).slice(0, 10)}…` : ''}
                  {typeof block.turnIndex === 'number' ? ` · turn ${block.turnIndex}` : ''}
                </Text>
              </View>
            );

          case 'rate_limit': {
            const seconds = block.retryAfterMs ? Math.ceil(block.retryAfterMs / 1000) : null;
            return (
              <View key={idx} style={styles.rateLimitRow}>
                <Text style={styles.rateLimitText}>
                  {'\u23F1'} rate limited
                  {seconds ? ` · retry in ${seconds}s` : ''}
                  {block.message ? ` · ${block.message}` : ''}
                </Text>
              </View>
            );
          }

          case 'system':
            return (
              <View key={idx} style={styles.systemRow}>
                <Text style={styles.systemText} numberOfLines={1}>
                  {block.model || 'unknown model'}
                  {block.cwd ? ` · ${block.cwd}` : ''}
                </Text>
              </View>
            );

          case 'result': {
            const parts = [];
            if (typeof block.durationMs === 'number') {
              parts.push(`${(block.durationMs / 1000).toFixed(1)}s`);
            }
            if (typeof block.costUsd === 'number') {
              parts.push(`$${block.costUsd.toFixed(4)}`);
            }
            if (typeof block.numTurns === 'number') {
              parts.push(`${block.numTurns} turn${block.numTurns === 1 ? '' : 's'}`);
            }
            return (
              <View key={idx} style={styles.resultRow}>
                <Text style={[styles.resultText, block.isError && { color: colors.red400 }]}>
                  {block.isError ? '\u26A0 error' : '\u2705 done'}
                  {parts.length > 0 ? `  \u00B7  ${parts.join('  \u00B7  ')}` : ''}
                </Text>
              </View>
            );
          }

          case 'error':
            return (
              <View key={idx} style={styles.errorRow}>
                <Text style={styles.errorIcon}>{'\u26A0'}</Text>
                <Text style={styles.errorMessage}>{block.message}</Text>
              </View>
            );

          case 'text':
            // Text bubbles are rendered by ChatMessage; skip inside the tail.
            return null;

          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 2,
    marginBottom: 4,
  },
  barDot: { width: 6, height: 6, borderRadius: 3 },
  summaryText: { fontSize: 11, color: colors.gray500 },
  expandHint: { color: colors.gray600, fontSize: 10, marginLeft: 'auto' },
  collapseBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  collapseText: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.gray400 },
  tailContainer: {
    backgroundColor: colors.gray900,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    marginHorizontal: 12,
    marginTop: 2,
    marginBottom: 8,
    overflow: 'hidden',
  },
  loadingText: { fontSize: 11, color: colors.gray600, padding: 12, fontStyle: 'italic' },
  retryBanner: {
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    backgroundColor: 'rgba(120, 53, 15, 0.2)',
  },
  retryText: { fontSize: 11, color: colors.amber400, textAlign: 'center' },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  errorEventRow: { backgroundColor: '#1a0000' },
  eventIcon: { fontSize: 12, marginTop: 2 },
  eventContent: { flex: 1 },
  eventLabel: { fontSize: 12, fontWeight: '600', color: colors.gray400, marginBottom: 2 },
  eventPreview: { fontSize: 11, color: colors.gray600 },
  expandIcon: { color: colors.gray600, fontSize: 10, marginTop: 4 },
  toolStripe: { width: 3, borderRadius: 2, minHeight: 20, marginTop: 2 },
  toolHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  toolName: { fontSize: 12, fontWeight: '700' },
  runningBadge: { fontSize: 10, color: colors.blue400, fontStyle: 'italic' },
  errorBadge: { fontSize: 10, color: colors.red400, fontWeight: '600' },
  expandedContent: { maxHeight: 260, marginTop: 6 },
  thinkingText: { fontSize: 11, color: colors.gray500, fontStyle: 'italic', lineHeight: 16 },
  codeBox: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    padding: 8,
    marginTop: 4,
  },
  errorCodeBox: { borderWidth: 1, borderColor: colors.red600 },
  codeLabel: { fontSize: 10, color: colors.gray500, marginBottom: 4, fontWeight: '600' },
  codeText: { fontSize: 11, color: colors.gray300, fontFamily: 'monospace' },
  cardWrapper: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  diffWrapper: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 4,
  },
  diffWrapperError: {
    backgroundColor: 'rgba(69, 10, 10, 0.15)',
    borderLeftWidth: 2,
    borderLeftColor: colors.red600,
  },
  diffErrorOutput: {
    marginTop: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(220, 38, 38, 0.45)',
    backgroundColor: 'rgba(69, 10, 10, 0.35)',
    padding: 8,
  },
  diffErrorScroll: { maxHeight: 200 },
  diffHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkpointRow: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: 'rgba(31, 41, 55, 0.4)',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  checkpointText: { fontSize: 10, color: colors.gray600, fontFamily: 'monospace' },
  rateLimitRow: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(120, 53, 15, 0.25)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(120, 53, 15, 0.4)',
  },
  rateLimitText: { fontSize: 11, color: colors.amber400, fontFamily: 'monospace' },
  systemRow: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: 'rgba(17, 24, 39, 0.6)',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  systemText: { fontSize: 10, color: colors.gray500, fontFamily: 'monospace' },
  resultRow: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  resultText: { fontSize: 11, color: colors.gray500 },
  errorRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1a0000',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  errorIcon: { fontSize: 12 },
  errorMessage: { fontSize: 12, color: colors.red400, flex: 1 },
});

export default memo(SessionTail);
