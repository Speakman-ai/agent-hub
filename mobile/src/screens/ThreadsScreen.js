import React, { useState, useEffect, useRef, useCallback, useContext } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import {
  formatEntryTimestamp,
  shouldShowDateSeparator,
  mergeLiveThread,
  mergeLiveEntry,
} from '../utils/threads';
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

export default function ThreadsScreen({ route, navigation }) {
  const {
    projects,
    lastThreadEvent,
    markProjectThreadsRead,
    setActiveThreadsProject,
    setActiveThread,
  } = useApp();
  const { openSidebar } = useContext(SidebarContext);

  const projectId = route?.params?.projectId || projects?.[0]?.id;
  const project = projects?.find((p) => p.id === projectId);

  const [threads, setThreads] = useState([]);
  const [filter, setFilter] = useState('all'); // all | heartbeat | cron
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Detail view state (kept in the same screen to mirror NotesScreen pattern)
  const [selectedThread, setSelectedThread] = useState(null);
  const [entries, setEntries] = useState([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState(null);

  const scrollRef = useRef(null);
  const wasAtBottomRef = useRef(true);

  // Announce which project's threads are being viewed (suppresses unread bumps
  // for a future enhancement — today the active-thread id is what matters).
  useEffect(() => {
    setActiveThreadsProject(projectId || null);
    return () => setActiveThreadsProject(null);
  }, [projectId, setActiveThreadsProject]);

  // Clear unread badge on mount / project change
  useEffect(() => {
    if (projectId) markProjectThreadsRead(projectId);
  }, [projectId, markProjectThreadsRead]);

  // Load the thread list
  const loadThreads = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getThreads(projectId, filter === 'all' ? undefined : filter);
      setThreads(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to load threads');
    } finally {
      setLoading(false);
    }
  }, [projectId, filter]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // React to live WebSocket events from AppContext
  useEffect(() => {
    if (!lastThreadEvent) return;
    const { type, projectId: evtProjectId, threadId } = lastThreadEvent;

    if (type === 'thread_created' && evtProjectId === projectId) {
      const { thread } = lastThreadEvent;
      if (
        thread &&
        (filter === 'all' || thread.type === filter)
      ) {
        setThreads((prev) => mergeLiveThread(prev, thread));
      }
    } else if (type === 'thread_deleted' && evtProjectId === projectId) {
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (selectedThread?.id === threadId) {
        setSelectedThread(null);
        setEntries([]);
      }
    } else if (
      type === 'thread_entry_created' &&
      selectedThread?.id === threadId
    ) {
      const { entry } = lastThreadEvent;
      if (entry) setEntries((prev) => mergeLiveEntry(prev, entry));
    }
  }, [lastThreadEvent, projectId, filter, selectedThread]);

  // Auto-scroll to bottom when new entries arrive (if we were at bottom)
  useEffect(() => {
    if (scrollRef.current && wasAtBottomRef.current) {
      // ScrollView doesn't expose scrollHeight — use scrollToEnd
      scrollRef.current.scrollToEnd({ animated: true });
    }
  }, [entries]);

  const handleSelectThread = useCallback(
    async (thread) => {
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
        setSelectedThread(threadDetail || thread);
        setEntries(Array.isArray(entriesData) ? entriesData : []);
      } catch (err) {
        setEntriesError(err.message || 'Failed to load entries');
      } finally {
        setEntriesLoading(false);
      }
    },
    [setActiveThread],
  );

  const handleBack = useCallback(() => {
    setSelectedThread(null);
    setEntries([]);
    setEntriesError(null);
    setActiveThread(null);
  }, [setActiveThread]);

  // Clear active-thread tracking when the screen unmounts
  useEffect(() => {
    return () => setActiveThread(null);
  }, [setActiveThread]);

  const handleScroll = (event) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const atBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y < 40;
    wasAtBottomRef.current = atBottom;
  };

  // ── Detail view ──
  if (selectedThread) {
    const isHeartbeat = selectedThread.type === 'heartbeat';
    const typeColor = isHeartbeat ? colors.rose400 : colors.blue400;

    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={handleBack} style={styles.menuButton}>
            <Text style={styles.backIcon}>{'\u2190'}</Text>
          </TouchableOpacity>
          <View style={[styles.typeDot, { backgroundColor: typeColor }]} />
          <Text style={styles.title} numberOfLines={1}>
            {selectedThread.name}
          </Text>
          <View style={[styles.typeBadge, { borderColor: typeColor }]}>
            <Text style={[styles.typeBadgeText, { color: typeColor }]}>
              {selectedThread.type}
            </Text>
          </View>
        </View>

        {entriesLoading ? (
          <View style={styles.centerState}>
            <ActivityIndicator size="small" color={colors.gray400} />
          </View>
        ) : entriesError ? (
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{entriesError}</Text>
          </View>
        ) : entries.length === 0 ? (
          <View style={styles.centerState}>
            <Text style={styles.emptyTitle}>No entries yet</Text>
            <Text style={styles.emptyDesc}>
              Entries will appear here when the {selectedThread.type} runs
            </Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            onScroll={handleScroll}
            scrollEventThrottle={100}
            contentContainerStyle={styles.entriesContainer}
          >
            <Text style={styles.entriesMeta}>
              {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            </Text>
            {entries.map((entry, idx) => {
              const prev = idx > 0 ? entries[idx - 1] : null;
              const showSep = shouldShowDateSeparator(prev, entry);
              const isError = entry.content?.startsWith('ERROR:');
              const entryDate = new Date(
                entry.timestamp?.includes('T')
                  ? entry.timestamp
                  : entry.timestamp + 'Z',
              );
              return (
                <View key={entry.id}>
                  {showSep && (
                    <View style={styles.dateSeparator}>
                      <View style={styles.dateSeparatorLine} />
                      <Text style={styles.dateSeparatorText}>
                        {entryDate.toLocaleDateString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </Text>
                      <View style={styles.dateSeparatorLine} />
                    </View>
                  )}
                  <View
                    style={[
                      styles.entryCard,
                      isError && styles.entryCardError,
                    ]}
                  >
                    <Text style={styles.entryTimestamp}>
                      {formatEntryTimestamp(entry.timestamp)}
                    </Text>
                    {isError ? (
                      <Text style={styles.entryErrorText}>{entry.content}</Text>
                    ) : (
                      <Markdown style={mdStyles}>
                        {entry.content || ''}
                      </Markdown>
                    )}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  // ── List view ──
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Threads</Text>
        {project && (
          <Text style={styles.projectLabel} numberOfLines={1}>
            {project.name}
          </Text>
        )}
      </View>

      <View style={styles.filterRow}>
        {['all', 'heartbeat', 'cron'].map((f) => (
          <TouchableOpacity
            key={f}
            onPress={() => setFilter(f)}
            style={[
              styles.filterButton,
              filter === f && styles.filterButtonActive,
            ]}
          >
            <Text
              style={[
                styles.filterText,
                filter === f && styles.filterTextActive,
              ]}
            >
              {f === 'all' ? 'All' : f === 'heartbeat' ? 'Heartbeat' : 'Cron'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={colors.gray400} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : threads.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyTitle}>No threads yet</Text>
          <Text style={styles.emptyDesc}>
            Threads are created automatically by cron jobs and heartbeats
          </Text>
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => {
            const isHeartbeat = item.type === 'heartbeat';
            const typeColor = isHeartbeat ? colors.rose400 : colors.blue400;
            return (
              <TouchableOpacity
                style={styles.threadItem}
                onPress={() => handleSelectThread(item)}
              >
                <View style={[styles.typeDot, { backgroundColor: typeColor }]} />
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
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
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
  entryTimestamp: {
    fontSize: 10,
    color: colors.gray600,
    fontFamily: 'Courier',
    marginBottom: 6,
  },
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
});
