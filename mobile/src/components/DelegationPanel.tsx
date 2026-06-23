import React, { useState, memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { colors } from '../theme/colors';
const STATUS_CONFIG: Record<string, any> = {
    pending: { icon: '\u23F3', color: colors.gray500 },
    running: { icon: '\u25CF', color: colors.blue400 },
    done: { icon: '\u2713', color: colors.emerald400 },
    error: { icon: '\u2715', color: colors.red400 },
    cancelled: { icon: '\u2298', color: colors.yellow400 },
};
const mdStyles = {
    body: { color: colors.gray300, fontSize: 13 },
    paragraph: { marginTop: 0, marginBottom: 4 },
    code_inline: { backgroundColor: colors.gray800, color: colors.emerald400, paddingHorizontal: 3, borderRadius: 3, fontSize: 12 },
    fence: { backgroundColor: colors.gray800, borderRadius: 6, padding: 8, marginVertical: 4, borderColor: colors.gray700 },
    code_block: { color: colors.gray300, fontSize: 12 },
    strong: { color: colors.white },
    link: { color: colors.blue400 },
};
function DelegationPanel({ delegations, onCancel, sessionId }: any) {
    const [collapsed, setCollapsed] = useState(false);
    const [expandedTasks, setExpandedTasks] = useState<any>({});
    if (!delegations || delegations.length === 0)
        return null;
    const doneCount = delegations.filter((t: any) => t.status === 'done').length;
    const errorCount = delegations.filter((t: any) => t.status === 'error').length;
    const total = delegations.length;
    const allFinished = delegations.every((t: any) => ['done', 'error', 'cancelled'].includes(t.status));
    const toggleTask = (idx: any) => {
        setExpandedTasks((prev: any) => ({ ...prev, [idx]: !prev[idx] }));
    };
    return (<View style={styles.container}>
      {/* Header */}
      <TouchableOpacity style={styles.header} onPress={() => setCollapsed(!collapsed)}>
        <Text style={styles.headerIcon}>{'\u2442'}</Text>
        <Text style={styles.headerTitle}>Delegation</Text>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>
            {doneCount}/{total} complete{errorCount > 0 ? ` (${errorCount} error${errorCount > 1 ? 's' : ''})` : ''}
          </Text>
        </View>
        {!allFinished && onCancel && (<TouchableOpacity style={styles.cancelBtn} onPress={() => onCancel(sessionId)}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>)}
        <Text style={styles.chevron}>{collapsed ? '\u25B8' : '\u25BE'}</Text>
      </TouchableOpacity>

      {/* Task list */}
      {!collapsed && (<View style={styles.taskList}>
          {delegations.map((task: any, idx: any) => {
                const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
                const isExpanded = expandedTasks[idx];
                const hasOutput = task.output || task.content || task.error;
                return (<View key={task.delegationId || idx} style={styles.taskRow}>
                <TouchableOpacity style={styles.taskHeader} onPress={() => hasOutput && toggleTask(idx)} disabled={!hasOutput}>
                  <View style={[styles.taskDot, { backgroundColor: task.agentColor || colors.gray500 }]}/>
                  <Text style={styles.taskAgent} numberOfLines={1}>{task.agentName || task.agentId}</Text>
                  <Text style={[styles.statusIcon, { color: config.color }]}>{config.icon}</Text>
                  {hasOutput && <Text style={styles.expandIcon}>{isExpanded ? '\u25BE' : '\u25B8'}</Text>}
                </TouchableOpacity>

                <Text style={styles.taskDescription} numberOfLines={isExpanded ? undefined : 2}>
                  {task.task}
                </Text>

                {isExpanded && (<ScrollView style={styles.outputScroll} nestedScrollEnabled>
                    {task.status === 'error' && task.error ? (<View style={styles.errorBox}>
                        <Text style={styles.errorText}>{task.error}</Text>
                      </View>) : task.status === 'running' && task.content ? (<View style={styles.outputBox}>
                        <Markdown style={mdStyles as any}>{task.content}</Markdown>
                      </View>) : task.status === 'done' && task.output ? (<View style={styles.outputBox}>
                        <Markdown style={mdStyles as any}>{task.output}</Markdown>
                      </View>) : task.status === 'pending' ? (<Text style={styles.pendingText}>Waiting to start...</Text>) : null}
                  </ScrollView>)}
              </View>);
            })}
        </View>)}
    </View>);
}
const styles = StyleSheet.create({
    container: {
        borderWidth: 1,
        borderColor: colors.gray700,
        borderRadius: 12,
        overflow: 'hidden',
        marginVertical: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: colors.gray800,
    },
    headerIcon: { fontSize: 14, color: colors.gray400 },
    headerTitle: { fontSize: 13, fontWeight: '600', color: colors.gray300 },
    headerBadge: {
        flex: 1,
        alignItems: 'flex-start',
    },
    headerBadgeText: { fontSize: 11, color: colors.gray500 },
    cancelBtn: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 4,
        backgroundColor: colors.red600,
    },
    cancelBtnText: { fontSize: 11, color: colors.white, fontWeight: '600' },
    chevron: { color: colors.gray500, fontSize: 12 },
    taskList: {
        borderTopWidth: 1,
        borderTopColor: colors.gray700,
    },
    taskRow: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
    },
    taskHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 4,
    },
    taskDot: { width: 8, height: 8, borderRadius: 4 },
    taskAgent: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.gray300 },
    statusIcon: { fontSize: 13, fontWeight: 'bold' },
    expandIcon: { color: colors.gray500, fontSize: 10 },
    taskDescription: { fontSize: 12, color: colors.gray500, paddingLeft: 16 },
    outputScroll: { maxHeight: 200, marginTop: 8, paddingLeft: 16 },
    outputBox: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    errorBox: {
        backgroundColor: '#1a0000',
        borderRadius: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: colors.red600,
    },
    errorText: { color: colors.red400, fontSize: 12 },
    pendingText: { fontSize: 12, color: colors.gray600, fontStyle: 'italic', paddingLeft: 16 },
});
export default memo(DelegationPanel);
