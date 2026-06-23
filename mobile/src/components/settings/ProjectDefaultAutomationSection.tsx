import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import { FINALIZE_AUTOMATION_OPTIONS } from '../../utils/finalizeAutomation';
const NO_PREFERENCE = '__none__';
const ROWS = [
    {
        value: NO_PREFERENCE,
        label: 'No preference',
        description: 'New sessions use the global default (Build).',
    },
    ...FINALIZE_AUTOMATION_OPTIONS,
];
/**
 * Mobile mirror of the web `ProjectDefaultAutomationSection`. Lets the
 * signed-in user pick their personal default Finalize automation level for a
 * project; new ad-hoc sessions they start inherit it. Scoped to the user — it
 * never changes anyone else's default.
 *
 * @param {{ projectId?: string | null }} props
 */
export default function ProjectDefaultAutomationSection({ projectId }: any) {
    const [value, setValue] = useState(NO_PREFERENCE);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<any>(null);
    useEffect(() => {
        let cancelled = false;
        if (!projectId) {
            setValue(NO_PREFERENCE);
            return undefined;
        }
        setLoading(true);
        setError(null);
        api
            .getProjectUserSettings(projectId)
            .then((res: any) => {
            if (!cancelled)
                setValue(res?.defaultFinalizeAutomation || NO_PREFERENCE);
        })
            .catch((err: any) => {
            if (!cancelled)
                setError(err?.message || 'Failed to load your default.');
        })
            .finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [projectId]);
    const handleSelect = useCallback(async (next: any) => {
        if (!projectId || next === value || saving)
            return;
        const prev = value;
        setValue(next);
        setSaving(true);
        setError(null);
        try {
            const res = await api.updateProjectUserSettings(projectId, {
                defaultFinalizeAutomation: next === NO_PREFERENCE ? null : next,
            });
            setValue(res?.defaultFinalizeAutomation || NO_PREFERENCE);
        }
        catch (err: any) {
            setValue(prev);
            setError(err?.message || 'Failed to save your default.');
        }
        finally {
            setSaving(false);
        }
    }, [projectId, value, saving]);
    return (<View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Your default automation</Text>
        {(loading || saving) && <ActivityIndicator color={colors.gray400} size="small"/>}
      </View>
      <Text style={styles.subtitle}>
        New sessions you start in this project begin at this Finalize automation level. This is your
        personal default — it doesn't change anyone else's.
      </Text>

      {ROWS.map((opt: any) => {
            const selected = value === opt.value;
            return (<TouchableOpacity key={opt.value} style={[styles.option, selected && styles.optionSelected]} disabled={loading || saving || !projectId} onPress={() => handleSelect(opt.value)} accessibilityRole="radio" accessibilityState={{ selected }}>
            <View style={[styles.radio, selected && styles.radioSelected]}>
              {selected && <View style={styles.radioDot}/>}
            </View>
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>{opt.label}</Text>
              <Text style={styles.optionDescription}>{opt.description}</Text>
            </View>
          </TouchableOpacity>);
        })}

      {error && <Text style={styles.error}>{error}</Text>}
    </View>);
}
const styles = StyleSheet.create({
    section: {
        marginTop: 24,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: colors.gray800,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
    title: { fontSize: 16, fontWeight: '600', color: colors.white },
    subtitle: { fontSize: 12, color: colors.gray500, marginBottom: 12 },
    option: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        backgroundColor: colors.gray900,
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    optionSelected: { borderColor: colors.emerald400, backgroundColor: colors.gray800 },
    radio: {
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: colors.gray500,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioSelected: { borderColor: colors.emerald400 },
    radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.emerald400 },
    optionText: { flex: 1 },
    optionLabel: { fontSize: 14, color: colors.gray200, fontWeight: '600' },
    optionDescription: { fontSize: 12, color: colors.gray500, marginTop: 2 },
    error: { fontSize: 13, color: colors.red400, marginTop: 8 },
});
