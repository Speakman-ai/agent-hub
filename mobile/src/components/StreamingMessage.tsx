import React, { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { colors } from '../theme/colors';
import { resolveAgentDisplayName } from '../utils/agentDisplayName';
const ENGINE_BADGES: Record<string, any> = {
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
    heading1: { color: colors.white, fontSize: 22, fontWeight: 'bold', marginTop: 12, marginBottom: 6 },
    heading2: { color: colors.white, fontSize: 18, fontWeight: 'bold', marginTop: 10, marginBottom: 6 },
    heading3: { color: colors.white, fontSize: 16, fontWeight: '600', marginTop: 10, marginBottom: 4 },
    paragraph: { marginTop: 4, marginBottom: 4 },
    blockquote: { borderLeftWidth: 4, borderLeftColor: colors.gray600, paddingLeft: 12, color: colors.gray400, fontStyle: 'italic' },
    link: { color: colors.blue400 },
    strong: { color: colors.white, fontWeight: 'bold' },
    em: { color: colors.gray300, fontStyle: 'italic' },
};
function StreamingMessage({ content, agentColor, agentName, engine, onInterrupt }: any) {
    const engineBadge = engine ? ENGINE_BADGES[engine] : null;
    return (<View style={styles.container}>
      <View style={styles.bubble}>
        <View style={styles.header}>
          <View style={[styles.headerDot, { backgroundColor: agentColor }]}/>
          <Text style={styles.headerLabel}>{resolveAgentDisplayName(null, agentName)}</Text>
          {engineBadge && (<View style={styles.engineBadgeRow}>
              <View style={[styles.engineDot, { backgroundColor: engineBadge.color }]}/>
              <Text style={styles.engineBadge}>{engineBadge.label}</Text>
            </View>)}
          <View style={styles.streamingBadge}>
            <View style={styles.streamingDot}/>
            <Text style={styles.streamingText}>streaming</Text>
          </View>
          {typeof onInterrupt === 'function' && (<TouchableOpacity onPress={onInterrupt} style={styles.interruptBtn} accessibilityRole="button" accessibilityLabel="Interrupt streaming response" testID="streaming-interrupt">
              <Text style={styles.interruptBtnText}>Interrupt</Text>
            </TouchableOpacity>)}
        </View>
        <Markdown style={markdownStyles as any}>{content}</Markdown>
      </View>
    </View>);
}
const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        justifyContent: 'flex-start',
        marginBottom: 12,
        paddingHorizontal: 12,
    },
    bubble: {
        maxWidth: '85%',
        backgroundColor: colors.gray800,
        borderRadius: 16,
        borderBottomLeftRadius: 6,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    header: {
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
    streamingBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginLeft: 4,
    },
    streamingDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.emerald500,
    },
    streamingText: {
        fontSize: 11,
        color: colors.emerald500,
    },
    interruptBtn: {
        marginLeft: 6,
        backgroundColor: '#d97706',
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    interruptBtnText: {
        fontSize: 10,
        fontWeight: '600',
        color: colors.white,
    },
});
export default memo(StreamingMessage);
