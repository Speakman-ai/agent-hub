import React, { useState, useEffect, useMemo, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

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

function eventsToBlocks(events) {
  if (!events || events.length === 0) return [];

  // Index tool results by toolUseId
  const resultIndex = {};
  for (const e of events) {
    if (e.event?.type === 'tool_result') {
      resultIndex[e.event.toolUseId] = e.event;
    }
  }

  const blocks = [];
  let textBuffer = '';

  const flushText = () => {
    if (textBuffer.trim()) {
      blocks.push({ kind: 'text', content: textBuffer.trim() });
    }
    textBuffer = '';
  };

  for (const e of events) {
    const evt = e.event;
    if (!evt) continue;

    switch (evt.type) {
      case 'thinking':
        flushText();
        blocks.push({ kind: 'thinking', text: evt.text || '' });
        break;
      case 'tool_use':
        flushText();
        blocks.push({
          kind: 'tool',
          tool: evt.tool,
          input: evt.input,
          result: resultIndex[evt.id] || null,
        });
        break;
      case 'tool_result':
        // Already indexed -- skip orphan renders
        break;
      case 'assistant_text':
        if (!evt.partial) {
          textBuffer = evt.text || '';
        } else if (!textBuffer) {
          textBuffer = evt.text || '';
        }
        break;
      case 'result':
        flushText();
        blocks.push({ kind: 'result', durationMs: evt.durationMs, costUsd: evt.costUsd, numTurns: evt.numTurns, isError: evt.isError });
        break;
      case 'error':
        flushText();
        blocks.push({ kind: 'error', message: evt.message || 'Unknown error' });
        break;
      case 'system':
        // Skip system events in mobile view
        break;
      default:
        break;
    }
  }
  flushText();
  return blocks;
}

function SessionTail({ message, events, agentColor, onEventsLoaded }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedBlocks, setExpandedBlocks] = useState({});
  const [loading, setLoading] = useState(false);

  // Lazy load events when expanded
  useEffect(() => {
    if (expanded && !events && !loading) {
      setLoading(true);
      api.getMessageEvents(message.id)
        .then((data) => {
          const mapped = (data || []).map((e) => ({ seq: e.seq, event: typeof e.event === 'string' ? JSON.parse(e.event) : e.event }));
          onEventsLoaded?.(message.id, mapped);
        })
        .catch(() => onEventsLoaded?.(message.id, []))
        .finally(() => setLoading(false));
    }
  }, [expanded, events, message.id, loading, onEventsLoaded]);

  const blocks = useMemo(() => eventsToBlocks(events), [events]);

  // Count tools for summary
  const toolCount = blocks.filter((b) => b.kind === 'tool').length;
  const thinkingCount = blocks.filter((b) => b.kind === 'thinking').length;
  const resultBlock = blocks.find((b) => b.kind === 'result');

  if (!expanded) {
    // Compact summary bar
    const hasMeta = toolCount > 0 || thinkingCount > 0 || resultBlock;
    if (!hasMeta && !events) return null; // Nothing to show yet

    return (
      <TouchableOpacity style={styles.summaryBar} onPress={() => setExpanded(true)}>
        <View style={[styles.barDot, { backgroundColor: agentColor || colors.gray500 }]} />
        {toolCount > 0 && (
          <Text style={styles.summaryText}>{'\uD83D\uDD27'} {toolCount} tool{toolCount > 1 ? 's' : ''}</Text>
        )}
        {thinkingCount > 0 && (
          <Text style={styles.summaryText}>{'\uD83D\uDCAD'} thinking</Text>
        )}
        {resultBlock && (
          <Text style={styles.summaryText}>
            {'\u23F1'} {((resultBlock.durationMs || 0) / 1000).toFixed(1)}s
            {resultBlock.costUsd ? ` \u00B7 $${resultBlock.costUsd.toFixed(4)}` : ''}
          </Text>
        )}
        <Text style={styles.expandHint}>{'\u25B8'}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.tailContainer}>
      <TouchableOpacity style={styles.collapseBar} onPress={() => setExpanded(false)}>
        <View style={[styles.barDot, { backgroundColor: agentColor || colors.gray500 }]} />
        <Text style={styles.collapseText}>Event Timeline</Text>
        <Text style={styles.expandHint}>{'\u25BE'}</Text>
      </TouchableOpacity>

      {loading && <Text style={styles.loadingText}>Loading events...</Text>}

      {blocks.map((block, idx) => {
        const isBlockExpanded = expandedBlocks[idx];

        switch (block.kind) {
          case 'thinking':
            return (
              <TouchableOpacity
                key={idx}
                style={styles.eventRow}
                onPress={() => setExpandedBlocks((prev) => ({ ...prev, [idx]: !prev[idx] }))}
              >
                <Text style={styles.eventIcon}>{'\uD83D\uDCAD'}</Text>
                <View style={styles.eventContent}>
                  <Text style={styles.eventLabel}>Thinking</Text>
                  {isBlockExpanded ? (
                    <ScrollView style={styles.expandedContent} nestedScrollEnabled>
                      <Text style={styles.thinkingText}>{block.text}</Text>
                    </ScrollView>
                  ) : (
                    <Text style={styles.eventPreview} numberOfLines={1}>
                      {block.text.slice(0, 80)}...
                    </Text>
                  )}
                </View>
                <Text style={styles.expandIcon}>{isBlockExpanded ? '\u25BE' : '\u25B8'}</Text>
              </TouchableOpacity>
            );

          case 'tool': {
            const toolColor = TOOL_COLORS[block.tool] || colors.gray400;
            const hasResult = block.result;
            const isError = block.result?.isError;

            // Build a concise tool summary
            let toolSummary = '';
            if (block.input) {
              if (typeof block.input === 'string') {
                toolSummary = block.input.slice(0, 60);
              } else if (block.input.command) {
                toolSummary = block.input.command.slice(0, 60);
              } else if (block.input.file_path) {
                toolSummary = block.input.file_path;
              } else if (block.input.pattern) {
                toolSummary = `/${block.input.pattern}/`;
              } else if (block.input.prompt) {
                toolSummary = block.input.prompt.slice(0, 60);
              }
            }

            return (
              <TouchableOpacity
                key={idx}
                style={[styles.eventRow, isError && styles.errorEventRow]}
                onPress={() => setExpandedBlocks((prev) => ({ ...prev, [idx]: !prev[idx] }))}
              >
                <View style={[styles.toolStripe, { backgroundColor: toolColor }]} />
                <View style={styles.eventContent}>
                  <View style={styles.toolHeader}>
                    <Text style={[styles.toolName, { color: toolColor }]}>{block.tool}</Text>
                    {!hasResult && <Text style={styles.runningBadge}>running...</Text>}
                    {isError && <Text style={styles.errorBadge}>error</Text>}
                  </View>
                  {toolSummary ? (
                    <Text style={styles.eventPreview} numberOfLines={1}>{toolSummary}</Text>
                  ) : null}
                  {isBlockExpanded && (
                    <ScrollView style={styles.expandedContent} nestedScrollEnabled>
                      {block.input && (
                        <View style={styles.codeBox}>
                          <Text style={styles.codeLabel}>Input</Text>
                          <Text style={styles.codeText}>
                            {typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)}
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

          case 'result':
            return (
              <View key={idx} style={styles.resultRow}>
                <Text style={styles.resultText}>
                  {'\u23F1'} {((block.durationMs || 0) / 1000).toFixed(1)}s
                  {block.costUsd ? `  \u00B7  $${block.costUsd.toFixed(4)}` : ''}
                  {block.numTurns ? `  \u00B7  ${block.numTurns} turn${block.numTurns > 1 ? 's' : ''}` : ''}
                </Text>
              </View>
            );

          case 'error':
            return (
              <View key={idx} style={styles.errorRow}>
                <Text style={styles.errorIcon}>{'\u26A0'}</Text>
                <Text style={styles.errorMessage}>{block.message}</Text>
              </View>
            );

          case 'text':
            // Skip text blocks -- they're already shown in ChatMessage
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
  expandedContent: { maxHeight: 200, marginTop: 6 },
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
