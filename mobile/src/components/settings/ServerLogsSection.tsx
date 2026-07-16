import React, { useState, useEffect, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { getWsUrl } from '../../utils/config';
import { api } from '../../utils/api';
import { formatServerLogLine, orderServerLogsNewestFirst } from '../../utils/serverLogs';
import { colors } from '../../theme/colors';
const MAX_LINES = 200;
export default function ServerLogsSection() {
    const [lines, setLines] = useState<any[]>([]);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<any>(null);
    // Seed from the authenticated REST snapshot so the panel isn't empty until
    // the next log line arrives. `api.fetchJSON` injects the auth headers.
    useEffect(() => {
        let cancelled = false;
        api
            .getServerLogs()
            .then((entries: any) => {
            if (cancelled || !Array.isArray(entries))
                return;
            setLines(entries.slice(-MAX_LINES).map(formatServerLogLine));
        })
            .catch(() => {
            /* best-effort seed — the live stream still fills the panel */
        });
        return () => {
            cancelled = true;
        };
    }, []);
    // Live tail over the shared authenticated WebSocket. The server broadcasts
    // `{ type: 'server-log', entry }` on the main socket — there is no dedicated
    // `/server-logs/ws` endpoint. Use `getWsUrl()` so the token / apiKey query is
    // present; otherwise a remote authed org closes the upgrade with 4401.
    useEffect(() => {
        const url = getWsUrl();
        if (!url)
            return undefined;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => setConnected(true);
        ws.onclose = () => setConnected(false);
        ws.onmessage = (evt: any) => {
            try {
                const data = JSON.parse(evt.data);
                if (data?.type === 'server-log' && data.entry) {
                    setLines((prev: any) => [...prev.slice(-(MAX_LINES - 1)), formatServerLogLine(data.entry)]);
                }
            }
            catch {
                /* non-JSON / non-log frame — ignore */
            }
        };
        return () => {
            ws.close();
            wsRef.current = null;
        };
    }, []);
    return (<View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Server Logs</Text>
        <View style={[styles.dot, connected ? styles.dotOn : styles.dotOff]}/>
        <Text style={styles.status}>{connected ? 'Live' : 'Disconnected'}</Text>
        <TouchableOpacity onPress={() => setLines([])}>
          <Text style={styles.clear}>Clear</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.logBox} nestedScrollEnabled>
        {lines.length === 0 ? (<Text style={styles.muted}>Waiting for log lines…</Text>) : (orderServerLogsNewestFirst(lines).map((line: any, i: any) => (<Text key={`${i}-${line.slice(0, 20)}`} style={styles.logLine}>
              {line}
            </Text>)))}
      </ScrollView>
    </View>);
}
const styles = StyleSheet.create({
    container: { gap: 8 },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { fontSize: 16, fontWeight: '600', color: colors.white, flex: 1 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    dotOn: { backgroundColor: colors.emerald400 },
    dotOff: { backgroundColor: colors.gray600 },
    status: { fontSize: 11, color: colors.gray500 },
    clear: { fontSize: 12, color: colors.blue400 },
    logBox: {
        maxHeight: 400,
        backgroundColor: colors.gray900,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        padding: 10,
    },
    logLine: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 10,
        color: colors.gray400,
        marginBottom: 2,
    },
    muted: { color: colors.gray600, fontSize: 12 },
});
