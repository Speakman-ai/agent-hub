import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { hasRole, getUserRole } from '../utils/auth';
import { formatDateTime } from '../utils/time';
import { safeHttpHref } from '../utils/safeHttpUrl';
import {
  findCredentialRow,
  isSecretCredential,
  validateCredentialValue,
} from '@shared/utils/skillCredentialForm';
import {
  buildSkillAuthenticationPreset,
  type SkillAuthenticationPreset,
} from '@shared/utils/skillAuthentication';
import { colors } from '../theme/colors';

/**
 * Ref that always holds the latest rendered `value` (set during render). Root-
 * cause guard for the "stale async overwrites live state" race on this screen:
 * an async request captures the identity it was issued for (active project, or
 * a card's skill+agent key) and, on completion, compares it against
 * `ref.current`; if they differ, the active project/skill/agent changed while
 * the request was pending and the result is dropped instead of clobbering the
 * current view. Effects can cancel via cleanup; callbacks/late refetches cannot,
 * so they rely on this.
 */
function useLiveRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

// Stable empty array so identity-mismatched reads stay referentially constant.
const EMPTY_STRING_ARRAY: string[] = [];

const CATEGORY_STYLES: Record<string, any> = {
  platform: { bg: colors.indigo900_40, fg: colors.indigo400 },
  development: { bg: colors.blue900_40, fg: colors.blue400 },
  documentation: { bg: colors.emerald900_40, fg: colors.emerald400 },
  automation: { bg: colors.amber900_40, fg: colors.amber400 },
  git: { bg: colors.purple900_40, fg: colors.purple400 },
  monitoring: { bg: colors.rose900_40, fg: colors.rose400 },
  general: { bg: colors.gray700_40, fg: colors.gray400 },
};
const markdownStyles = {
  body: { color: colors.gray200, fontSize: 12, lineHeight: 18 },
  code_inline: {
    backgroundColor: colors.gray900,
    color: colors.emerald400,
    fontSize: 11,
    fontFamily: 'monospace',
    paddingHorizontal: 3,
  },
  code_block: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    padding: 8,
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  fence: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    padding: 8,
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  heading1: { color: colors.white, fontSize: 18, fontWeight: 'bold' },
  heading2: { color: colors.white, fontSize: 16, fontWeight: 'bold' },
  heading3: { color: colors.white, fontSize: 14, fontWeight: '600' },
  paragraph: { marginTop: 2, marginBottom: 2 },
  strong: { color: colors.white, fontWeight: 'bold' },
  link: { color: colors.blue400 },
};
function CategoryBadge({ category }: any) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.general;
  return (
    <View style={[styles.categoryBadge, { backgroundColor: style.bg }]}>
      <Text style={[styles.categoryBadgeText, { color: style.fg }]}>{category}</Text>
    </View>
  );
}
/**
 * Review queue for agent-suggested skill lessons (mobile parity with the web
 * PendingLessonsSection). `entry` is UNTRUSTED agent output — rendered as
 * plain <Text>, never markdown. The provenance line (agent, timestamp,
 * session deep link) is what lets a reviewer tell a legitimate lesson from
 * injected instructions the agent merely *read*. Approve/reject is Admin+
 * (server-enforced; the client gate is a UX hint — local/bundled installs
 * have no cached role and are treated as admin-equivalent, matching web).
 */
export function PendingLessonsSection({ projectId, improvements, onReviewed, onOpenSession }: any) {
  const canReview = hasRole('Admin') || !getUserRole();
  const [busyId, setBusyId] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [rejectingId, setRejectingId] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const review = useCallback(
    async (imp: any, action: any) => {
      setBusyId(imp.id);
      setError(null);
      try {
        if (action === 'approve') {
          await api.approveSkillImprovement(projectId, imp.skillId, imp.id);
        } else {
          await api.rejectSkillImprovement(
            projectId,
            imp.skillId,
            imp.id,
            rejectReason.trim() || undefined,
          );
        }
        setRejectingId(null);
        setRejectReason('');
        if (onReviewed) onReviewed();
      } catch (err: any) {
        setError(err?.message || String(err));
      } finally {
        setBusyId(null);
      }
    },
    [projectId, rejectReason, onReviewed],
  );
  if (!improvements?.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <View style={styles.lessonsSection} testID="pending-lessons-section">
      <Text style={styles.lessonsTitle}>⚡ Pending lessons ({improvements.length})</Text>
      <Text style={styles.lessonsHint}>
        Agents suggested these skill lessons. Approving appends the dated bullet to the skill&apos;s
        Learned Lessons — standing instructions for every future session, so check the source
        session before promoting.
      </Text>
      {error ? <Text style={styles.lessonsError}>{error}</Text> : null}
      {improvements.map((imp: any) => (
        <View key={imp.id} style={styles.lessonRow}>
          <View style={styles.lessonBadgeRow}>
            <View style={[styles.categoryBadge, { backgroundColor: colors.gray700_40 }]}>
              <Text style={[styles.categoryBadgeText, { color: colors.gray300 }]}>
                {imp.skillName || imp.skillId}
              </Text>
            </View>
            {imp.source === 'global' ? (
              <View style={[styles.categoryBadge, { backgroundColor: colors.blue900_40 }]}>
                <Text style={[styles.categoryBadgeText, { color: colors.blue400 }]}>shared</Text>
              </View>
            ) : null}
          </View>
          {/* Untrusted agent output — plain text on purpose. */}
          <Text style={styles.lessonEntry}>{imp.entry}</Text>
          <View style={styles.lessonMetaRow}>
            {imp.agentId ? <Text style={styles.lessonMeta}>🤖 {imp.agentId}</Text> : null}
            <Text style={styles.lessonMeta}>{imp.createdAt}</Text>
            {imp.sessionId && onOpenSession ? (
              <TouchableOpacity
                onPress={() => onOpenSession({ sessionId: imp.sessionId, agentId: imp.agentId })}
                hitSlop={8}
              >
                <Text style={styles.lessonSessionLink}>view source session</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.lessonPreview}>
            <Text style={styles.lessonPreviewLabel}>
              Will append as (date stamped at approval):
            </Text>
            <Text style={styles.lessonPreviewText}>
              - {today}: {imp.entry}
            </Text>
          </View>
          {canReview ? (
            <View style={styles.lessonActions}>
              <TouchableOpacity
                style={styles.lessonApproveButton}
                disabled={busyId === imp.id}
                onPress={() => review(imp, 'approve')}
                testID={`approve-lesson-${imp.id}`}
              >
                <Text style={styles.lessonApproveText}>
                  {busyId === imp.id ? 'Working…' : '✓ Approve'}
                </Text>
              </TouchableOpacity>
              {rejectingId === imp.id ? (
                <>
                  <TextInput
                    value={rejectReason}
                    onChangeText={setRejectReason}
                    placeholder="Reason (optional)"
                    placeholderTextColor={colors.gray600}
                    style={styles.lessonReasonInput}
                  />
                  <TouchableOpacity
                    style={styles.lessonRejectButton}
                    disabled={busyId === imp.id}
                    onPress={() => review(imp, 'reject')}
                    testID={`reject-lesson-${imp.id}`}
                  >
                    <Text style={styles.lessonRejectText}>✕ Confirm reject</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={styles.lessonRejectOutlineButton}
                  onPress={() => setRejectingId(imp.id)}
                >
                  <Text style={styles.lessonRejectOutlineText}>✕ Reject</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <Text style={styles.lessonMeta}>Approving requires the Admin role.</Text>
          )}
        </View>
      ))}
    </View>
  );
}
/**
 * Per-user skill-credential entry (mobile parity with the web SkillsPage
 * credential block). Renders one masked/plaintext input per declared credential
 * spec, a saved-value preview, and Save / Revoke actions. Presentational: all
 * fetch/save/delete state is owned by the parent `SkillCard`; the pure
 * schema/row/validation decisions come from `@shared/utils/skillCredentialForm`
 * so web and mobile cannot drift.
 */
export function SkillCredentialSection({
  schema,
  rows,
  inputs,
  onChangeInput,
  onSave,
  onDelete,
  loading,
  error,
  saving,
}: any) {
  if (!schema?.length) return null;
  return (
    <View style={styles.credSection} testID="skill-credential-section">
      <View style={styles.credHeaderRow}>
        <Text style={styles.credHeaderIcon}>🛡️</Text>
        <Text style={styles.credHeaderTitle}>Credentials</Text>
      </View>
      <Text style={styles.credHint}>
        Stored per signed-in user, merged into CLI spawns for enabled skills. GitHub sign-in under
        Settings wins over same-named skill vars (GH_TOKEN / GITHUB_TOKEN).
      </Text>
      {loading ? (
        <Text style={styles.credLoading}>Loading saved values…</Text>
      ) : error ? (
        <Text style={styles.credError}>{error}</Text>
      ) : (
        schema.map((spec: any) => {
          const row = findCredentialRow(rows, spec.name);
          const docsHref = safeHttpHref(spec.docs_url);
          const secret = isSecretCredential(spec);
          return (
            <View key={spec.name} style={styles.credRow}>
              <View style={styles.credRowHeader}>
                <View style={styles.credRowInfo}>
                  <Text style={styles.credLabel}>{spec.label || spec.name}</Text>
                  <Text style={styles.credKeyName}>{spec.name}</Text>
                  {spec.description ? (
                    <Text style={styles.credDescription}>{spec.description}</Text>
                  ) : null}
                  {docsHref ? (
                    <TouchableOpacity onPress={() => Linking.openURL(docsHref)} hitSlop={6}>
                      <Text style={styles.credDocsLink}>Documentation ↗</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {row?.masked_preview ? (
                  <Text style={styles.credSaved}>
                    Saved: <Text style={styles.credSavedValue}>{row.masked_preview}</Text>
                  </Text>
                ) : null}
              </View>
              <View style={styles.credInputRow}>
                <TextInput
                  secureTextEntry={secret}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  placeholder={spec.required ? 'Required' : 'Optional — paste to set'}
                  placeholderTextColor={colors.gray600}
                  value={inputs[spec.name] ?? ''}
                  onChangeText={(t: string) => onChangeInput(spec.name, t)}
                  style={styles.credInput}
                  testID={`cred-input-${spec.name}`}
                />
                <TouchableOpacity
                  disabled={saving === spec.name}
                  onPress={() => onSave(spec)}
                  style={styles.credSaveButton}
                  testID={`cred-save-${spec.name}`}
                >
                  <Text style={styles.credSaveButtonText}>
                    {saving === spec.name ? 'Saving…' : 'Save'}
                  </Text>
                </TouchableOpacity>
                {row?.id ? (
                  <TouchableOpacity
                    disabled={saving === spec.name}
                    onPress={() => onDelete(spec)}
                    style={styles.credRevokeButton}
                    testID={`cred-revoke-${spec.name}`}
                  >
                    <Text style={styles.credRevokeButtonText}>Revoke</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {row?.last_used_at ? (
                <Text style={styles.credLastUsed}>
                  Last used:{' '}
                  {formatDateTime(row.last_used_at, { dateStyle: 'short', timeStyle: 'short' })}
                </Text>
              ) : null}
            </View>
          );
        })
      )}
    </View>
  );
}
/**
 * Per-user skill options (mobile parity with the web SkillsPage options block).
 * Owner-declared enums (e.g. dev/prod) the signed-in user selects; the effective
 * value merges into CLI spawns for enabled skills. Self-contained: fetches the
 * option declarations + current selection on mount and persists a pick via
 * `putSkillOption`, refetching to reflect the new effective value. Renders
 * nothing until at least one option is declared.
 */
export function SkillOptionsSection({ skillId, agentId }: any) {
  // Options tagged with the owning identity key + DERIVED on match, so the first
  // committed render after a skill/agent switch shows no stale chips (a passive
  // effect-clear would leave that render, whose chips are wired to the freshly
  // created selectOption and could save a stale option against the new identity).
  const [optionsState, setOptionsState] = useState<{ key: string; options: any[] }>({
    key: '',
    options: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [saving, setSaving] = useState<any>(null);
  // Identity these requests belong to. A late fetch/save-refetch must not apply
  // once the section is rendering a different skill/agent (props change without
  // a remount, and the post-save `load()` is fired from a stale callback).
  const optKey = `${skillId ?? ''}::${agentId ?? ''}`;
  const optKeyRef = useLiveRef(optKey);
  const options = optionsState.key === optKey ? optionsState.options : EMPTY_STRING_ARRAY;
  const load = useCallback(async () => {
    if (!skillId) return;
    const reqKey = `${skillId ?? ''}::${agentId ?? ''}`;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getSkillOptions(skillId, agentId);
      if (optKeyRef.current !== reqKey) return;
      setOptionsState({ key: reqKey, options: Array.isArray(res?.options) ? res.options : [] });
    } catch (err: any) {
      if (optKeyRef.current !== reqKey) return;
      setError(err?.message || String(err));
      setOptionsState({ key: reqKey, options: [] });
    } finally {
      if (optKeyRef.current === reqKey) setLoading(false);
    }
  }, [skillId, agentId, optKeyRef]);
  useEffect(() => {
    // No imperative clear: `options` is derived from an identity match, so a
    // skill/agent switch shows an empty list synchronously until this load
    // stores a value tagged with the new key. The post-save refetch calls
    // load() directly (same key), so it does not flicker.
    setError(null);
    load();
  }, [load]);
  const selectOption = useCallback(
    async (optionName: string, value: string) => {
      const reqKey = optKey;
      setSaving(optionName);
      setError(null);
      try {
        await api.putSkillOption({
          skill_id: skillId,
          option_name: optionName,
          value,
          agent_id: agentId,
        });
        if (optKeyRef.current !== reqKey) return;
        await load();
      } catch (err: any) {
        if (optKeyRef.current !== reqKey) return;
        setError(err?.message || String(err));
      } finally {
        if (optKeyRef.current === reqKey) setSaving(null);
      }
    },
    [skillId, agentId, load, optKey, optKeyRef],
  );
  // Render nothing only when there is genuinely nothing to show. Keep the
  // section mounted while loading or when an error was recorded so a failed
  // initial fetch is distinguishable from a skill that declares no options.
  if (!options.length && !loading && !error) return null;
  return (
    <View style={styles.optSection} testID="skill-options-section">
      <View style={styles.optHeaderRow}>
        <Text style={styles.optHeaderIcon}>⚙️</Text>
        <Text style={styles.optHeaderTitle}>Options</Text>
        {loading ? <Text style={styles.optHint}> · Loading…</Text> : null}
      </View>
      <Text style={styles.optHint}>
        Stored per signed-in user, merged into CLI spawns for enabled skills.
      </Text>
      {error ? <Text style={styles.optError}>{error}</Text> : null}
      {options.map((option: any) => {
        const current = option.selected ?? option.default;
        return (
          <View key={option.name} style={styles.optRow}>
            <Text style={styles.optLabel}>
              {option.label || option.name}
              {option.required ? <Text style={styles.optRequired}> *</Text> : null}
            </Text>
            {option.description ? (
              <Text style={styles.optDescription}>{option.description}</Text>
            ) : null}
            <View style={styles.optChipRow}>
              {(option.choices || []).map((choice: any) => {
                const active = choice.value === current;
                return (
                  <TouchableOpacity
                    key={choice.value}
                    disabled={saving === option.name}
                    onPress={() => selectOption(option.name, choice.value)}
                    style={[styles.optChip, active && styles.optChipActive]}
                    testID={`skill-option-choice-${option.name}-${choice.value}`}
                  >
                    <Text style={[styles.optChipText, active && styles.optChipTextActive]}>
                      {choice.label || choice.value}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}
export function SkillCard({
  skill,
  agentId,
  projectId,
  overrides,
  onToggle,
  onUninstall,
  isInstalled,
  pendingCount = 0,
  isDefaultOn,
  onToggleDefault,
  canManageCredentials = false,
}: any) {
  const [expanded, setExpanded] = useState(false);
  const [fullContent, setFullContent] = useState(skill.content || null);
  const [loading, setLoading] = useState(false);
  const [schemaLoaded, setSchemaLoaded] = useState(Array.isArray(skill.credentials));
  const [credentialSchema, setCredentialSchema] = useState<any[]>(
    Array.isArray(skill.credentials) ? skill.credentials : [],
  );
  const [credentialRows, setCredentialRows] = useState<any[]>([]);
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState<any>(null);
  const [credSaving, setCredSaving] = useState<any>(null);
  const [authSetupSaving, setAuthSetupSaving] = useState<SkillAuthenticationPreset | null>(null);
  const [authSetupError, setAuthSetupError] = useState<any>(null);
  const [credentialInputs, setCredentialInputs] = useState<Record<string, any>>({});
  const override = overrides?.find((o: any) => o.skill_id === skill.id);
  const isEnabled = override ? !!override.enabled : true;
  const credentialSchemaKey = useMemo(
    () => JSON.stringify(credentialSchema ?? []),
    [credentialSchema],
  );
  useEffect(() => {
    if (!Array.isArray(skill.credentials)) return;
    setCredentialSchema(skill.credentials);
    setSchemaLoaded(true);
  }, [skill.id, skill.credentials]);
  // Load the per-user saved credential rows once the schema is known, the card
  // is expanded, and an agent is in focus (credentials are per-user but keyed
  // through the agent-scoped save). Keyed on the schema so it refetches if the
  // schema changes.
  useEffect(() => {
    if (!expanded || credentialSchemaKey === '[]' || !agentId) return;
    let cancelled = false;
    (async () => {
      setCredLoading(true);
      setCredError(null);
      try {
        const pack = await api.getSkillCredentials(skill.id);
        if (!cancelled) setCredentialRows(pack.credentials || []);
      } catch (err: any) {
        if (!cancelled) {
          setCredError(err?.message || String(err));
          setCredentialRows([]);
        }
      } finally {
        if (!cancelled) setCredLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, skill.id, agentId, credentialSchemaKey]);
  const handleChangeInput = useCallback((name: string, value: string) => {
    setCredentialInputs((prev: any) => ({ ...prev, [name]: value }));
  }, []);
  const saveCredential = useCallback(
    async (spec: any) => {
      const val = credentialInputs[spec.name] ?? '';
      const validationError = validateCredentialValue(spec, val);
      if (validationError) {
        setCredError(validationError);
        return;
      }
      setCredSaving(spec.name);
      setCredError(null);
      try {
        await api.putSkillCredential({
          skill_id: skill.id,
          key_name: spec.name,
          value: String(val),
          agent_id: agentId,
        });
        const pack = await api.getSkillCredentials(skill.id);
        setCredentialRows(pack.credentials || []);
        setCredentialInputs((prev: any) => ({ ...prev, [spec.name]: '' }));
      } catch (err: any) {
        setCredError(err?.message || String(err));
      } finally {
        setCredSaving(null);
      }
    },
    [credentialInputs, skill.id, agentId],
  );
  const deleteCredential = useCallback(
    async (spec: any) => {
      const row = findCredentialRow(credentialRows, spec.name);
      if (!row?.id) return;
      setCredSaving(spec.name);
      setCredError(null);
      try {
        await api.deleteSkillCredential(row.id);
        const pack = await api.getSkillCredentials(skill.id);
        setCredentialRows(pack.credentials || []);
      } catch (err: any) {
        setCredError(err?.message || String(err));
      } finally {
        setCredSaving(null);
      }
    },
    [credentialRows, skill.id],
  );
  const setupAuthentication = useCallback(
    async (preset: SkillAuthenticationPreset) => {
      if (!projectId || skill.source !== 'project' || !canManageCredentials) return;
      setAuthSetupSaving(preset);
      setAuthSetupError(null);
      try {
        const latest = await api.getProjectSkill(projectId, skill.id);
        const latestCredentials = Array.isArray(latest.credentials) ? latest.credentials : [];
        if (latestCredentials.length > 0) {
          setFullContent(latest.content);
          setCredentialSchema(latestCredentials);
          setSchemaLoaded(true);
          return;
        }
        const credentials = buildSkillAuthenticationPreset(skill.id, preset);
        await api.updateProjectSkill(projectId, skill.id, {
          name: skill.id,
          content: latest.content,
          credentials,
          expectedCredentials: [],
        });
        setFullContent(latest.content);
        setCredentialSchema(credentials);
        setSchemaLoaded(true);
      } catch (err: any) {
        setAuthSetupError(err?.message || String(err));
      } finally {
        setAuthSetupSaving(null);
      }
    },
    [projectId, skill.id, skill.source, canManageCredentials],
  );
  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    const canReadProject = skill.source === 'project' && projectId;
    if (
      (agentId || skill.source === 'global' || canReadProject) &&
      (!fullContent || !schemaLoaded)
    ) {
      setLoading(true);
      try {
        // Read from the tier the skill lives in: global → global tier;
        // project → the project-owned read (works without an agent);
        // otherwise → the agent-scoped merged read. The credential schema
        // only comes from this read, so guard the refetch on schemaLoaded.
        const data =
          skill.source === 'global'
            ? await api.getGlobalSkill(skill.id)
            : canReadProject
              ? await api.getProjectSkill(projectId, skill.id)
              : await api.getSkill(agentId, skill.id);
        setFullContent(data.content);
        setCredentialSchema(Array.isArray(data.credentials) ? data.credentials : []);
        setSchemaLoaded(true);
      } catch {
        setFullContent('Failed to load skill content.');
        setCredentialSchema([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };
  return (
    <View style={[styles.card, !isEnabled && styles.cardDisabled]}>
      <TouchableOpacity style={styles.cardHeader} onPress={handleExpand}>
        <View style={styles.cardHeaderContent}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {skill.name}
            </Text>
            <CategoryBadge category={skill.category || 'general'} />
            {skill.source === 'default' && (
              <View style={[styles.categoryBadge, { backgroundColor: colors.gray700_40 }]}>
                <Text style={[styles.categoryBadgeText, { color: colors.gray500 }]}>built-in</Text>
              </View>
            )}
            {skill.source === 'global' && (
              <View style={[styles.categoryBadge, { backgroundColor: colors.blue900_40 }]}>
                <Text style={[styles.categoryBadgeText, { color: colors.blue400 }]}>shared</Text>
              </View>
            )}
            {pendingCount > 0 && (
              <View
                style={[styles.categoryBadge, { backgroundColor: colors.amber900_40 }]}
                testID={`skill-pending-badge-${skill.id}`}
              >
                <Text style={[styles.categoryBadgeText, { color: colors.amber400 }]}>
                  ⚡ {pendingCount}
                </Text>
              </View>
            )}
          </View>
          {skill.description && (
            <Text style={styles.cardDescription} numberOfLines={2}>
              {skill.description}
            </Text>
          )}
          {skill.source === 'project' ? (
            <TouchableOpacity
              style={styles.authLink}
              onPress={(event: any) => {
                event.stopPropagation?.();
                if (!expanded) void handleExpand();
              }}
              testID={`skill-auth-toggle-${skill.id}`}
            >
              <Text style={styles.authLinkText}>
                🔐 {credentialSchema.length > 0 ? 'Authentication' : 'Add authentication'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.cardHeaderActions}>
          {onToggle && (
            <TouchableOpacity
              onPress={(e: any) => {
                e.stopPropagation?.();
                onToggle(skill.id, !isEnabled);
              }}
              style={styles.iconButton}
              hitSlop={8}
            >
              <Text style={[styles.toggleText, isEnabled && styles.toggleTextActive]}>
                {isEnabled ? '● on' : '○ off'}
              </Text>
            </TouchableOpacity>
          )}
          {onUninstall && isInstalled && skill.source !== 'default' && (
            <TouchableOpacity
              onPress={(e: any) => {
                e.stopPropagation?.();
                onUninstall(skill.id, skill.source);
              }}
              style={styles.iconButton}
              hitSlop={8}
            >
              <Text style={styles.trashText}>Del</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.cardBody}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.gray500} />
          ) : (
            <>
              <ScrollView style={styles.cardScroll} nestedScrollEnabled>
                <Markdown style={markdownStyles as any}>{fullContent || ''}</Markdown>
              </ScrollView>
              {onToggleDefault && skill.source === 'project' ? (
                <TouchableOpacity
                  style={styles.defaultToggleRow}
                  onPress={() => onToggleDefault(skill.id, !isDefaultOn)}
                  testID={`skill-default-toggle-${skill.id}`}
                >
                  <Text
                    style={[
                      styles.defaultToggleText,
                      isDefaultOn && styles.defaultToggleTextActive,
                    ]}
                  >
                    {isDefaultOn ? '● ' : '○ '}
                  </Text>
                  <Text style={styles.defaultToggleLabel}>On by default for this project</Text>
                </TouchableOpacity>
              ) : null}
              {skill.source === 'project' && credentialSchema.length === 0 ? (
                <View style={styles.authSetup} testID={`skill-auth-setup-${skill.id}`}>
                  <Text style={styles.authSetupTitle}>🔐 Authentication is not configured</Text>
                  <Text style={styles.authSetupHint}>
                    Choose the login shape. Agent Hub adds field definitions to the skill and keeps
                    each user&apos;s values encrypted outside SKILL.md.
                  </Text>
                  {authSetupError ? <Text style={styles.credError}>{authSetupError}</Text> : null}
                  {canManageCredentials ? (
                    <View style={styles.authSetupActions}>
                      <TouchableOpacity
                        disabled={!!authSetupSaving}
                        onPress={() => setupAuthentication('api-key')}
                        style={[styles.authSetupButton, !!authSetupSaving && styles.buttonDisabled]}
                        testID={`skill-auth-api-key-${skill.id}`}
                      >
                        <Text style={styles.authSetupButtonText}>
                          {authSetupSaving === 'api-key' ? 'Adding…' : 'API key'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        disabled={!!authSetupSaving}
                        onPress={() => setupAuthentication('username-password')}
                        style={[
                          styles.authSetupButtonSecondary,
                          !!authSetupSaving && styles.buttonDisabled,
                        ]}
                        testID={`skill-auth-username-password-${skill.id}`}
                      >
                        <Text style={styles.authSetupButtonSecondaryText}>
                          {authSetupSaving === 'username-password'
                            ? 'Adding…'
                            : 'Username & password'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <Text style={styles.authSetupHint}>
                      An Admin can add authentication fields for this project skill.
                    </Text>
                  )}
                </View>
              ) : null}
              {credentialSchema.length > 0 && agentId ? (
                <SkillCredentialSection
                  schema={credentialSchema}
                  rows={credentialRows}
                  inputs={credentialInputs}
                  onChangeInput={handleChangeInput}
                  onSave={saveCredential}
                  onDelete={deleteCredential}
                  loading={credLoading}
                  error={credError}
                  saving={credSaving}
                />
              ) : null}
              {agentId ? <SkillOptionsSection skillId={skill.id} agentId={agentId} /> : null}
            </>
          )}
        </View>
      )}
    </View>
  );
}
function ContextFilePanel({ filename, content, agentId, onSaved }: any) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(content || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setEditContent(content || '');
  }, [content]);
  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveContext(agentId, filename, editContent);
      setEditing(false);
      if (onSaved) onSaved(filename, editContent);
    } catch (err: any) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };
  if (!content && content !== '') return null;
  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.contextHeader} onPress={() => setExpanded(!expanded)}>
        <Text style={styles.contextFilename}>{filename}</Text>
        <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={styles.cardBody}>
          <View style={styles.editButtons}>
            <TouchableOpacity
              style={[styles.editButton, editing && styles.editButtonActive]}
              onPress={() => setEditing(!editing)}
            >
              <Text style={[styles.editButtonText, editing && styles.editButtonTextActive]}>
                {editing ? 'Editing' : 'Edit'}
              </Text>
            </TouchableOpacity>
            {editing && (
              <TouchableOpacity style={styles.saveButton} onPress={handleSave} disabled={saving}>
                <Text style={styles.saveButtonText}>{saving ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            )}
          </View>
          {editing ? (
            <TextInput
              value={editContent}
              onChangeText={setEditContent}
              multiline
              style={styles.editTextarea}
              textAlignVertical="top"
            />
          ) : (
            <ScrollView style={styles.cardScroll} nestedScrollEnabled>
              <Markdown style={markdownStyles as any}>{content || '*(empty)*'}</Markdown>
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}
export default function SkillsScreen() {
  const {
    agents,
    projects,
    handleStartSkillBuilderMode,
    skillImprovementRefreshKey,
    handleOpenHandoffSession,
  } = useApp();
  const navigation = useNavigation<any>();
  const visibleProjects = useMemo(() => (projects || []).filter((p: any) => p?.id), [projects]);
  const [activeProjectId, setActiveProjectId] = useState(visibleProjects[0]?.id || null);
  // Live ref so async completions (read effect AND the toggle callback) can drop
  // their result when the active project changed while the request was pending.
  const activeProjectIdRef = useLiveRef(activeProjectId);
  // null = follow the default reference agent; otherwise the user-picked agent
  // whose overrides + context this screen is inspecting.
  const [selectedAgentId, setSelectedAgentId] = useState<any>(null);
  const [skills, setSkills] = useState<any[]>([]);
  // Built-in (default) + shared (global) skills catalog — the same list the
  // web Settings → Global Skills page shows. Kept reachable on mobile so the
  // project/global split doesn't hide built-in/shared skills entirely.
  const [globalSkills, setGlobalSkills] = useState<any[]>([]);
  const [context, setContext] = useState<any>({});
  const [overrides, setOverrides] = useState<any[]>([]);
  // Agent-suggested lessons awaiting review (project + global tiers).
  const [improvements, setImprovements] = useState<any[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  // Per-project default-on skills (auto-loaded into every session). Admin-only
  // writes; when the role is unknown we still render the toggle and let the
  // server surface a 403 (matches the PendingLessonsSection gating pattern).
  //
  // Tag the loaded ids with their project and DERIVE the rendered ids from an
  // identity match, so a project switch is stale-safe at render time (not via a
  // passive effect that only clears after the first render commits). During the
  // render for a newly-selected project — before its own load resolves — the
  // ids don't match and every toggle reads off, so a tap can't apply the
  // previous project's on/off intent to the new project.
  const [defaultSkills, setDefaultSkills] = useState<{
    projectId: string | null;
    ids: string[];
  }>({ projectId: null, ids: [] });
  const defaultSkillIds =
    defaultSkills.projectId === activeProjectId ? defaultSkills.ids : EMPTY_STRING_ARRAY;
  const canEditDefaults = hasRole('Admin') || !getUserRole();
  useEffect(() => {
    if (!activeProjectId && visibleProjects[0]?.id) setActiveProjectId(visibleProjects[0].id);
  }, [activeProjectId, visibleProjects]);
  // Every active agent in the selected project, in a stable order.
  const projectAgents = useMemo(
    () => (agents || []).filter((a: any) => a.projectId === activeProjectId && a.active !== false),
    [agents, activeProjectId],
  );
  // Default pick: a non-helper agent, else the first in the project.
  const referenceAgent = useMemo(() => {
    if (!activeProjectId) return null;
    return (
      projectAgents.find(
        (a: any) => a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs',
      ) ||
      projectAgents[0] ||
      null
    );
  }, [projectAgents, activeProjectId]);
  // Skill Builder is a dev-agent mode; only offer "Build a skill" when the
  // project has a non-helper agent to run it on.
  const hasDevAgent = useMemo(
    () =>
      projectAgents.some(
        (a: any) => a.role !== 'skill-builder' && a.role !== 'reviewer' && a.role !== 'docs',
      ),
    [projectAgents],
  );
  // Agent in focus: explicit selection when still in this project, else the default.
  const activeAgent = useMemo(() => {
    if (selectedAgentId) {
      const picked = projectAgents.find((a: any) => a.id === selectedAgentId);
      if (picked) return picked;
    }
    return referenceAgent;
  }, [selectedAgentId, projectAgents, referenceAgent]);
  const referenceAgentId = activeAgent?.id || null;
  // Reset the agent selection when the project changes so a stale id from a
  // previously-viewed project does not leak through.
  useEffect(() => {
    setSelectedAgentId(null);
  }, [activeProjectId]);
  const startSkillBuilder = useCallback(async () => {
    if (!activeProjectId || !handleStartSkillBuilderMode) return;
    try {
      await handleStartSkillBuilderMode(activeProjectId);
      navigation.navigate('Chat');
    } catch (err: any) {
      console.error('Failed to start Skill Builder session:', err);
    }
  }, [activeProjectId, handleStartSkillBuilderMode, navigation]);
  useEffect(() => {
    if (!activeProjectId) return;
    // The rendered ids are derived from `defaultSkills.projectId === activeProjectId`,
    // so a project switch is stale-safe at render time without a passive clear.
    // Still guard the async responses so a losing race can't overwrite state.
    const requestedProjectId = activeProjectId;
    let cancelled = false;
    setLoadingSkills(true);
    api
      .getProjectSkills(activeProjectId)
      .then((rows: any) => {
        if (!cancelled) setSkills(rows);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSkills(false);
      });
    // The global catalog (built-in + shared) is project-independent.
    api
      .getGlobalSkills()
      .then((rows: any) => setGlobalSkills(Array.isArray(rows) ? rows : []))
      .catch(() => setGlobalSkills([]));
    // Per-project default-on skill ids (drives the "On by default" toggle).
    api
      .getProjectDefaultSkills(requestedProjectId)
      .then((res: any) => {
        if (cancelled || requestedProjectId !== activeProjectIdRef.current) return;
        setDefaultSkills({
          projectId: requestedProjectId,
          ids: Array.isArray(res?.skillIds) ? res.skillIds : [],
        });
      })
      .catch(() => {
        if (cancelled || requestedProjectId !== activeProjectIdRef.current) return;
        setDefaultSkills({ projectId: requestedProjectId, ids: [] });
      });
    if (!referenceAgentId) {
      setOverrides([]);
      setContext({});
      setLoadingContext(false);
      return () => {
        cancelled = true;
      };
    }
    setLoadingContext(true);
    api
      .getContext(referenceAgentId)
      .then((ctx: any) => {
        if (!cancelled) setContext(ctx);
      })
      .catch(() => {
        if (!cancelled) setContext({});
      })
      .finally(() => {
        if (!cancelled) setLoadingContext(false);
      });
    api
      .getSkillOverrides(referenceAgentId)
      .then((rows: any) => {
        if (!cancelled) setOverrides(rows);
      })
      .catch(() => {
        if (!cancelled) setOverrides([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, referenceAgentId, activeProjectIdRef]);
  const handleToggle = useCallback(
    async (skillId: any, enabled: any) => {
      if (!referenceAgentId) return;
      try {
        await api.toggleSkill(referenceAgentId, skillId, enabled);
        setOverrides((prev: any) => {
          const existing = prev.findIndex((o: any) => o.skill_id === skillId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = { ...updated[existing], enabled: enabled ? 1 : 0 };
            return updated;
          }
          return [
            ...prev,
            { agent_id: referenceAgentId, skill_id: skillId, enabled: enabled ? 1 : 0 },
          ];
        });
      } catch (err: any) {
        console.error('Failed to toggle skill:', err);
      }
    },
    [referenceAgentId],
  );
  const handleUninstall = useCallback(
    async (skillId: any, source: any) => {
      if (source !== 'project') return;
      try {
        if (!activeProjectId) return;
        await api.uninstallSkill(activeProjectId, skillId);
        setSkills((prev: any) => prev.filter((s: any) => s.id !== skillId));
      } catch (err: any) {
        console.error('Failed to uninstall:', err);
      }
    },
    [activeProjectId],
  );
  const handleContextSaved = (filename: any, newContent: any) => {
    setContext((prev: any) => ({ ...prev, [filename]: newContent }));
  };
  const handleToggleDefault = useCallback(
    async (skillId: any, on: any) => {
      if (!activeProjectId) return;
      const requestedProjectId = activeProjectId;
      try {
        const res = on
          ? await api.addProjectDefaultSkill(requestedProjectId, skillId)
          : await api.removeProjectDefaultSkill(requestedProjectId, skillId);
        // Drop the result if the user switched projects mid-flight — otherwise
        // this project's ids would overwrite the now-active project's toggles.
        if (requestedProjectId !== activeProjectIdRef.current) return;
        if (Array.isArray(res?.skillIds)) {
          setDefaultSkills({ projectId: requestedProjectId, ids: res.skillIds });
        } else {
          setDefaultSkills((prev) => {
            const base = prev.projectId === requestedProjectId ? prev.ids : [];
            const ids = on ? [...new Set([...base, skillId])] : base.filter((id) => id !== skillId);
            return { projectId: requestedProjectId, ids };
          });
        }
      } catch (err: any) {
        console.error('Failed to toggle project default skill:', err);
      }
    },
    [activeProjectId, activeProjectIdRef],
  );
  // Load the pending-lessons queue; refetch when the server broadcasts
  // `skill_improvement_update` (AppContext bumps skillImprovementRefreshKey).
  const loadImprovements = useCallback(() => {
    if (!activeProjectId) {
      setImprovements([]);
      return;
    }
    api
      .getSkillImprovements(activeProjectId)
      .then((data: any) => setImprovements(data?.improvements || []))
      .catch(() => setImprovements([]));
  }, [activeProjectId]);
  useEffect(() => {
    loadImprovements();
  }, [loadImprovements, skillImprovementRefreshKey]);
  const pendingCountBySkill = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const imp of improvements) counts[imp.skillId] = (counts[imp.skillId] || 0) + 1;
    return counts;
  }, [improvements]);
  // Same object-shape callback as the web SkillsPage `onOpenSession` prop,
  // so the PendingLessonsSection contract is identical across platforms.
  const openLessonSession = useCallback(
    ({ sessionId, agentId }: any) => {
      if (!handleOpenHandoffSession) return;
      handleOpenHandoffSession(agentId, sessionId);
      navigation.navigate('Chat');
    },
    [handleOpenHandoffSession, navigation],
  );
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.pageTitle}>Skills & Context</Text>

        {/* Project selector — multi-project users pick which project's skills to manage */}
        {visibleProjects.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.agentTabs}
            contentContainerStyle={styles.agentTabsContent}
            accessibilityLabel="Select project"
          >
            {visibleProjects.map((project: any) => (
              <TouchableOpacity
                key={project.id}
                style={[styles.agentTab, activeProjectId === project.id && styles.agentTabActive]}
                onPress={() => setActiveProjectId(project.id)}
              >
                <View
                  style={[styles.tabDot, { backgroundColor: project.color || colors.gray500 }]}
                />
                <Text
                  style={[
                    styles.agentTabText,
                    activeProjectId === project.id && styles.agentTabTextActive,
                  ]}
                >
                  {project.name || project.id}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}

        {/* Agent selector — per-agent skill overrides + context are inspected one agent at a time */}
        {projectAgents.length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.agentTabs}
            contentContainerStyle={styles.agentTabsContent}
            accessibilityLabel="Select agent for overrides"
          >
            {projectAgents.map((agent: any) => (
              <TouchableOpacity
                key={agent.id}
                style={[styles.agentTab, referenceAgentId === agent.id && styles.agentTabActive]}
                onPress={() => setSelectedAgentId(agent.id)}
              >
                <View style={[styles.tabDot, { backgroundColor: agent.color || colors.gray500 }]} />
                <Text
                  style={[
                    styles.agentTabText,
                    referenceAgentId === agent.id && styles.agentTabTextActive,
                  ]}
                >
                  {agent.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : null}

        {/* Project skills — gated on the PROJECT only (project-owned), so an
            agentless project with skills still shows them. The per-agent toggle
            is a no-op without an agent, and editing/inspect reads project-owned. */}
        {activeProjectId ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Skills</Text>
              <Text style={styles.sectionCount}>({skills.length} total)</Text>
              {handleStartSkillBuilderMode && hasDevAgent ? (
                <TouchableOpacity
                  style={styles.buildSkillButton}
                  onPress={startSkillBuilder}
                  accessibilityLabel="Build a skill"
                >
                  <Text style={styles.buildSkillButtonText}>+ Build a skill</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <PendingLessonsSection
              projectId={activeProjectId}
              improvements={improvements}
              onReviewed={loadImprovements}
              onOpenSession={openLessonSession}
            />
            {loadingSkills ? (
              <ActivityIndicator
                size="small"
                color={colors.gray500}
                style={{ marginVertical: 20 }}
              />
            ) : skills.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No skills found</Text>
                <Text style={styles.emptyHint}>
                  Use Build a skill or add files under skills/ in the project workspace
                </Text>
              </View>
            ) : (
              <View style={styles.cardList}>
                {skills.map((skill: any) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    agentId={referenceAgentId}
                    projectId={activeProjectId}
                    overrides={overrides}
                    onToggle={referenceAgentId ? handleToggle : undefined}
                    onUninstall={handleUninstall}
                    isInstalled
                    pendingCount={pendingCountBySkill[skill.id] || 0}
                    isDefaultOn={defaultSkillIds.includes(skill.id)}
                    onToggleDefault={canEditDefaults ? handleToggleDefault : undefined}
                    canManageCredentials={canEditDefaults}
                  />
                ))}
              </View>
            )}
          </View>
        ) : null}

        {/* Context Files — needs a reference agent (workspace identity). */}
        {activeProjectId && activeAgent ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Context Files</Text>
              <Text style={styles.sectionCount}>(workspace identity)</Text>
            </View>
            {loadingContext ? (
              <ActivityIndicator
                size="small"
                color={colors.gray500}
                style={{ marginVertical: 20 }}
              />
            ) : Object.keys(context).length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No context files found</Text>
                <Text style={styles.emptyHint}>Add .md files to {activeAgent.workspace}/</Text>
              </View>
            ) : (
              <View style={styles.cardList}>
                {Object.entries(context).map(([filename, content]: any) => (
                  <ContextFilePanel
                    key={filename}
                    filename={filename}
                    content={content}
                    agentId={referenceAgentId}
                    onSaved={handleContextSaved}
                  />
                ))}
              </View>
            )}
          </View>
        ) : null}

        {/* Built-in & Shared skills — the global catalog (project-independent), so
            built-in/shared skills stay inspectable/toggleable on mobile after the
            project/global split. Shown whenever a project is selected (an agent
            is only needed for the per-agent enable/disable toggle). */}
        {activeProjectId && globalSkills.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Built-in &amp; Shared</Text>
              <Text style={styles.sectionCount}>({globalSkills.length})</Text>
            </View>
            <View style={styles.cardList}>
              {globalSkills.map((skill: any) => (
                <SkillCard
                  key={`global-${skill.id}`}
                  skill={skill}
                  agentId={referenceAgentId}
                  overrides={overrides}
                  onToggle={referenceAgentId ? handleToggle : undefined}
                  isInstalled
                  isDefaultOn={defaultSkillIds.includes(skill.id)}
                  onToggleDefault={canEditDefaults ? handleToggleDefault : undefined}
                />
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray950,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  pageTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.white,
    marginBottom: 16,
  },
  mainTabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.gray700,
    marginBottom: 16,
    gap: 4,
  },
  mainTab: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -1,
  },
  mainTabActive: {
    borderBottomColor: colors.indigo500,
  },
  mainTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray400,
  },
  mainTabTextActive: {
    color: colors.white,
  },
  agentTabs: {
    marginBottom: 16,
    marginHorizontal: -4,
  },
  agentTabsContent: {
    gap: 6,
    paddingHorizontal: 4,
  },
  agentTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
  },
  agentTabActive: {
    backgroundColor: colors.gray800,
  },
  tabDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  agentTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray400,
  },
  agentTabTextActive: {
    color: colors.white,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
  },
  sectionCount: {
    fontSize: 12,
    color: colors.gray500,
  },
  sectionSubtitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.gray500,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  buildSkillButton: {
    marginLeft: 'auto',
    backgroundColor: colors.indigo600,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  buildSkillButtonText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  cardList: {
    gap: 8,
  },
  card: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    overflow: 'hidden',
  },
  cardDisabled: {
    opacity: 0.5,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  cardHeaderContent: {
    flex: 1,
    minWidth: 0,
  },
  cardHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 8,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray100,
    maxWidth: 180,
  },
  cardDescription: {
    fontSize: 12,
    color: colors.gray400,
    marginTop: 4,
  },
  authLink: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingVertical: 2,
  },
  authLinkText: {
    fontSize: 11,
    color: colors.amber400,
  },
  expandIcon: {
    fontSize: 12,
    color: colors.gray500,
    marginLeft: 4,
  },
  iconButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  toggleText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.gray500,
  },
  toggleTextActive: {
    color: colors.emerald400,
  },
  trashText: {
    fontSize: 14,
  },
  cardBody: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    padding: 14,
  },
  cardScroll: {
    maxHeight: 300,
  },
  categoryBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  categoryBadgeText: {
    fontSize: 10,
    fontWeight: '500',
  },
  // Per-user skill credential entry
  authSetup: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: 'rgba(69, 26, 3, 0.15)',
    borderRadius: 10,
    padding: 12,
  },
  authSetupTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray200,
  },
  authSetupHint: {
    marginTop: 6,
    fontSize: 11,
    lineHeight: 16,
    color: colors.gray400,
  },
  authSetupActions: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  authSetupButton: {
    backgroundColor: colors.indigo600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  authSetupButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.white,
  },
  authSetupButtonSecondary: {
    borderWidth: 1,
    borderColor: colors.gray600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  authSetupButtonSecondaryText: {
    fontSize: 11,
    color: colors.gray200,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  credSection: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: 'rgba(17, 24, 39, 0.35)',
    borderRadius: 10,
    padding: 12,
  },
  credHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  credHeaderIcon: {
    fontSize: 13,
  },
  credHeaderTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray200,
  },
  credHint: {
    fontSize: 10,
    color: colors.gray500,
    lineHeight: 14,
    marginBottom: 10,
  },
  credLoading: {
    fontSize: 12,
    color: colors.gray500,
  },
  credError: {
    fontSize: 12,
    color: colors.amber400,
  },
  credRow: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 12,
    marginTop: 12,
  },
  credRowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  credRowInfo: {
    flex: 1,
    minWidth: 0,
  },
  credLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.gray200,
  },
  credKeyName: {
    fontSize: 10,
    fontFamily: 'monospace',
    color: colors.gray500,
  },
  credDescription: {
    fontSize: 11,
    color: colors.gray400,
    marginTop: 2,
  },
  credDocsLink: {
    fontSize: 11,
    color: colors.indigo400,
    marginTop: 2,
  },
  credSaved: {
    fontSize: 10,
    color: colors.gray500,
  },
  credSavedValue: {
    fontFamily: 'monospace',
    color: colors.gray300,
  },
  credInputRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  credInput: {
    flex: 1,
    minWidth: 160,
    borderWidth: 1,
    borderColor: colors.gray600,
    backgroundColor: colors.gray900,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 12,
    color: colors.gray100,
  },
  credSaveButton: {
    backgroundColor: colors.indigo600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  credSaveButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.white,
  },
  credRevokeButton: {
    borderWidth: 1,
    borderColor: colors.gray600,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  credRevokeButtonText: {
    fontSize: 11,
    color: colors.gray300,
  },
  credLastUsed: {
    fontSize: 10,
    color: colors.gray600,
    marginTop: 6,
  },
  // Per-project default-on toggle
  defaultToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingVertical: 4,
  },
  defaultToggleText: {
    fontSize: 13,
    color: colors.gray500,
  },
  defaultToggleTextActive: {
    color: colors.emerald400,
  },
  defaultToggleLabel: {
    fontSize: 12,
    color: colors.gray300,
  },
  // Per-user skill options (owner-declared enums)
  optSection: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: 'rgba(17, 24, 39, 0.35)',
    borderRadius: 10,
    padding: 12,
  },
  optHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  optHeaderIcon: {
    fontSize: 13,
  },
  optHeaderTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray200,
  },
  optHint: {
    fontSize: 10,
    color: colors.gray500,
    lineHeight: 14,
    marginBottom: 10,
  },
  optError: {
    fontSize: 12,
    color: colors.amber400,
    marginBottom: 6,
  },
  optRow: {
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    paddingTop: 12,
    marginTop: 12,
  },
  optLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.gray200,
  },
  optRequired: {
    color: colors.amber400,
  },
  optDescription: {
    fontSize: 11,
    color: colors.gray400,
    marginTop: 2,
  },
  optChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  optChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  optChipActive: {
    backgroundColor: colors.indigo600,
    borderColor: colors.indigo600,
  },
  optChipText: {
    fontSize: 12,
    color: colors.gray400,
    fontWeight: '500',
  },
  optChipTextActive: {
    color: colors.white,
  },
  // Pending-lessons review queue (skill improvements)
  lessonsSection: {
    borderWidth: 1,
    borderColor: colors.amber900_40,
    backgroundColor: 'rgba(120, 53, 15, 0.08)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  lessonsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.amber400,
    marginBottom: 4,
  },
  lessonsHint: {
    fontSize: 10,
    color: colors.gray500,
    lineHeight: 14,
    marginBottom: 6,
  },
  lessonsError: {
    fontSize: 11,
    color: colors.red400,
    marginBottom: 6,
  },
  lessonRow: {
    borderTopWidth: 1,
    borderTopColor: colors.amber900_40,
    paddingTop: 10,
    marginTop: 4,
    marginBottom: 6,
  },
  lessonBadgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6,
  },
  lessonEntry: {
    fontSize: 12,
    color: colors.gray200,
    lineHeight: 17,
  },
  lessonMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 4,
    alignItems: 'center',
  },
  lessonMeta: {
    fontSize: 10,
    color: colors.gray500,
  },
  lessonSessionLink: {
    fontSize: 10,
    color: colors.indigo400,
  },
  lessonPreview: {
    backgroundColor: colors.gray900,
    borderRadius: 6,
    padding: 8,
    marginTop: 6,
  },
  lessonPreviewLabel: {
    fontSize: 9,
    color: colors.gray500,
    marginBottom: 2,
  },
  lessonPreviewText: {
    fontSize: 11,
    color: colors.emerald300,
    fontFamily: 'monospace',
  },
  lessonActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    alignItems: 'center',
  },
  lessonApproveButton: {
    backgroundColor: colors.emerald700,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  lessonApproveText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.white,
  },
  lessonRejectButton: {
    backgroundColor: colors.red900_50,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  lessonRejectText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.red400,
  },
  lessonRejectOutlineButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  lessonRejectOutlineText: {
    fontSize: 11,
    color: colors.gray300,
  },
  lessonReasonInput: {
    flex: 1,
    minWidth: 140,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 11,
    color: colors.gray100,
  },
  installCount: {
    fontSize: 10,
    color: colors.gray500,
  },
  installButton: {
    backgroundColor: colors.indigo600,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  installButtonDisabled: {
    backgroundColor: colors.gray700,
  },
  installButtonText: {
    fontSize: 12,
    color: colors.white,
    fontWeight: '500',
  },
  installButtonTextDisabled: {
    color: colors.gray500,
  },
  metaText: {
    fontSize: 11,
    color: colors.gray500,
    marginTop: 8,
  },
  searchRow: {
    marginBottom: 10,
  },
  searchInput: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.gray100,
    fontSize: 14,
  },
  categoryRow: {
    marginBottom: 10,
    marginHorizontal: -4,
  },
  categoryRowContent: {
    gap: 6,
    paddingHorizontal: 4,
  },
  categoryPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  categoryPillActive: {
    backgroundColor: colors.indigo600,
    borderColor: colors.indigo600,
  },
  categoryPillText: {
    fontSize: 12,
    color: colors.gray400,
    fontWeight: '500',
  },
  categoryPillTextActive: {
    color: colors.white,
  },
  importButton: {
    backgroundColor: colors.gray800,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  importButtonText: {
    fontSize: 13,
    color: colors.gray300,
    fontWeight: '500',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.black60,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 20,
    width: '100%',
    maxWidth: 500,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
  },
  modalClose: {
    fontSize: 18,
    color: colors.gray400,
    paddingHorizontal: 6,
  },
  modalHint: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 12,
  },
  modalInput: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.gray100,
    fontSize: 13,
    marginBottom: 12,
  },
  modalError: {
    fontSize: 12,
    color: colors.red400,
    marginBottom: 12,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  modalButtonSecondary: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalButtonSecondaryText: {
    fontSize: 14,
    color: colors.gray400,
  },
  modalButtonPrimary: {
    backgroundColor: colors.indigo600,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  modalButtonDisabled: {
    opacity: 0.5,
  },
  modalButtonPrimaryText: {
    fontSize: 14,
    color: colors.white,
    fontWeight: '500',
  },
  contextHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  contextFilename: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.gray300,
  },
  editButtons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  editButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.gray700,
  },
  editButtonActive: {
    backgroundColor: 'rgba(30, 64, 175, 0.5)',
  },
  editButtonText: {
    fontSize: 12,
    color: colors.gray400,
  },
  editButtonTextActive: {
    color: colors.blue400,
  },
  saveButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.emerald800_50,
  },
  saveButtonText: {
    fontSize: 12,
    color: colors.emerald400,
  },
  editTextarea: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 10,
    color: colors.gray100,
    fontSize: 12,
    fontFamily: 'monospace',
    minHeight: 200,
    textAlignVertical: 'top',
  },
  emptyCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.gray500,
  },
  emptyHint: {
    fontSize: 12,
    color: colors.gray600,
    marginTop: 4,
  },
});
