import React, { useState, useEffect, useMemo, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { isFileModifyingTool } from '../utils/diff';
import { eventsToBlocks, describeTool } from '../utils/sessionTailBlocks';
import { shouldAutoLoadEvents } from '../utils/shouldAutoLoadEvents';
import { applyLazyMessageEventsResult } from '../utils/sessionTailEventsLoad';
import { deriveStreamingBrowserHint, mergeBrowserTimelineRows, } from '@shared/utils/browserActivityTimeline';
import { formatSystemBannerModelLine } from '@shared/utils/systemBannerModel';
import DiffView from './DiffView';
import SubagentCard from './SubagentCard';
import AskUserQuestion from './AskUserQuestion';
import BrowserActivityPanel from './BrowserActivityPanel';
const TOOL_COLORS: Record<string, any> = {
    Bash: colors.emerald400,
    Read: colors.blue400,
    Write: '#f43f5e',
    Edit: '#f59e0b',
    Grep: colors.purple500,
    Glob: colors.purple500,
    WebFetch: '#06b6d4',
    WebSearch: '#06b6d4',
    Agent: '#8b5cf6',
    Task: '#8b5cf6',
    TodoWrite: colors.gray400,
    ExitPlanMode: '#a78bfa',
    NotebookRead: colors.blue400,
    NotebookEdit: '#f59e0b',
};
const TODO_STATUS_GLYPH: Record<string, any> = {
    completed: { mark: '\u2713', color: colors.emerald500 },
    in_progress: { mark: '\u25D0', color: colors.blue400 },
    cancelled: { mark: '\u2715', color: colors.gray500 },
    pending: { mark: '\u25CB', color: colors.gray500 },
};
function ExploredChip({ items }: any) {
    const [open, setOpen] = useState(false);
    const counts = items.reduce((acc: any, it: any) => {
        const t = it.use?.tool;
        if (t === 'Read' || t === 'NotebookRead')
            acc.files += 1;
        else if (t === 'Grep')
            acc.searches += 1;
        else if (t === 'Glob')
            acc.globs += 1;
        else if (t === 'WebFetch' || t === 'WebSearch')
            acc.web += 1;
        return acc;
    }, { files: 0, searches: 0, globs: 0, web: 0 });
    const parts = [];
    if (counts.files)
        parts.push(`${counts.files} file${counts.files === 1 ? '' : 's'}`);
    if (counts.searches)
        parts.push(`${counts.searches} search${counts.searches === 1 ? '' : 'es'}`);
    if (counts.globs)
        parts.push(`${counts.globs} glob${counts.globs === 1 ? '' : 's'}`);
    if (counts.web)
        parts.push(`${counts.web} web`);
    const summary = parts.length > 0 ? parts.join(', ') : `${items.length} items`;
    return (<View style={exploredStyles.wrap}>
      <TouchableOpacity style={exploredStyles.header} onPress={() => setOpen((v: any) => !v)} accessibilityRole="button" testID="explored-chip">
        <Text style={exploredStyles.glyph}>{'Dir'}</Text>
        <Text style={exploredStyles.label}>Explored</Text>
        <Text style={exploredStyles.summary} numberOfLines={1}>
          {summary}
        </Text>
        <Text style={exploredStyles.chevron}>{open ? '\u25BE' : '\u25B8'}</Text>
      </TouchableOpacity>
      {open ? (<View style={exploredStyles.list}>
          {items.map((it: any, i: any) => {
                const d = describeTool(it.use?.tool, it.use?.input);
                return (<View key={`ex${i}`} style={exploredStyles.listRow}>
                <Text style={exploredStyles.toolTag}>{it.use?.tool}</Text>
                <Text style={exploredStyles.listHeadline} numberOfLines={2}>
                  {d.headline}
                </Text>
              </View>);
            })}
        </View>) : null}
    </View>);
}
function TodoListCard({ use, result }: any) {
    const todos = Array.isArray(use?.input?.todos) ? use.input.todos : [];
    const done = todos.filter((t: any) => t?.status === 'completed').length;
    const total = todos.length;
    const errored = result?.isError;
    const stillRunning = !result;
    const [open, setOpen] = useState(false);
    const maxCollapsed = 4;
    const activeOnly = todos.filter((t: any) => t?.status !== 'completed' && t?.status !== 'cancelled');
    let visible = open ? todos : activeOnly.slice(0, maxCollapsed);
    if (!open && visible.length === 0 && total > 0) {
        const terminal = todos.filter((t: any) => t?.status === 'completed' || t?.status === 'cancelled');
        visible = terminal.slice(-maxCollapsed);
    }
    return (<View style={todoStyles.card}>
      <TouchableOpacity style={todoStyles.header} onPress={() => setOpen((v: any) => !v)} accessibilityRole="button" testID="todo-list-toggle">
        <Text style={todoStyles.icon}>{'\u2714'}</Text>
        <Text style={todoStyles.title}>
          {done} of {total} Done
        </Text>
        <Text style={todoStyles.hint}>{open ? '· Hide' : '· View all'}</Text>
        {stillRunning ? <Text style={todoStyles.running}>running…</Text> : null}
        {!stillRunning && errored ? <Text style={todoStyles.err}>error</Text> : null}
      </TouchableOpacity>
      {todos.length > 0 ? (<View style={todoStyles.list}>
          {visible.map((t: any, i: any) => {
                const g = TODO_STATUS_GLYPH[t?.status] || TODO_STATUS_GLYPH.pending;
                const completed = t?.status === 'completed';
                const cancelled = t?.status === 'cancelled';
                return (<View key={`todo${i}`} style={todoStyles.row}>
                <Text style={[todoStyles.glyph, { color: g.color }]}>{g.mark}</Text>
                <Text style={[
                        todoStyles.content,
                        completed && todoStyles.contentDone,
                        cancelled && todoStyles.contentCancelled,
                    ]} numberOfLines={3}>
                  {t?.content || '(untitled)'}
                </Text>
              </View>);
            })}
        </View>) : null}
    </View>);
}
const planMarkdownStyles = {
    body: { color: colors.gray200, fontSize: 13, lineHeight: 19 },
    paragraph: { marginTop: 2, marginBottom: 4 },
    bullet_list: { marginTop: 2, marginBottom: 4 },
    code_inline: {
        backgroundColor: colors.gray800,
        color: colors.emerald400,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 4,
        fontSize: 12,
    },
};
function PlanProposalCard({ use, result }: any) {
    const [open, setOpen] = useState(true);
    const planText = typeof use?.input?.plan === 'string' ? use.input.plan : '';
    const stillRunning = !result;
    const declined = !!result?.isError;
    const summary = planText
        .split('\n')
        .find((l: any) => l.trim())
        ?.replace(/^#+\s*/, '')
        ?.slice(0, 120);
    return (<View style={planStyles.card}>
      <TouchableOpacity style={planStyles.header} onPress={() => setOpen((v: any) => !v)}>
        <Text style={planStyles.title}>Plan proposal</Text>
        <Text style={planStyles.summary} numberOfLines={1}>
          {summary || '(empty plan)'}
        </Text>
        {stillRunning ? <Text style={planStyles.running}>running…</Text> : null}
        {!stillRunning && declined ? (<Text style={planStyles.await}>awaiting review</Text>) : null}
        {!stillRunning && !declined ? <Text style={planStyles.approved}>approved</Text> : null}
        <Text style={planStyles.chevron}>{open ? '\u25BE' : '\u25B8'}</Text>
      </TouchableOpacity>
      {open ? (<View style={planStyles.body}>
          {planText ? (<Markdown style={planMarkdownStyles as any}>{planText}</Markdown>) : (<Text style={planStyles.empty}>(empty plan)</Text>)}
          {!stillRunning && declined ? (<Text style={planStyles.note}>
              This session is in ask mode (plan-only). Review the proposal and turn ask mode off in
              the session header if you want the agent to execute it.
            </Text>) : null}
        </View>) : null}
    </View>);
}
function formatToolInput(input: any) {
    if (input == null)
        return '';
    if (typeof input === 'string')
        return input;
    try {
        return JSON.stringify(input, null, 2);
    }
    catch {
        return String(input);
    }
}
function SessionTail({ message, events, agentColor, streaming, onEventsLoaded, onAskSubmit, askSubmittedIds, browserScreenshots = {}, }: any) {
    const [expanded, setExpanded] = useState(false);
    const [expandedBlocks, setExpandedBlocks] = useState<any>({});
    const [loading, setLoading] = useState(false);
    /** True after a lazy events GET fails — never cache [] on failure (web SessionTail parity). */
    const [eventsFetchFailed, setEventsFetchFailed] = useState(false);
    const [eventsFetchRetry, setEventsFetchRetry] = useState(0);
    useEffect(() => {
        setEventsFetchFailed(false);
        setEventsFetchRetry(0);
    }, [message?.id]);
    useEffect(() => {
        if (!shouldAutoLoadEvents({ messageId: message?.id, streaming, events }))
            return;
        if (loading)
            return;
        if (eventsFetchFailed)
            return;
        let cancelled = false;
        setLoading(true);
        api
            .getMessageEvents(message.id)
            .then((data: any) => {
            applyLazyMessageEventsResult({
                cancelled,
                ok: true,
                data,
                messageId: message.id,
                onEventsLoaded,
            });
            if (!cancelled)
                setEventsFetchFailed(false);
        })
            .catch(() => {
            applyLazyMessageEventsResult({
                cancelled,
                ok: false,
                data: null,
                messageId: message.id,
                onEventsLoaded,
            });
            if (!cancelled)
                setEventsFetchFailed(true);
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [message?.id, streaming, events, eventsFetchFailed, eventsFetchRetry]);
    useEffect(() => {
        if (expanded && !events && !loading) {
            setLoading(true);
            api
                .getMessageEvents(message.id)
                .then((data: any) => {
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
    const blocks = useMemo<any>(() => eventsToBlocks(events ?? []), [events]);
    const browserRows = useMemo<any>(() => mergeBrowserTimelineRows(events ?? []), [events]);
    const browserHint = useMemo<any>(() => deriveStreamingBrowserHint(events ?? []), [events]);
    const hasBrowserTimeline = browserRows.length > 0 || (!!streaming && !!browserHint);
    const askBlocks = useMemo<any>(() => blocks.filter((b: any) => b.kind === 'ask_question'), [blocks]);
    const browserPanel = hasBrowserTimeline ? (<BrowserActivityPanel timelineEntries={events ?? []} streaming={streaming} screenshots={browserScreenshots}/>) : null;
    const toolCount = blocks.filter((b: any) => ['tool', 'subagent', 'explored', 'todos', 'plan_proposal'].includes(b.kind)).length;
    const thinkingCount = blocks.filter((b: any) => b.kind === 'thinking').length;
    const resultBlock = blocks.find((b: any) => b.kind === 'result');
    if (!expanded) {
        const hasClassicMeta = toolCount > 0 || thinkingCount > 0 || resultBlock;
        const hasMeta = hasClassicMeta || hasBrowserTimeline;
        if (!hasMeta && !events && askBlocks.length === 0) {
            if (eventsFetchFailed) {
                return (<View style={styles.retryBanner}>
            <TouchableOpacity onPress={() => {
                        setEventsFetchFailed(false);
                        setEventsFetchRetry((n: any) => n + 1);
                    }} accessibilityRole="button">
              <Text style={styles.retryText}>Could not load timeline. Tap to retry.</Text>
            </TouchableOpacity>
          </View>);
            }
            return null;
        }
        return (<View>
        {askBlocks.map((b: any) => (<AskUserQuestion key={b.event.askId} askId={b.event.askId} questions={b.event.questions || []} onSubmit={(text: any) => onAskSubmit?.(b.event.askId, text)} submitted={askSubmittedIds?.has(b.event.askId)}/>))}
        {browserPanel}
        {hasClassicMeta && (<TouchableOpacity style={styles.summaryBar} onPress={() => setExpanded(true)}>
            <View style={[styles.barDot, { backgroundColor: agentColor || colors.gray500 }]}/>
            {toolCount > 0 && (<Text style={styles.summaryText}>
                {toolCount} tool{toolCount > 1 ? 's' : ''}
              </Text>)}
            {thinkingCount > 0 && <Text style={styles.summaryText}>thinking</Text>}
            {resultBlock ? (<Text style={styles.summaryText}>
                {'\u23F1'}{' '}
                {((resultBlock.event?.durationMs || 0) / 1000).toFixed(1)}s
                {resultBlock.event?.costUsd ? ` \u00B7 $${resultBlock.event.costUsd.toFixed(4)}` : ''}
              </Text>) : null}
            <Text style={styles.expandHint}>{'\u25B8'}</Text>
          </TouchableOpacity>)}
      </View>);
    }
    return (<View style={styles.tailContainer}>
      <TouchableOpacity style={styles.collapseBar} onPress={() => setExpanded(false)}>
        <View style={[styles.barDot, { backgroundColor: agentColor || colors.gray500 }]}/>
        <Text style={styles.collapseText}>Event Timeline</Text>
        <Text style={styles.expandHint}>{'\u25BE'}</Text>
      </TouchableOpacity>

      {browserPanel}

      {askBlocks.map((b: any) => (<AskUserQuestion key={b.event.askId} askId={b.event.askId} questions={b.event.questions || []} onSubmit={(text: any) => onAskSubmit?.(b.event.askId, text)} submitted={askSubmittedIds?.has(b.event.askId)}/>))}

      {loading && <Text style={styles.loadingText}>Loading events...</Text>}

      {eventsFetchFailed && !loading && (<TouchableOpacity style={styles.retryBanner} onPress={() => {
                setEventsFetchFailed(false);
                setEventsFetchRetry((n: any) => n + 1);
            }}>
          <Text style={styles.retryText}>Could not load timeline. Tap to retry.</Text>
        </TouchableOpacity>)}

      {blocks.map((block: any, idx: any) => {
            const isBlockExpanded = expandedBlocks[idx];
            const toggle = () => setExpandedBlocks((prev: any) => ({ ...prev, [idx]: !prev[idx] }));
            switch (block.kind) {
                case 'thinking': {
                    const t = block.event?.text || '';
                    return (<TouchableOpacity key={idx} style={styles.eventRow} onPress={toggle}>
                <Text style={styles.eventIcon}>{'...'}</Text>
                <View style={styles.eventContent}>
                  <Text style={styles.eventLabel}>Thinking</Text>
                  {isBlockExpanded ? (<ScrollView style={styles.expandedContent} nestedScrollEnabled>
                      <Text style={styles.thinkingText}>{t}</Text>
                    </ScrollView>) : (<Text style={styles.eventPreview} numberOfLines={1}>
                      {t.length > 0 ? `${t.slice(0, 80)}\u2026` : '\u2026'}
                    </Text>)}
                </View>
                <Text style={styles.expandIcon}>{isBlockExpanded ? '\u25BE' : '\u25B8'}</Text>
              </TouchableOpacity>);
                }
                case 'subagent':
                    return (<View key={idx} style={styles.cardWrapper}>
                <SubagentCard use={block.use} result={block.result}/>
              </View>);
                case 'explored':
                    return (<View key={idx} style={styles.cardWrapper}>
                <ExploredChip items={block.items}/>
              </View>);
                case 'todos':
                    return (<View key={idx} style={styles.cardWrapper}>
                <TodoListCard use={block.use} result={block.result}/>
              </View>);
                case 'plan_proposal':
                    return (<View key={idx} style={styles.cardWrapper}>
                <PlanProposalCard use={block.use} result={block.result}/>
              </View>);
                case 'tool': {
                    const use = block.use;
                    const toolColor = TOOL_COLORS[use.tool] || colors.gray400;
                    const hasResult = block.result;
                    const isError = block.result?.isError;
                    const showDiffLayout = isFileModifyingTool(use.tool) && use.input;
                    const { headline, arg } = describeTool(use.tool, use.input);
                    // Background Bash shell: turn-scoped, can't be monitored or
                    // resumed after the turn ends (fresh CLI per turn). Flag it.
                    const isBackgroundBash =
                        use.tool === 'Bash' &&
                        typeof use.input?.command === 'string' &&
                        use.input?.run_in_background === true;
                    if (showDiffLayout) {
                        return (<View key={idx} style={[styles.diffWrapper, isError && styles.diffWrapperError]}>
                  <View style={styles.diffHeader}>
                    <View style={[styles.toolStripe, { backgroundColor: toolColor }]}/>
                    <Text style={[styles.toolName, { color: toolColor }]}>{use.tool}</Text>
                    {!hasResult && <Text style={styles.runningBadge}>running…</Text>}
                    {hasResult && isError && <Text style={styles.errorBadge}>error</Text>}
                  </View>
                  <DiffView tool={use.tool} input={use.input}/>
                  {hasResult && isError && block.result?.output ? (<View style={styles.diffErrorOutput}>
                      <Text style={styles.codeLabel}>error</Text>
                      <ScrollView nestedScrollEnabled style={styles.diffErrorScroll}>
                        <Text style={[styles.codeText, { color: colors.red400 }]}>
                          {block.result.output.length > 4000
                                    ? `${block.result.output.slice(0, 4000)}\u2026`
                                    : block.result.output}
                        </Text>
                      </ScrollView>
                    </View>) : null}
                </View>);
                    }
                    return (<TouchableOpacity key={idx} style={[styles.eventRow, isError && styles.errorEventRow]} onPress={toggle}>
                <View style={[styles.toolStripe, { backgroundColor: toolColor }]}/>
                <View style={styles.eventContent}>
                  <View style={styles.toolHeader}>
                    <Text style={[styles.toolName, { color: toolColor }]} numberOfLines={1}>
                      {headline || use.tool}
                    </Text>
                    {isBackgroundBash && (<Text style={styles.backgroundBadge} testID="bash-background-badge">
                        background
                      </Text>)}
                    {!hasResult && <Text style={styles.runningBadge}>running…</Text>}
                    {isError && <Text style={styles.errorBadge}>error</Text>}
                  </View>
                  {arg ? (<Text style={styles.argMono} numberOfLines={2}>
                      {arg}
                    </Text>) : null}
                  {isBlockExpanded && (<ScrollView style={styles.expandedContent} nestedScrollEnabled>
                      {use.tool === 'Bash' && typeof use.input?.command === 'string' ? (
                            // Cursor-style terminal view: `$ <command>` followed by
                            // raw stdout/stderr. Replaces the JSON-input + plain
                            // output panel for Bash so it reads like a real
                            // terminal session.
                            <View style={styles.bashTerminal} testID="bash-terminal">
                          <View style={styles.bashCommandRow}>
                            <Text style={styles.bashPrompt}>$</Text>
                            <Text style={styles.bashCommandText}>{use.input.command}</Text>
                          </View>
                          {typeof use.input.description === 'string' &&
                                    use.input.description.trim() ? (<Text style={styles.bashDescription}>
                              {use.input.description.trim()}
                            </Text>) : null}
                          {isBackgroundBash ? (<Text style={styles.bashBackgroundNote} testID="bash-background-note">
                              Launched in the background. Agent Hub runs a fresh CLI each turn, so this
                              shell only lives for this turn. It can't be monitored or resumed after the
                              turn ends.
                            </Text>) : null}
                          {block.result?.output ? (<Text style={[styles.bashOutput, isError && { color: colors.red400 }]}>
                              {block.result.output.slice(0, 2000)}
                            </Text>) : !block.result ? (<Text style={styles.bashRunning}>running…</Text>) : null}
                        </View>) : (<>
                          {use.input != null && (<View style={styles.codeBox}>
                              <Text style={styles.codeLabel}>Input</Text>
                              <Text style={styles.codeText}>{formatToolInput(use.input)}</Text>
                            </View>)}
                          {block.result?.output ? (<View style={[styles.codeBox, isError && styles.errorCodeBox]}>
                              <Text style={styles.codeLabel}>{isError ? 'error' : 'Output'}</Text>
                              <Text style={[styles.codeText, isError && { color: colors.red400 }]}>
                                {block.result.output.slice(0, 2000)}
                              </Text>
                            </View>) : null}
                        </>)}
                    </ScrollView>)}
                </View>
                <Text style={styles.expandIcon}>{isBlockExpanded ? '\u25BE' : '\u25B8'}</Text>
              </TouchableOpacity>);
                }
                case 'ask_question':
                    return null;
                case 'system': {
                    const modelLine = formatSystemBannerModelLine({
                        streamModel: block.event?.model,
                        sessionModel: message?.model,
                        sessionEngine: message?.engine,
                    });
                    return (<View key={idx} style={styles.systemRow}>
                <Text style={styles.systemText} numberOfLines={1}>
                  {modelLine}
                  {block.event?.cwd ? ` · ${block.event.cwd}` : ''}
                </Text>
              </View>);
                }
                case 'result': {
                    const evt = block.event;
                    const parts = [];
                    if (typeof evt?.durationMs === 'number') {
                        parts.push(`${(evt.durationMs / 1000).toFixed(1)}s`);
                    }
                    if (typeof evt?.costUsd === 'number') {
                        parts.push(`$${evt.costUsd.toFixed(4)}`);
                    }
                    if (typeof evt?.numTurns === 'number') {
                        parts.push(`${evt.numTurns} turn${evt.numTurns === 1 ? '' : 's'}`);
                    }
                    return (<View key={idx} style={styles.resultRow}>
                <Text style={[styles.resultText, evt?.isError && { color: colors.red400 }]}>
                  {evt?.isError ? '\u26A0 error' : '\u2705 done'}
                  {parts.length > 0 ? `  \u00B7  ${parts.join('  \u00B7  ')}` : ''}
                </Text>
              </View>);
                }
                case 'error':
                    return (<View key={idx} style={styles.errorRow}>
                <Text style={styles.errorIcon}>{'\u26A0'}</Text>
                <Text style={styles.errorMessage}>{block.event?.message || 'Unknown error'}</Text>
              </View>);
                case 'unknown':
                    return (<View key={idx} style={styles.unknownRow}>
                <Text style={styles.unknownText} numberOfLines={4}>
                  unhandled event:{' '}
                  {block.event?.text || JSON.stringify(block.event || {}).slice(0, 200)}
                </Text>
              </View>);
                case 'text':
                    return null;
                default:
                    return null;
            }
        })}
    </View>);
}
const exploredStyles = StyleSheet.create({
    wrap: {
        borderWidth: 1,
        borderColor: colors.gray800,
        borderRadius: 8,
        backgroundColor: 'rgba(17, 24, 39, 0.35)',
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    glyph: { fontSize: 12 },
    label: { fontSize: 12, color: colors.gray300, fontWeight: '600' },
    summary: { flex: 1, fontSize: 11, color: colors.gray500 },
    chevron: { fontSize: 10, color: colors.gray600 },
    list: {
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
    },
    listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    toolTag: { fontSize: 10, color: colors.gray600, fontFamily: 'monospace', minWidth: 52 },
    listHeadline: { flex: 1, fontSize: 11, color: colors.gray300 },
});
const todoStyles = StyleSheet.create({
    card: {
        borderWidth: 1,
        borderColor: 'rgba(55, 65, 81, 0.85)',
        borderRadius: 8,
        backgroundColor: 'rgba(17, 24, 39, 0.45)',
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    icon: { fontSize: 12, color: colors.gray400 },
    title: { fontSize: 12, fontWeight: '600', color: colors.gray200 },
    hint: { fontSize: 11, color: colors.gray500 },
    running: { fontSize: 10, color: colors.blue400, fontStyle: 'italic', marginLeft: 'auto' },
    err: { fontSize: 10, color: colors.red400, fontWeight: '700', marginLeft: 'auto' },
    list: {
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
    },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    glyph: { fontSize: 12, marginTop: 1 },
    content: { flex: 1, fontSize: 12, color: colors.gray300 },
    contentDone: { textDecorationLine: 'line-through', color: colors.gray500 },
    contentCancelled: { textDecorationLine: 'line-through', color: colors.gray600 },
});
const planStyles = StyleSheet.create({
    card: {
        borderWidth: 1,
        borderColor: 'rgba(139, 92, 246, 0.45)',
        borderRadius: 8,
        backgroundColor: 'rgba(46, 16, 101, 0.2)',
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    title: { fontSize: 12, fontWeight: '700', color: '#c4b5fd', fontFamily: 'monospace' },
    summary: { flex: 1, fontSize: 11, color: colors.gray400, minWidth: 120 },
    running: { fontSize: 10, color: colors.blue400, fontStyle: 'italic' },
    await: { fontSize: 9, color: '#c4b5fd', fontWeight: '700', textTransform: 'uppercase' },
    approved: { fontSize: 9, color: colors.emerald400, fontWeight: '700', textTransform: 'uppercase' },
    chevron: { fontSize: 12, color: colors.gray500, marginLeft: 'auto' },
    body: { paddingHorizontal: 12, paddingBottom: 12, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.2)' },
    empty: { fontSize: 11, color: colors.gray500, fontStyle: 'italic' },
    note: {
        marginTop: 10,
        fontSize: 11,
        color: 'rgba(196, 181, 253, 0.85)',
        backgroundColor: 'rgba(46, 16, 101, 0.35)',
        borderWidth: 1,
        borderColor: 'rgba(91, 33, 182, 0.45)',
        borderRadius: 6,
        padding: 8,
    },
});
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
    toolHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2, flex: 1 },
    toolName: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
    runningBadge: { fontSize: 10, color: colors.blue400, fontStyle: 'italic' },
    errorBadge: { fontSize: 10, color: colors.red400, fontWeight: '600' },
    backgroundBadge: {
        fontSize: 9,
        color: colors.amber400,
        fontWeight: '600',
        textTransform: 'uppercase',
        backgroundColor: colors.amber900_40,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 4,
        overflow: 'hidden',
    },
    argMono: {
        fontSize: 10,
        color: colors.gray500,
        fontFamily: 'monospace',
        marginBottom: 2,
    },
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
    bashTerminal: {
        backgroundColor: '#000',
        borderRadius: 6,
        padding: 8,
        marginTop: 4,
    },
    bashCommandRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
    bashPrompt: { color: colors.emerald500, fontFamily: 'monospace', fontSize: 11 },
    bashCommandText: {
        color: colors.gray100 || '#f3f4f6',
        fontFamily: 'monospace',
        fontSize: 11,
        flexShrink: 1,
    },
    bashDescription: {
        fontSize: 10,
        color: colors.gray500,
        fontStyle: 'italic',
        marginTop: 4,
    },
    bashBackgroundNote: {
        fontSize: 10,
        color: colors.amber400,
        marginTop: 8,
        lineHeight: 14,
    },
    bashOutput: {
        marginTop: 8,
        color: colors.gray300,
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 16,
    },
    bashRunning: {
        marginTop: 8,
        fontSize: 10,
        color: colors.emerald400,
        fontStyle: 'italic',
    },
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
    unknownRow: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: 'rgba(17, 24, 39, 0.45)',
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    unknownText: { fontSize: 10, color: colors.gray500, fontFamily: 'monospace' },
});
export default memo(SessionTail);
