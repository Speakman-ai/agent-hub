import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import type { ServerAgentSkillRef } from '@shared/utils/hub';
import type { ServerAgentSettings } from '@shared/utils/serverAgentSettingsStore';
import {
  addSkillRef,
  addableSkillGroups,
  describeSkillRef,
  removeSkillRef,
  type ServerAgentSkillOptions,
} from '@shared/utils/serverAgentSkills';
import { api } from '../utils/api';
import { saveServerAgentSettings } from '../utils/serverAgentInstance';
import { colors } from '../theme/colors';

/**
 * Skills the user adds to their Server Agent. Peer of the web
 * `ServerAgentSkillsSection`; each add or remove saves at once.
 */
export function ServerAgentSkillsSection({
  accountKey,
  settings,
  enabled,
}: {
  accountKey: string | null;
  settings: ServerAgentSettings | null;
  enabled: boolean;
}) {
  const [options, setOptions] = useState<ServerAgentSkillOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountKey) return undefined;
    let cancelled = false;
    setOptions(null);
    setOptionsError(null);
    Promise.resolve()
      .then(() => api.getServerAgentSkillOptions() as Promise<ServerAgentSkillOptions>)
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOptionsError(err instanceof Error ? err.message : 'Could not load skills.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

  const added = settings?.skills ?? [];
  const builtIn = settings?.builtInSkills ?? options?.builtIn ?? [];
  const groups = addableSkillGroups(options, added, query);

  const save = async (next: ServerAgentSkillRef[]) => {
    if (!accountKey) return;
    setSaving(true);
    setError(null);
    try {
      await saveServerAgentSettings(accountKey, { skills: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save skills.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View testID="server-agent-skills" style={styles.section}>
      <Text style={styles.label}>Skills</Text>
      <Text style={styles.hint}>
        Always loaded: {builtIn.length ? builtIn.join(', ') : 'the Agent Hub skills'}. Add any
        global skill, or a skill from a project you can access.
      </Text>
      {added.map((ref) => {
        const label = describeSkillRef(ref, options);
        return (
          <View
            key={`${ref.projectId ?? ''}/${ref.id}`}
            testID={`server-agent-skill-${ref.id}`}
            style={styles.row}
          >
            <Text style={[styles.rowName, styles.flex]} numberOfLines={1}>
              {label.name}
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {label.scope}
            </Text>
            <TouchableOpacity
              testID={`server-agent-skill-remove-${ref.id}`}
              onPress={() => void save(removeSkillRef(added, ref))}
              disabled={!enabled || saving}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label.name}`}
              style={styles.remove}
            >
              <Text style={styles.removeLabel}>×</Text>
            </TouchableOpacity>
          </View>
        );
      })}
      {!picking ? (
        <TouchableOpacity
          testID="server-agent-skills-add"
          onPress={() => setPicking(true)}
          disabled={!enabled || saving}
          accessibilityRole="button"
          style={[styles.add, (!enabled || saving) && styles.disabled]}
        >
          <Text style={styles.addLabel}>+ Add skill</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.picker}>
          <View style={styles.pickerHeader}>
            <TextInput
              testID="server-agent-skills-search"
              value={query}
              onChangeText={setQuery}
              placeholder="Search skills"
              placeholderTextColor={colors.gray500}
              style={[styles.search, styles.flex]}
            />
            <TouchableOpacity
              onPress={() => {
                setPicking(false);
                setQuery('');
              }}
              accessibilityRole="button"
              accessibilityLabel="Close skill picker"
              style={styles.remove}
            >
              <Text style={styles.removeLabel}>×</Text>
            </TouchableOpacity>
          </View>
          {optionsError ? (
            <Text style={[styles.hint, { color: colors.red400 }]}>
              Could not load skills: {optionsError}
            </Text>
          ) : null}
          {!optionsError && !options ? <Text style={styles.hint}>Loading skills…</Text> : null}
          {options && groups.length === 0 ? (
            <Text style={styles.hint}>No more skills to add.</Text>
          ) : null}
          {groups.map((group) => (
            <View key={group.key}>
              <Text style={styles.groupLabel}>{group.label}</Text>
              {group.items.map(({ ref, option }) => (
                <TouchableOpacity
                  key={`${group.key}/${option.id}`}
                  testID={`server-agent-skills-option-${group.key}-${option.id}`}
                  disabled={saving}
                  onPress={() => void save(addSkillRef(added, ref))}
                  accessibilityRole="button"
                  style={styles.option}
                >
                  <Text style={styles.rowName} numberOfLines={1}>
                    {option.name}
                  </Text>
                  {option.description ? (
                    <Text style={styles.hint} numberOfLines={1}>
                      {option.description}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>
      )}
      {error ? <Text style={[styles.hint, { color: colors.red400 }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  section: { marginTop: 16, gap: 6 },
  label: { color: colors.gray200, fontSize: 14, fontWeight: '600' },
  hint: { color: colors.gray500, fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rowName: { color: colors.white, fontSize: 14 },
  remove: { paddingHorizontal: 6, paddingVertical: 2 },
  removeLabel: { color: colors.gray400, fontSize: 18 },
  add: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addLabel: { color: colors.gray200, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  picker: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    backgroundColor: colors.gray900,
    padding: 8,
    gap: 4,
  },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  search: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: colors.gray950,
    color: colors.white,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  groupLabel: {
    color: colors.gray500,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginTop: 6,
  },
  option: { paddingHorizontal: 6, paddingVertical: 6 },
});
