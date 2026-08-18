import React, { useState, useEffect, useRef, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, ScrollView, StyleSheet, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform, Modal, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { formatEntryTimestamp, shouldShowDateSeparator, mergeLiveThread, mergeLiveEntry, excludeRetiredHeartbeatThreads, isRetiredHeartbeatThread, } from '../utils/threads';
import { SidebarContext } from '../context/SidebarContext';
const mdStyles = {
    body: { color: colors.gray300, fontSize: 14 },
    paragraph: { marginTop: 0, marginBottom: 6 },
    code_inline: {
        backgroundColor: colors.gray800,
        color: colors.emerald400,
        paddingHorizontal: 4,
        borderRadius: 3,
        fontSize: 13,
    },
    fence: {
        backgroundColor: colors.gray800,
        borderColor: colors.gray700,
        borderRadius: 6,
        padding: 10,
        marginVertical: 6,
    },
    code_block: { color: colors.gray200, fontSize: 12 },
    link: { color: colors.blue600 },
    heading1: { color: colors.white, fontSize: 18, fontWeight: 'bold' },
    heading2: { color: colors.white, fontSize: 16, fontWeight: 'bold' },
    heading3: { color: colors.white, fontSize: 14, fontWeight: '600' },
    strong: { color: colors.white, fontWeight: 'bold' },
    em: { color: colors.gray300, fontStyle: 'italic' },
};
export default function ThreadsScreen({ route, navigation }: any) {
    const { projects, agents, lastThreadEvent, markProjectThreadsRead, setActiveThreadsProject, setActiveThread, } = useApp();
    const { openSidebar } = useContext(SidebarContext);
    const projectId = route?.params?.projectId || projects?.[0]?.id;
    const deepLinkThreadId = route?.params?.threadId;
    const project = projects?.find((p: any) => p.id === projectId);
    const [threads, setThreads] = useState<any[]>([]);
    const [filter, setFilter] = useState('all'); // all | cron
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<any>(null);
    // Detail view state (kept in the same screen to mirror NotesScreen pattern)
    const [selectedThread, setSelectedThread] = useState<any>(null);
    const [entries, setEntries] = useState<any[]>([]);
    const [entriesLoading, setEntriesLoading] = useState(false);
    const [entriesError, setEntriesError] = useState<any>(null);
    const [composeText, setComposeText] = useState('');
    const [composeSending, setComposeSending] = useState(false);
    // Per-entry "forward to agent" state.
    const [forwardEntry, setForwardEntry] = useState<any>(null);
    const [forwardPrompt, setForwardPrompt] = useState('');
    const [forwardSubmitting, setForwardSubmitting] = useState(false);
    const [forwardError, setForwardError] = useState<any>(null);
    const [forwardDone, setForwardDone] = useState<any>(null);
    const scrollRef = useRef<any>(null);
    const wasAtBottomRef = useRef(true);
    // Announce which project's threads are being viewed (suppresses unread bumps
    // for a future enhancement — today the active-thread id is what matters).
    useEffect(() => {
        setActiveThreadsProject(projectId || null);
        return () => setActiveThreadsProject(null);
    }, [projectId, setActiveThreadsProject]);
    // Clear unread badge on mount / project change
    useEffect(() => {
        if (projectId)
            markProjectThreadsRead(projectId);
    }, [projectId, markProjectThreadsRead]);
    // Load the thread list
    const loadThreads = useCallback(async () => {
        if (!projectId)
            return;
        setLoading(true);
        setError(null);
        try {
            const data = await api.getThreads(projectId, filter === 'all' ? undefined : filter);
            setThreads(excludeRetiredHeartbeatThreads(Array.isArray(data) ? data : []));
        }
        catch (err: any) {
            setError(err.message || 'Failed to load threads');
        }
        finally {
            setLoading(false);
        }
    }, [projectId, filter]);
    useEffect(() => {
        loadThreads();
    }, [loadThreads]);
    // React to live WebSocket events from AppContext
    useEffect(() => {
        if (!lastThreadEvent)
            return;
        const { type, projectId: evtProjectId, threadId } = lastThreadEvent;
        if (type === 'thread_created' && evtProjectId === projectId) {
            const { thread } = lastThreadEvent;
            if (thread &&
                !isRetiredHeartbeatThread(thread) &&
                (filter === 'all' || thread.type === filter)) {
                setThreads((prev: any) => mergeLiveThread(prev, thread));
            }
        }
        else if (type === 'thread_deleted' && evtProjectId === projectId) {
            setThreads((prev: any) => prev.filter((t: any) => t.id !== threadId));
            if (selectedThread?.id === threadId) {
                setSelectedThread(null);
                setEntries([]);
            }
        }
        else if (type === 'thread_entry_created' &&
            selectedThread?.id === threadId) {
            const { entry } = lastThreadEvent;
            if (entry)
                setEntries((prev: any) => mergeLiveEntry(prev, entry));
        }
    }, [lastThreadEvent, projectId, filter, selectedThread]);
    // Auto-scroll to bottom when new entries arrive (if we were at bottom)
    useEffect(() => {
        if (scrollRef.current && wasAtBottomRef.current) {
            // ScrollView doesn't expose scrollHeight — use scrollToEnd
            scrollRef.current.scrollToEnd({ animated: true });
        }
    }, [entries]);
    const handleSelectThread = useCallback(async (thread: any) => {
        if (isRetiredHeartbeatThread(thread))
            return;
        setSelectedThread(thread);
        setActiveThread(thread.id);
        setEntriesLoading(true);
        setEntriesError(null);
        wasAtBottomRef.current = true;
        try {
            const [threadDetail, entriesData] = await Promise.all([
                api.getThread(thread.id).catch(() => thread),
                api.getThreadEntries(thread.id),
            ]);
            const resolved = threadDetail || thread;
            if (isRetiredHeartbeatThread(resolved)) {
                setSelectedThread(null);
                setEntries([]);
                setActiveThread(null);
                return;
            }
            setSelectedThread(resolved);
            setEntries(Array.isArray(entriesData) ? entriesData : []);
        }
        catch (err: any) {
            setEntriesError(err.message || 'Failed to load entries');
        }
        finally {
            setEntriesLoading(false);
        }
    }, [setActiveThread]);
    // Notification deep-link: open thread once the list loads.
    const deepLinkHandledRef = useRef<any>(null);
    useEffect(() => {
        if (!deepLinkThreadId || loading || threads.length === 0)
            return;
        if (deepLinkHandledRef.current === deepLinkThreadId)
            return;
        const thread = threads.find((t: any) => t.id === deepLinkThreadId);
        if (!thread || isRetiredHeartbeatThread(thread))
            return;
        deepLinkHandledRef.current = deepLinkThreadId;
        handleSelectThread(thread);
    }, [deepLinkThreadId, loading, threads, handleSelectThread]);
    const handleBack = useCallback(() => {
        setSelectedThread(null);
        setEntries([]);
        setEntriesError(null);
        setComposeText('');
        setActiveThread(null);
    }, [setActiveThread]);
    const handlePostEntry = useCallback(async () => {
        if (!selectedThread?.id || !composeText.trim() || composeSending)
            return;
        setComposeSending(true);
        try {
            const entry = await api.postThreadEntry(selectedThread.id, composeText.trim());
            setComposeText('');
            if (entry)
                setEntries((prev: any) => mergeLiveEntry(prev, entry));
        }
        catch (err: any) {
            setEntriesError(err.message || 'Failed to post entry');
        }
        finally {
            setComposeSending(false);
        }
    }, [selectedThread, composeText, composeSending]);
    const openForward = useCallback((entry: any) => {
        setForwardEntry(entry);
        setForwardPrompt('');
        setForwardError(null);
        setForwardDone(null);
    }, []);
    const closeForward = useCallback(() => {
        setForwardEntry(null);
        setForwardError(null);
    }, []);
    const handleForwardToAgent = useCallback(async (targetAgentId: any) => {
        if (!forwardEntry?.id || !selectedThread?.id || forwardSubmitting)
            return;
        setForwardSubmitting(true);
        setForwardError(null);
        try {
            const result = await api.forwardThreadEntry(selectedThread.id, forwardEntry.id, {
                targetAgentId,
                prompt: forwardPrompt.trim() || undefined,
            });
            setForwardEntry(null);
            setForwardDone((result as any)?.session?.name || 'a new session');
        }
        catch (err: any) {
            setForwardError(err.message || 'Forward failed');
        }
        finally {
            setForwardSubmitting(false);
        }
    }, [forwardEntry, selectedThread, forwardPrompt, forwardSubmitting]);
    // Forwardable targets: every active agent (the server re-checks visibility).
    const forwardTargets = (Array.isArray(agents) ? agents : []).filter((a: any) => a && a.active !== false);
    // Clear active-thread tracking when the screen unmounts
    useEffect(() => {
        return () => setActiveThread(null);
    }, [setActiveThread]);
    const handleScroll = (event: any) => {
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
        const atBottom = contentSize.height - layoutMeasurement.height - contentOffset.y < 40;
        wasAtBottomRef.current = atBottom;
    };
    // ── Detail view ──
    if (selectedThread) {
        const typeColor = colors.blue400;
        return (<SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={handleBack} style={styles.menuButton}>
            <Text style={styles.backIcon}>{'\u2190'}</Text>
          </TouchableOpacity>
          <View style={[styles.typeDot, { backgroundColor: typeColor }]}/>
          <Text style={styles.title} numberOfLines={1}>
            {selectedThread.name}
          </Text>
          <View style={[styles.typeBadge, { borderColor: typeColor }]}>
            <Text style={[styles.typeBadgeText, { color: typeColor }]}>
              {selectedThread.type}
            </Text>
          </View>
        </View>

        {entriesLoading ? (<View style={styles.centerState}>
            <ActivityIndicator size="small" color={colors.gray400}/>
          </View>) : entriesError ? (<View style={styles.centerState}>
            <Text style={styles.errorText}>{entriesError}</Text>
          </View>) : entries.length === 0 ? (<View style={styles.centerState}>
            <Text style={styles.emptyTitle}>No entries yet</Text>
            <Text style={styles.emptyDesc}>
              Entries will appear here when the {selectedThread.type} runs
            </Text>
          </View>) : (<>
            <ScrollView ref={scrollRef} onScroll={handleScroll} scrollEventThrottle={100} contentContainerStyle={styles.entriesContainer}>
              <Text style={styles.entriesMeta}>
                {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
              </Text>
              {entries.map((entry: any, idx: any) => {
                    const prev = idx > 0 ? entries[idx - 1] : null;
                    const showSep = shouldShowDateSeparator(prev, entry);
                    const isError = entry.content?.startsWith('ERROR:');
                    const entryDate = new Date(entry.timestamp?.includes('T')
                        ? entry.timestamp
                        : entry.timestamp + 'Z');
                    return (<View key={entry.id}>
                    {showSep && (<View style={styles.dateSeparator}>
                        <View style={styles.dateSeparatorLine}/>
                        <Text style={styles.dateSeparatorText}>
                          {entryDate.toLocaleDateString(undefined, {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                            })}
                        </Text>
                        <View style={styles.dateSeparatorLine}/>
                      </View>)}
                    <View style={[
                            styles.entryCard,
                            isError && styles.entryCardError,
                        ]}>
                      <View style={styles.entryHeader}>
                        <Text style={styles.entryTimestamp}>
                          {formatEntryTimestamp(entry.timestamp)}
                        </Text>
                        <TouchableOpacity onPress={() => openForward(entry)} style={styles.entryForwardBtn} accessibilityLabel="Forward message to an agent">
                          <Text style={styles.entryForwardText}>Forward</Text>
                        </TouchableOpacity>
                      </View>
                      {isError ? (<Text style={styles.entryErrorText}>{entry.content}</Text>) : (<Markdown style={mdStyles as any}>
                          {entry.content || ''}
                        </Markdown>)}
                    </View>
                  </View>);
                })}
            </ScrollView>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={80}>
              <View style={styles.composeRow}>
                <TextInput style={styles.composeInput} value={composeText} onChangeText={setComposeText} placeholder="Add a note to this thread…" placeholderTextColor={colors.gray600} multiline/>
                <TouchableOpacity style={[styles.composeButton, (!composeText.trim() || composeSending) && styles.composeButtonDisabled]} onPress={handlePostEntry} disabled={!composeText.trim() || composeSending}>
                  {composeSending ? (<ActivityIndicator size="small" color={colors.white}/>) : (<Text style={styles.composeButtonText}>Send</Text>)}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </>)}

        {forwardDone && (<View style={styles.forwardToast}>
            <Text style={styles.forwardToastText}>Forwarded to {forwardDone}</Text>
            <TouchableOpacity onPress={() => setForwardDone(null)}>
              <Text style={styles.forwardToastDismiss}>{'✕'}</Text>
            </TouchableOpacity>
          </View>)}

        <Modal visible={!!forwardEntry} transparent animationType="fade" onRequestClose={closeForward}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Forward message</Text>
                <TouchableOpacity onPress={closeForward} disabled={forwardSubmitting}>
                  <Text style={styles.modalClose}>{'✕'}</Text>
                </TouchableOpacity>
              </View>
              <TextInput style={styles.modalPromptInput} value={forwardPrompt} onChangeText={setForwardPrompt} placeholder="Extra instructions (optional)" placeholderTextColor={colors.gray600} multiline editable={!forwardSubmitting}/>
              {forwardError && (<Text style={styles.modalError}>{forwardError}</Text>)}
              {forwardTargets.length === 0 ? (<Text style={styles.modalEmpty}>
                  No agents available to forward to.
                </Text>) : (<ScrollView style={styles.modalAgentList}>
                  {forwardTargets.map((agent: any) => (<TouchableOpacity key={agent.id} style={styles.modalAgentRow} onPress={() => handleForwardToAgent(agent.id)} disabled={forwardSubmitting}>
                      <View style={[styles.modalAgentDot, { backgroundColor: agent.color || colors.gray500 }]}/>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.modalAgentName} numberOfLines={1}>{agent.name || agent.id}</Text>
                        <Text style={styles.modalAgentMeta} numberOfLines={1}>{agent.engine}</Text>
                      </View>
                    </TouchableOpacity>))}
                </ScrollView>)}
              {forwardSubmitting && (<View style={styles.modalSubmitting}>
                  <ActivityIndicator size="small" color={colors.gray400}/>
                  <Text style={styles.modalSubmittingText}>Forwarding…</Text>
                </View>)}
            </View>
          </View>
        </Modal>
      </SafeAreaView>);
    }
    // ── List view ──
    return (<SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Threads</Text>
        {project && (<Text style={styles.projectLabel} numberOfLines={1}>
            {project.name}
          </Text>)}
      </View>

      <View style={styles.filterRow}>
        {['all', 'cron'].map((f: any) => (<TouchableOpacity key={f} onPress={() => setFilter(f)} style={[
                styles.filterButton,
                filter === f && styles.filterButtonActive,
            ]}>
            <Text style={[
                styles.filterText,
                filter === f && styles.filterTextActive,
            ]}>
              {f === 'all' ? 'All' : 'Cron'}
            </Text>
          </TouchableOpacity>))}
      </View>

      {loading ? (<View style={styles.centerState}>
          <ActivityIndicator size="small" color={colors.gray400}/>
        </View>) : error ? (<View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>) : threads.length === 0 ? (<View style={styles.centerState}>
          <Text style={styles.emptyTitle}>No threads yet</Text>
          <Text style={styles.emptyDesc}>
            Threads are created automatically by cron jobs
          </Text>
        </View>) : (<FlatList data={threads} keyExtractor={(item: any) => item.id} contentContainerStyle={{ padding: 12 }} renderItem={({ item }: any) => {
                const typeColor = colors.blue400;
                return (<TouchableOpacity style={styles.threadItem} onPress={() => handleSelectThread(item)}>
                <View style={[styles.typeDot, { backgroundColor: typeColor }]}/>
                <View style={styles.threadInfo}>
                  <Text style={styles.threadName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.threadMeta}>
                    {relativeTime(item.created_at)}
                  </Text>
                </View>
                <View style={[styles.typeBadge, { borderColor: typeColor }]}>
                  <Text style={[styles.typeBadgeText, { color: typeColor }]}>
                    {item.type}
                  </Text>
                </View>
              </TouchableOpacity>);
            }}/>)}
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.gray950,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: { padding: 4 },
    menuIcon: { fontSize: 22, color: colors.gray400 },
    backIcon: { fontSize: 22, color: colors.gray400 },
    title: { fontSize: 17, fontWeight: '600', color: colors.white, flexShrink: 1 },
    projectLabel: {
        marginLeft: 'auto',
        fontSize: 12,
        color: colors.gray500,
        maxWidth: 120,
    },
    filterRow: {
        flexDirection: 'row',
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
    },
    filterButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: colors.gray800,
    },
    filterButtonActive: {
        backgroundColor: colors.gray700,
    },
    filterText: {
        fontSize: 12,
        color: colors.gray500,
    },
    filterTextActive: {
        color: colors.gray200,
        fontWeight: '600',
    },
    centerState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
    },
    emptyTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.gray400,
        marginBottom: 6,
    },
    emptyDesc: {
        fontSize: 13,
        color: colors.gray600,
        textAlign: 'center',
        lineHeight: 18,
    },
    errorText: {
        fontSize: 13,
        color: colors.red400,
        textAlign: 'center',
    },
    threadItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: colors.gray900,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        paddingHorizontal: 12,
        paddingVertical: 12,
        marginBottom: 8,
    },
    typeDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
    },
    threadInfo: { flex: 1, minWidth: 0 },
    threadName: {
        fontSize: 14,
        color: colors.gray200,
        fontWeight: '500',
    },
    threadMeta: {
        fontSize: 11,
        color: colors.gray600,
        marginTop: 2,
    },
    typeBadge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        borderWidth: 1,
    },
    typeBadgeText: {
        fontSize: 10,
        fontWeight: '600',
        textTransform: 'uppercase',
    },
    entriesContainer: {
        padding: 12,
        paddingBottom: 32,
    },
    entriesMeta: {
        fontSize: 11,
        color: colors.gray600,
        marginBottom: 8,
        textAlign: 'right',
    },
    entryCard: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 8,
    },
    entryCardError: {
        borderColor: colors.red600,
        backgroundColor: 'rgba(127, 29, 29, 0.15)',
    },
    entryHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
    },
    entryTimestamp: {
        fontSize: 10,
        color: colors.gray600,
        fontFamily: 'Courier',
    },
    entryForwardBtn: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    entryForwardText: {
        fontSize: 11,
        color: colors.emerald400,
        fontWeight: '600',
    },
    forwardToast: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginHorizontal: 12,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: 'rgba(16, 185, 129, 0.12)',
        borderWidth: 1,
        borderColor: 'rgba(16, 185, 129, 0.3)',
    },
    forwardToastText: { color: colors.emerald400, fontSize: 12, flex: 1 },
    forwardToastDismiss: { color: colors.emerald400, fontSize: 13, paddingHorizontal: 4 },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        padding: 20,
    },
    modalCard: {
        backgroundColor: colors.gray900,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.gray700,
        padding: 16,
        maxHeight: '80%',
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    modalTitle: { fontSize: 15, fontWeight: '600', color: colors.white },
    modalClose: { fontSize: 16, color: colors.gray400, paddingHorizontal: 4 },
    modalPromptInput: {
        minHeight: 40,
        maxHeight: 90,
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        color: colors.gray200,
        fontSize: 14,
        marginBottom: 10,
    },
    modalError: { color: colors.red400, fontSize: 12, marginBottom: 8 },
    modalEmpty: { color: colors.gray500, fontSize: 13, paddingVertical: 12 },
    modalAgentList: { maxHeight: 280 },
    modalAgentRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 10,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    modalAgentDot: { width: 10, height: 10, borderRadius: 5 },
    modalAgentName: { fontSize: 14, color: colors.gray200, fontWeight: '500' },
    modalAgentMeta: { fontSize: 11, color: colors.gray500, marginTop: 1 },
    modalSubmitting: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
    },
    modalSubmittingText: { color: colors.gray400, fontSize: 12 },
    entryErrorText: {
        fontSize: 13,
        color: colors.red400,
    },
    dateSeparator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        gap: 8,
    },
    dateSeparatorLine: {
        flex: 1,
        height: 1,
        backgroundColor: colors.gray800,
    },
    dateSeparatorText: {
        fontSize: 10,
        color: colors.gray600,
        fontWeight: '600',
        letterSpacing: 1,
        textTransform: 'uppercase',
    },
    composeRow: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
        padding: 12,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
        backgroundColor: colors.gray950,
    },
    composeInput: {
        flex: 1,
        minHeight: 40,
        maxHeight: 100,
        backgroundColor: colors.gray900,
        borderWidth: 1,
        borderColor: colors.gray800,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        color: colors.gray200,
        fontSize: 14,
    },
    composeButton: {
        backgroundColor: colors.blue600,
        borderRadius: 8,
        paddingHorizontal: 14,
        paddingVertical: 10,
        minWidth: 56,
        alignItems: 'center',
    },
    composeButtonDisabled: { opacity: 0.5 },
    composeButtonText: { color: colors.white, fontWeight: '600', fontSize: 13 },
});
