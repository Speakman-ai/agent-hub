/**
 * SessionDesignFilesPanel — mobile design-mode artifact surface.
 *
 * The web client renders a design-mode session's worktree `design/index.html`
 * live in an iframe (SessionDesignModePane → DesignCanvas). Mobile has no in-app
 * iframe canvas, so this panel gives the chat-only parity the card asks for:
 *   - a flat "files produced" list (GET /api/sessions/:id/design-files), and
 *   - an open-in-browser link to the rendered design + each individual file
 *     (served from the `/session-files/:id/design/` static mount).
 *
 * It refetches whenever `reloadNonce` bumps (ChatScreen bumps it on turn-done /
 * code-changed for this session) so the agent's writes show up without a manual
 * refresh, and exposes a manual refresh button for good measure.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Linking, ScrollView, } from 'react-native';
import AppIcon from './AppIcon';
import { api } from '../utils/api';
import { getServerBaseUrl } from '../utils/config';
import { buildDesignFileUrl, pickEntryFile, formatFileSize } from '../utils/designFiles';
import { colors } from '../theme/colors';
const PURPLE = '#7C3AED';
export default function SessionDesignFilesPanel({ sessionId, reloadNonce = 0 }: any) {
    const [files, setFiles] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<any>(null);
    const load = useCallback(async () => {
        if (!sessionId)
            return;
        setLoading(true);
        setError(null);
        try {
            const data = await api.getSessionDesignFiles(sessionId);
            setFiles(Array.isArray(data?.files) ? data.files : []);
        }
        catch (err: any) {
            setError(err?.message || 'Failed to load design files');
        }
        finally {
            setLoading(false);
        }
    }, [sessionId]);
    useEffect(() => {
        load();
    }, [load, reloadNonce]);
    const base = getServerBaseUrl();
    const fileUrl = (p: any) => buildDesignFileUrl(base, sessionId, p);
    const openFile = useCallback((p: any) => {
        const url = fileUrl(p);
        if (url)
            Linking.openURL(url).catch(() => { });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, sessionId]);
    const entry = pickEntryFile(files);
    return (<View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <AppIcon name="color-palette-outline" size={14} color={colors.purple400}/>
          <Text style={styles.headerTitle}>Design artifacts</Text>
          <Text style={styles.headerBadge}>{files.length}</Text>
        </View>
        <View style={styles.headerActions}>
          {entry ? (<TouchableOpacity style={styles.openBtn} onPress={() => openFile(entry)} accessibilityRole="button" accessibilityLabel="Open design in browser" testID="design-open-in-web">
              <AppIcon name="open-outline" size={11} color={colors.white}/>
              <Text style={styles.openBtnText}>Open in web</Text>
            </TouchableOpacity>) : null}
          <TouchableOpacity style={styles.refreshBtn} onPress={load} disabled={loading} accessibilityRole="button" accessibilityLabel="Refresh design files" testID="design-refresh">
            {loading ? (<ActivityIndicator size="small" color={colors.gray400}/>) : (<AppIcon name="sync-outline" size={13} color={colors.gray400}/>)}
          </TouchableOpacity>
        </View>
      </View>

      {error ? (<Text style={styles.errorText}>{error}</Text>) : files.length === 0 ? (<Text style={styles.emptyText}>
          {loading ? 'Loading…' : 'No artifacts yet. Ask the agent to build a design.'}
        </Text>) : (<ScrollView style={styles.list} nestedScrollEnabled>
          {files.map((f: any) => (<TouchableOpacity key={f.path} style={styles.fileRow} onPress={() => openFile(f.path)} accessibilityRole="button" accessibilityLabel={`Open ${f.path} in browser`}>
              <AppIcon name="document-outline" size={13} color={colors.gray400}/>
              <Text style={styles.filePath} numberOfLines={1}>
                {f.path}
              </Text>
              <Text style={styles.fileSize}>{formatFileSize(f.size)}</Text>
            </TouchableOpacity>))}
        </ScrollView>)}
    </View>);
}
const styles = StyleSheet.create({
    panel: {
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        backgroundColor: colors.gray950,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flexShrink: 1,
    },
    headerTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: colors.gray200,
    },
    headerBadge: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.gray400,
        backgroundColor: colors.gray800,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 8,
        overflow: 'hidden',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    openBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: PURPLE,
    },
    openBtnText: {
        color: colors.white,
        fontSize: 10,
        fontWeight: '600',
    },
    refreshBtn: {
        padding: 4,
        minWidth: 24,
        alignItems: 'center',
    },
    list: {
        marginTop: 6,
        maxHeight: 168,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 6,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
    },
    filePath: {
        flex: 1,
        fontSize: 12,
        color: colors.gray300,
    },
    fileSize: {
        fontSize: 10,
        color: colors.gray500,
    },
    emptyText: {
        marginTop: 6,
        fontSize: 11,
        color: colors.gray500,
    },
    errorText: {
        marginTop: 6,
        fontSize: 11,
        color: colors.amber400,
    },
});
