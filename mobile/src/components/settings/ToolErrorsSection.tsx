import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import { relativeTime } from '../../utils/time';
export default function ToolErrorsSection() {
    const { projects } = useApp();
    const [projectId, setProjectId] = useState(projects?.[0]?.id || null);
    const [errors, setErrors] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (!projectId && projects?.length)
            setProjectId(projects[0].id);
    }, [projects, projectId]);
    useEffect(() => {
        if (!projectId)
            return;
        setLoading(true);
        api
            .getToolErrors(projectId, { limit: 50 })
            .then((data: any) => setErrors(Array.isArray(data) ? data : data?.errors || []))
            .catch(() => setErrors([]))
            .finally(() => setLoading(false));
    }, [projectId]);
    return (<View style={styles.container}>
      <Text style={styles.title}>Tool Errors</Text>
      <Text style={styles.hint}>Recent tool failures across agent sessions.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
        {(projects || []).map((p: any) => (<TouchableOpacity key={p.id} style={[styles.chip, projectId === p.id && styles.chipActive]} onPress={() => setProjectId(p.id)}>
            <Text style={[styles.chipText, projectId === p.id && styles.chipTextActive]}>
              {p.name}
            </Text>
          </TouchableOpacity>))}
      </ScrollView>
      {loading ? (<Text style={styles.muted}>Loading…</Text>) : errors.length === 0 ? (<Text style={styles.muted}>No recent tool errors.</Text>) : (errors.map((err: any) => (<View key={err.id || `${err.timestamp}-${err.tool}`} style={styles.card}>
            <Text style={styles.toolName}>{err.tool || err.toolName || 'tool'}</Text>
            <Text style={styles.errorMsg} numberOfLines={4}>
              {err.message || err.error || String(err)}
            </Text>
            <Text style={styles.meta}>{relativeTime(err.timestamp || err.created_at)}</Text>
          </View>)))}
    </View>);
}
const styles = StyleSheet.create({
    container: { gap: 8 },
    title: { fontSize: 16, fontWeight: '600', color: colors.white },
    hint: { fontSize: 12, color: colors.gray500, marginBottom: 8 },
    chipRow: { marginBottom: 8 },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: colors.gray800,
        marginRight: 6,
    },
    chipActive: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
    chipText: { fontSize: 12, color: colors.gray400 },
    chipTextActive: { color: colors.white },
    card: {
        backgroundColor: colors.gray900,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
        padding: 10,
        marginBottom: 8,
    },
    toolName: { fontSize: 13, fontWeight: '600', color: colors.amber400 },
    errorMsg: { fontSize: 12, color: colors.gray300, marginTop: 4 },
    meta: { fontSize: 10, color: colors.gray600, marginTop: 4 },
    muted: { color: colors.gray500, fontSize: 12 },
});
