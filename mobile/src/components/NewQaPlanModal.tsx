import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  draftToCreateInput,
  filterCardOptions,
  toCardOptions,
  toEpicOptions,
  validateQaPlanDraft,
  type QaCardOption,
  type QaEpicOption,
  type QaPlanDraft,
} from '../utils/qa';

/** Picker rows shown at once; the filter narrows the rest. */
const CARD_PICKER_LIMIT = 30;

export interface NewQaPlanModalProps {
  projectId: string;
  onClose: () => void;
  /** Called with the new plan id once it exists. */
  onCreated: (planId: string) => void | Promise<void>;
}

function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      testID={testID}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function NewQaPlanModal({ projectId, onClose, onCreated }: NewQaPlanModalProps) {
  const [draft, setDraft] = useState<QaPlanDraft>({
    title: '',
    targetUrl: '',
    goal: '',
    epicId: '',
    cardId: '',
  });
  const [touched, setTouched] = useState(false);
  const [epics, setEpics] = useState<QaEpicOption[]>([]);
  const [cards, setCards] = useState<QaCardOption[]>([]);
  const [cardQuery, setCardQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getEpics(projectId).catch(() => []),
      api.getBoardCards(projectId).catch(() => []),
    ]).then(([e, c]) => {
      if (cancelled) return;
      setEpics(toEpicOptions(e));
      setCards(toCardOptions(c));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const errors = validateQaPlanDraft(draft);
  const cardOptions = useMemo(
    () => filterCardOptions(cards, draft.epicId, cardQuery, CARD_PICKER_LIMIT),
    [cards, draft.epicId, cardQuery],
  );
  const selectedCard = cards.find((c) => c.id === draft.cardId);

  const set = <K extends keyof QaPlanDraft>(key: K, value: QaPlanDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const selectEpic = (epicId: string) =>
    setDraft((d) => {
      const card = cards.find((c) => c.id === d.cardId);
      const keepCard = !epicId || card?.epicId === epicId;
      return { ...d, epicId, cardId: keepCard ? d.cardId : '' };
    });

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length > 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { plan } = await api.createQaPlan(projectId, draftToCreateInput(draft));
      await onCreated(plan.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to create the QA plan');
      setSubmitting(false);
    }
  };

  const cardLabel = (c: QaCardOption) => `${c.shortId != null ? `#${c.shortId} ` : ''}${c.title}`;

  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => !submitting && onClose()}
      presentationStyle="pageSheet"
    >
      <SafeAreaView style={styles.container} testID="qa-new-plan-modal">
        <View style={styles.header}>
          <Text style={styles.title}>New QA plan</Text>
          <TouchableOpacity onPress={onClose} disabled={submitting} accessibilityLabel="Close">
            <Text style={styles.close}>{'✕'}</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.hint}>
            Creates a draft plan and opens a chat with the QA agent to draft its test cases.
          </Text>

          <Text style={styles.label}>Title</Text>
          <TextInput
            testID="qa-new-title"
            style={styles.input}
            value={draft.title}
            editable={!submitting}
            onChangeText={(v) => set('title', v)}
            placeholderTextColor={colors.gray600}
          />
          {touched && errors.title ? <Text style={styles.error}>{errors.title}</Text> : null}

          <Text style={styles.label}>Target URL</Text>
          <TextInput
            testID="qa-new-target"
            style={styles.input}
            value={draft.targetUrl}
            editable={!submitting}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://staging.example.com"
            placeholderTextColor={colors.gray600}
            onChangeText={(v) => set('targetUrl', v)}
            onBlur={() => draft.targetUrl && setTouched(true)}
          />
          {touched && errors.targetUrl ? (
            <Text style={styles.error} testID="qa-new-target-error">
              {errors.targetUrl}
            </Text>
          ) : null}

          <Text style={styles.label}>Goal</Text>
          <TextInput
            testID="qa-new-goal"
            style={[styles.input, styles.multiline]}
            value={draft.goal}
            editable={!submitting}
            multiline
            placeholder="What should this plan prove works?"
            placeholderTextColor={colors.gray600}
            onChangeText={(v) => set('goal', v)}
          />

          <Text style={styles.label}>Epic (optional)</Text>
          <View style={styles.chips}>
            <Chip label="None" selected={!draft.epicId} onPress={() => selectEpic('')} />
            {epics.map((e) => (
              <Chip
                key={e.id}
                label={e.name}
                selected={draft.epicId === e.id}
                onPress={() => selectEpic(e.id)}
              />
            ))}
          </View>

          <Text style={styles.label}>Card (optional)</Text>
          <TextInput
            testID="qa-new-card-filter"
            style={styles.input}
            value={cardQuery}
            editable={!submitting}
            placeholder="Filter cards by title or #number"
            placeholderTextColor={colors.gray600}
            onChangeText={setCardQuery}
          />
          <View style={styles.cardList}>
            <Chip label="None" selected={!draft.cardId} onPress={() => set('cardId', '')} />
            {selectedCard && !cardOptions.includes(selectedCard) ? (
              <Chip label={cardLabel(selectedCard)} selected onPress={() => set('cardId', '')} />
            ) : null}
            {cardOptions.map((c) => (
              <Chip
                key={c.id}
                label={cardLabel(c)}
                selected={draft.cardId === c.id}
                onPress={() => set('cardId', draft.cardId === c.id ? '' : c.id)}
              />
            ))}
          </View>

          {error ? <Text style={styles.errorBox}>{error}</Text> : null}
        </ScrollView>
        <View style={styles.footer}>
          <TouchableOpacity onPress={onClose} disabled={submitting} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="qa-new-submit"
            onPress={() => void submit()}
            disabled={submitting}
            style={[styles.submit, submitting && styles.disabled]}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.submitText}>Create and open chat</Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray900 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  title: { fontSize: 17, fontWeight: '600', color: colors.white },
  close: { fontSize: 18, color: colors.gray400 },
  body: { padding: 16, gap: 6 },
  hint: { fontSize: 12, color: colors.gray500, marginBottom: 6 },
  label: { fontSize: 12, color: colors.gray400, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.gray100,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  error: { fontSize: 12, color: colors.red400 },
  errorBox: {
    marginTop: 10,
    fontSize: 13,
    color: colors.red400,
    backgroundColor: colors.red900_50,
    borderRadius: 6,
    padding: 10,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cardList: { gap: 6, marginTop: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  chipSelected: { borderColor: colors.blue500, backgroundColor: colors.blue900_40 },
  chipText: { fontSize: 12, color: colors.gray300 },
  chipTextSelected: { color: colors.blue300 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  cancel: { paddingHorizontal: 14, paddingVertical: 9 },
  cancelText: { fontSize: 14, color: colors.gray400 },
  submit: {
    backgroundColor: colors.blue600,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    minWidth: 150,
    alignItems: 'center',
  },
  submitText: { fontSize: 14, color: colors.white },
  disabled: { opacity: 0.6 },
});
