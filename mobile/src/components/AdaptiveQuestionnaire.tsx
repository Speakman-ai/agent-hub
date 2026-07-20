import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  APP_TYPE_OPTIONS,
  AUTH_PROVIDER_OPTIONS,
  HOSTING_OPTIONS,
  IDK,
  INTEGRATION_OPTIONS,
  STEP_IDS,
  STEP_LABELS,
  advance,
  canContinue,
  currentVisibleStep,
  goBack,
  initialDraft,
  isDescriptionValid,
  recommendedStack,
  stackOptionsFor,
  toProvisioningPayload,
  visibleSteps,
} from '@shared/utils/adaptiveQuestionnaire';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

type Draft = Record<string, any>;

const KNOWN_APP_TYPES = new Set(APP_TYPE_OPTIONS.map((option) => option.value));
const KNOWN_STACKS = new Set(
  APP_TYPE_OPTIONS.flatMap((option) => stackOptionsFor(option.value).map((stack: any) => stack.value)),
);

/** Build a safe patch from model output; unsupported values remain idk. */
export function buildSuggestionPatch(
  suggestion: any,
  draft: Draft,
  needsName: boolean,
  needsAppType: boolean,
  needsStack: boolean,
): Draft {
  const patch: Draft = {};
  if (
    needsName &&
    typeof suggestion?.name === 'string' &&
    suggestion.name.trim() &&
    suggestion.name.trim() !== IDK
  ) {
    patch.name = suggestion.name.trim();
  }

  const suggestedAppType =
    needsAppType && KNOWN_APP_TYPES.has(suggestion?.appType) ? suggestion.appType : null;
  if (suggestedAppType) patch.appType = suggestedAppType;

  if (needsStack && typeof suggestion?.stack === 'string') {
    const effectiveAppType = suggestedAppType || draft.appType;
    const stackSet = KNOWN_APP_TYPES.has(effectiveAppType)
      ? new Set(stackOptionsFor(effectiveAppType).map((stack: any) => stack.value))
      : KNOWN_STACKS;
    if (stackSet.has(suggestion.stack)) patch.stack = suggestion.stack;
  }
  return patch;
}

type AdaptiveQuestionnaireProps = {
  onSubmit: (payload: any) => void;
  onClose: () => void;
  submitting?: boolean;
  initial?: Partial<Draft>;
};

export default function AdaptiveQuestionnaire({
  onSubmit,
  onClose,
  submitting = false,
  initial,
}: AdaptiveQuestionnaireProps) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...initialDraft(), ...(initial || {}) }));
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggestionAttempt, setSuggestionAttempt] = useState(0);
  const suggestionContextRef = useRef<{ needsName: boolean; needsAppType: boolean; needsStack: boolean } | null>(null);
  const submitInFlightRef = useRef(false);
  const stepId = STEP_IDS[draft.step];
  const visible = useMemo(() => visibleSteps(draft), [draft]);
  const currentIdx = currentVisibleStep(draft);
  const isLast = stepId === 'review';

  useEffect(() => {
    if (stepId !== 'review') {
      suggestionContextRef.current = null;
      return;
    }
    // Keep the original review inputs stable for this request cycle. A
    // partial response may update one field, but must not cause the effect to
    // request the same suggestion again just because `draft` changed.
    if (suggestionContextRef.current) return;
    const needsName = draft.name === IDK || !String(draft.name || '').trim();
    const needsAppType = draft.appType === IDK;
    const needsStack = draft.stack === IDK;
    if (!needsName && !needsAppType && !needsStack) return;
    suggestionContextRef.current = { needsName, needsAppType, needsStack };

    setSuggesting(true);
    setSuggestionError(null);
    let cancelled = false;
    api
      .suggestProjectSetup({
        description: draft.description,
        appType: needsAppType ? undefined : draft.appType,
        stack: needsStack ? undefined : draft.stack,
        model: draft.generationModel || undefined,
      })
      .then((suggestion: any) => {
        if (cancelled) return;
        const patch = buildSuggestionPatch(suggestion, draft, needsName, needsAppType, needsStack);
        if (Object.keys(patch).length === 0) {
          setSuggestionError(
            'AI suggestions returned no usable answers. You can retry or continue with idk defaults.',
          );
          return;
        }
        setDraft((current: Draft) => ({ ...current, ...patch }));
        if (
          (needsName && !patch.name) ||
          (needsAppType && !patch.appType) ||
          (needsStack && !patch.stack)
        ) {
          setSuggestionError(
            'Some answers could not be suggested. You can retry or continue with idk defaults.',
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSuggestionError(
            'AI suggestions could not be loaded. You can retry or continue with idk defaults.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSuggesting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft, stepId, suggestionAttempt]);

  useEffect(() => {
    if (!submitting) submitInFlightRef.current = false;
  }, [submitting]);

  const update = (patch: Draft) => setDraft((current: Draft) => ({ ...current, ...patch }));
  const pickIdk = (field: string) => update({ [field]: IDK });
  const handleNext = () => {
    if (canContinue(draft)) setDraft((current: Draft) => advance(current));
  };
  const handleBack = () => {
    if (stepId === 'description') onClose();
    else setDraft((current: Draft) => goBack(current));
  };
  const handleSubmit = () => {
    if (submitting || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      onSubmit(toProvisioningPayload(draft));
    } catch (err) {
      submitInFlightRef.current = false;
      throw err;
    }
  };
  const retrySuggestions = () => {
    suggestionContextRef.current = null;
    setSuggestionAttempt((attempt) => attempt + 1);
  };

  return (
    <View style={styles.container} testID="adaptive-questionnaire">
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack} testID="aq-back">
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New Project</Text>
        <Text style={styles.counter} testID="aq-step-counter">
          Step {currentIdx + 1} of {visible.length}
        </Text>
      </View>

      <ScrollView
        horizontal
        contentContainerStyle={styles.stepStrip}
        showsHorizontalScrollIndicator={false}
      >
        {visible.map((id: string, index: number) => (
          <View key={id} style={styles.stepItem} testID={`aq-step-${id}`}>
            <View
              style={[
                styles.stepPill,
                index < currentIdx && styles.stepPillDone,
                index === currentIdx && styles.stepPillActive,
              ]}
            >
              <Text style={styles.stepNumber}>{index < currentIdx ? '✓' : index + 1}</Text>
              <Text style={styles.stepLabel}>{STEP_LABELS[id]}</Text>
            </View>
          </View>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {stepId === 'description' && <DescriptionStep draft={draft} update={update} />}
        {stepId === 'appType' && (
          <AppTypeStep draft={draft} update={update} onIdk={() => pickIdk('appType')} />
        )}
        {stepId === 'stack' && (
          <StackStep draft={draft} update={update} onIdk={() => pickIdk('stack')} />
        )}
        {stepId === 'integrations' && (
          <IntegrationsStep draft={draft} update={update} onIdk={() => pickIdk('integrations')} />
        )}
        {stepId === 'auth' && (
          <AuthStep draft={draft} update={update} onIdk={() => pickIdk('authDetail')} />
        )}
        {stepId === 'hosting' && (
          <HostingStep draft={draft} update={update} onIdk={() => pickIdk('hosting')} />
        )}
        {stepId === 'identity' && <IdentityStep draft={draft} update={update} />}
        {stepId === 'review' && (
          <ReviewStep
            draft={draft}
            suggesting={suggesting}
            suggestionError={suggestionError}
            onRetrySuggestions={retrySuggestions}
          />
        )}
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          style={[
            styles.primaryButton,
            ((!isLast && !canContinue(draft)) || (isLast && submitting)) && styles.disabledButton,
          ]}
          onPress={isLast ? handleSubmit : handleNext}
          disabled={(!isLast && !canContinue(draft)) || (isLast && submitting)}
          testID={isLast ? 'aq-submit' : 'aq-continue'}
        >
          <Text style={styles.primaryButtonText}>{isLast ? 'Create Project' : 'Continue'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function StepTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

function Choice({
  selected,
  label,
  description,
  onPress,
  testID,
}: {
  selected: boolean;
  label: string;
  description?: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <View style={styles.choiceContent}>
        <Text style={styles.choiceLabel}>{label}</Text>
        {description ? <Text style={styles.choiceDescription}>{description}</Text> : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </TouchableOpacity>
  );
}

function IdkButton({ onPress, selected }: { onPress: () => void; selected: boolean }) {
  return (
    <Choice
      label="idk — decide later"
      description="The provisioning agent will choose a sensible default."
      selected={selected}
      onPress={onPress}
      testID="aq-idk"
    />
  );
}

function DescriptionStep({ draft, update }: { draft: Draft; update: (patch: Draft) => void }) {
  const invalid = draft.description.length > 0 && !isDescriptionValid(draft.description);
  return (
    <View>
      <StepTitle
        title="What are you building?"
        subtitle="One or two sentences is plenty. This is the only required question."
      />
      <TextInput
        value={draft.description}
        onChangeText={(description: string) => update({ description })}
        placeholder="e.g. an adaptive survey tool"
        placeholderTextColor={colors.gray600}
        multiline
        numberOfLines={5}
        autoFocus
        style={[styles.textInput, styles.multilineInput, invalid && styles.invalidInput]}
        testID="aq-description-input"
        accessibilityLabel="What are you building?"
      />
      {invalid ? (
        <Text style={styles.errorText}>
          Description can’t be empty — tell us what you’re building.
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>AI model for generated answers (optional)</Text>
      <TextInput
        value={draft.generationModel || ''}
        onChangeText={(generationModel: string) =>
          update({ generationModel: generationModel || null })
        }
        placeholder="Use the default model"
        placeholderTextColor={colors.gray600}
        autoCapitalize="none"
        style={styles.textInput}
        testID="aq-generation-model"
      />
      <Text style={styles.fieldHint}>Used when you answer idk at the review step.</Text>
    </View>
  );
}

function AppTypeStep({
  draft,
  update,
  onIdk,
}: {
  draft: Draft;
  update: (patch: Draft) => void;
  onIdk: () => void;
}) {
  return (
    <View>
      <StepTitle title="What kind of app?" subtitle="Pick one to get a stack recommendation." />
      {APP_TYPE_OPTIONS.map((option) => (
        <Choice
          key={option.value}
          label={option.label}
          description={option.description}
          selected={draft.appType === option.value}
          onPress={() => update({ appType: option.value, stack: recommendedStack(option.value) })}
          testID={`aq-apptype-${option.value}`}
        />
      ))}
      <IdkButton onPress={onIdk} selected={draft.appType === IDK} />
    </View>
  );
}

function StackStep({
  draft,
  update,
  onIdk,
}: {
  draft: Draft;
  update: (patch: Draft) => void;
  onIdk: () => void;
}) {
  const options = stackOptionsFor(draft.appType);
  return (
    <View>
      <StepTitle
        title="Which stack?"
        subtitle={
          options.length
            ? 'The recommended stack is pre-selected.'
            : 'Pick idk for an opinionated default.'
        }
      />
      {options.map((option: any) => (
        <Choice
          key={option.value}
          label={`${option.label}${option.recommended ? ' · Recommended' : ''}`}
          selected={draft.stack === option.value}
          onPress={() => update({ stack: option.value })}
          testID={`aq-stack-${option.value}`}
        />
      ))}
      <IdkButton onPress={onIdk} selected={draft.stack === IDK} />
    </View>
  );
}

function IntegrationsStep({
  draft,
  update,
  onIdk,
}: {
  draft: Draft;
  update: (patch: Draft) => void;
  onIdk: () => void;
}) {
  const current = Array.isArray(draft.integrations) ? draft.integrations : [];
  const toggle = (value: string) => {
    const next = current.includes(value)
      ? current.filter((item: string) => item !== value)
      : [...current, value];
    update({ integrations: next, ...(!next.includes('auth') ? { authDetail: null } : {}) });
  };
  return (
    <View>
      <StepTitle title="Which integrations?" subtitle="Select everything you expect to use." />
      {INTEGRATION_OPTIONS.map((option) => (
        <Choice
          key={option.value}
          label={option.label}
          description={option.description}
          selected={current.includes(option.value)}
          onPress={() => toggle(option.value)}
          testID={`aq-integration-${option.value}`}
        />
      ))}
      <IdkButton onPress={onIdk} selected={draft.integrations === IDK} />
    </View>
  );
}

function AuthStep({
  draft,
  update,
  onIdk,
}: {
  draft: Draft;
  update: (patch: Draft) => void;
  onIdk: () => void;
}) {
  const detail = draft.authDetail && draft.authDetail !== IDK ? draft.authDetail : null;
  const provider = detail?.provider ?? null;
  return (
    <View>
      <StepTitle
        title="How should users sign in?"
        subtitle="Choose a provider or defer the details."
      />
      <Text style={styles.fieldLabel}>Provider</Text>
      {AUTH_PROVIDER_OPTIONS.map((option) => (
        <Choice
          key={option.value}
          label={option.label}
          description={option.description}
          selected={provider === option.value}
          onPress={() =>
            update({ authDetail: { provider: option.value, userModel: detail?.userModel ?? IDK } })
          }
          testID={`aq-auth-provider-${option.value}`}
        />
      ))}
      <Choice
        label="idk — pick for me"
        selected={provider === IDK}
        onPress={() =>
          update({ authDetail: { provider: IDK, userModel: detail?.userModel ?? IDK } })
        }
        testID="aq-auth-provider-idk"
      />
      <Text style={styles.fieldLabel}>User model extras (optional)</Text>
      <TextInput
        value={detail && detail.userModel !== IDK ? detail.userModel : ''}
        onChangeText={(userModel: string) =>
          update({ authDetail: { provider: detail?.provider ?? IDK, userModel } })
        }
        placeholder="e.g. teams, orgs, roles"
        placeholderTextColor={colors.gray600}
        style={styles.textInput}
        testID="aq-auth-usermodel"
      />
      <IdkButton onPress={onIdk} selected={draft.authDetail === IDK} />
    </View>
  );
}

function HostingStep({
  draft,
  update,
  onIdk,
}: {
  draft: Draft;
  update: (patch: Draft) => void;
  onIdk: () => void;
}) {
  return (
    <View>
      <StepTitle
        title="Where should your code live?"
        subtitle="Agent Hub hosting is the recommended default."
      />
      {HOSTING_OPTIONS.map((option) => (
        <Choice
          key={option.value}
          label={option.label}
          description={option.blurb}
          selected={draft.hosting === option.value}
          onPress={() => update({ hosting: option.value })}
          testID={`aq-hosting-${option.value}`}
        />
      ))}
      <IdkButton onPress={onIdk} selected={draft.hosting === IDK} />
    </View>
  );
}

function IdentityStep({ draft, update }: { draft: Draft; update: (patch: Draft) => void }) {
  const nameIsIdk = draft.name === IDK;
  return (
    <View>
      <StepTitle title="Name & visibility" subtitle="You can defer either field with idk." />
      <Text style={styles.fieldLabel}>Project name</Text>
      <View style={styles.inlineField}>
        <TextInput
          value={nameIsIdk ? '' : draft.name}
          onChangeText={(name: string) => update({ name })}
          editable={!nameIsIdk}
          placeholder="my-project"
          placeholderTextColor={colors.gray600}
          style={[styles.textInput, styles.flexInput]}
          testID="aq-name-input"
        />
        <TouchableOpacity
          onPress={() => update({ name: nameIsIdk ? '' : IDK })}
          style={[styles.idkFieldButton, nameIsIdk && styles.idkFieldButtonSelected]}
          testID="aq-name-idk"
        >
          <Text style={styles.idkFieldText}>idk</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.fieldLabel}>Visibility</Text>
      <View style={styles.visibilityRow}>
        {[
          { value: 'private', label: 'Private' },
          { value: 'public', label: 'Public' },
          { value: IDK, label: 'idk' },
        ].map((option) => (
          <TouchableOpacity
            key={option.value}
            onPress={() => update({ visibility: option.value })}
            style={[
              styles.visibilityButton,
              draft.visibility === option.value && styles.choiceSelected,
            ]}
            testID={`aq-visibility-${option.value}`}
          >
            <Text style={styles.visibilityText}>{option.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function ReviewStep({
  draft,
  suggesting,
  suggestionError,
  onRetrySuggestions,
}: {
  draft: Draft;
  suggesting: boolean;
  suggestionError: string | null;
  onRetrySuggestions: () => void;
}) {
  const payload = toProvisioningPayload(draft);
  const rows = [
    ['What', payload.description],
    ['App type', formatValue(payload.appType)],
    ['Stack', formatValue(payload.stack)],
    ['Integrations', formatValue(payload.integrations)],
    ['Auth', payload.authDetail == null ? '—' : formatAuth(payload.authDetail)],
    ['Hosting', payload.hostOnAgentHub ? 'Agent Hub' : 'GitHub only'],
    ['Name', formatValue(payload.name)],
    ['Visibility', formatValue(payload.visibility)],
  ];
  return (
    <View>
      <StepTitle
        title="Review & confirm"
        subtitle="Anything marked idk gets a sensible provisioning default."
      />
      {suggesting ? (
        <Text style={styles.suggestionText}>Filling in your idk answers with AI…</Text>
      ) : null}
      {suggestionError ? (
        <View style={styles.suggestionErrorBox}>
          <Text style={styles.suggestionErrorText}>{suggestionError}</Text>
          <TouchableOpacity
            onPress={onRetrySuggestions}
            style={styles.retryButton}
            testID="aq-suggest-retry"
          >
            <Text style={styles.retryButtonText}>Retry AI suggestions</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.reviewBox}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.reviewRow}>
            <Text style={styles.reviewLabel}>{label}</Text>
            <Text style={styles.reviewValue}>{value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function formatValue(value: any): string {
  if (value === IDK) return 'idk — agent decides';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return value == null || value === '' ? '—' : String(value);
}

function formatAuth(value: any): string {
  if (value === IDK) return 'idk — agent decides';
  if (!value || typeof value !== 'object') return formatValue(value);
  return `${formatValue(value.provider)}${value.userModel && value.userModel !== IDK ? ` (${value.userModel})` : ''}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  backButton: { paddingVertical: 6, paddingRight: 4 },
  backButtonText: { color: colors.gray300, fontSize: 14 },
  headerTitle: {
    flex: 1,
    color: colors.white,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  counter: { color: colors.gray400, fontSize: 11, minWidth: 70, textAlign: 'right' },
  stepStrip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  stepItem: { flexDirection: 'row', alignItems: 'center' },
  stepPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  stepPillDone: { borderColor: colors.emerald600, backgroundColor: colors.emerald900_40 },
  stepPillActive: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  stepNumber: { color: colors.gray300, fontSize: 10, fontWeight: '600' },
  stepLabel: { color: colors.gray300, fontSize: 10, fontWeight: '500' },
  body: { padding: 16, paddingBottom: 32 },
  titleBlock: { marginBottom: 18 },
  title: { color: colors.white, fontSize: 20, fontWeight: '700', marginBottom: 5 },
  subtitle: { color: colors.gray400, fontSize: 13, lineHeight: 19 },
  choice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
    padding: 13,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  choiceSelected: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  choiceContent: { flex: 1 },
  choiceLabel: { color: colors.white, fontSize: 14, fontWeight: '600' },
  choiceDescription: { color: colors.gray400, fontSize: 12, lineHeight: 17, marginTop: 3 },
  check: { color: colors.emerald400, fontSize: 17, marginLeft: 8 },
  textInput: {
    color: colors.gray100,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  multilineInput: { minHeight: 112, textAlignVertical: 'top' },
  invalidInput: { borderColor: colors.red600 },
  errorText: { color: colors.red400, fontSize: 12, marginTop: 6 },
  fieldLabel: {
    color: colors.gray400,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 6,
  },
  fieldHint: { color: colors.gray600, fontSize: 11, marginTop: 5 },
  inlineField: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexInput: { flex: 1 },
  idkFieldButton: {
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  idkFieldButtonSelected: { borderColor: colors.indigo500, backgroundColor: colors.indigo900_40 },
  idkFieldText: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  visibilityRow: { flexDirection: 'row', gap: 8 },
  visibilityButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
  },
  visibilityText: { color: colors.gray200, fontSize: 13, fontWeight: '600' },
  suggestionText: { color: colors.indigo300, fontSize: 12, marginBottom: 12 },
  suggestionErrorBox: {
    padding: 12,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amber400,
    backgroundColor: colors.amber900_40,
  },
  suggestionErrorText: { color: colors.gray200, fontSize: 12, lineHeight: 17 },
  retryButton: {
    alignSelf: 'flex-start',
    marginTop: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    backgroundColor: colors.gray700,
  },
  retryButtonText: { color: colors.white, fontSize: 12, fontWeight: '600' },
  reviewBox: { borderWidth: 1, borderColor: colors.gray800, borderRadius: 9, overflow: 'hidden' },
  reviewRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  reviewLabel: { width: 92, color: colors.gray500, fontSize: 12 },
  reviewValue: { flex: 1, color: colors.gray200, fontSize: 13 },
  footer: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  primaryButton: {
    alignItems: 'center',
    paddingVertical: 13,
    borderRadius: 9,
    backgroundColor: colors.emerald600,
  },
  disabledButton: { opacity: 0.45 },
  primaryButtonText: { color: colors.white, fontSize: 15, fontWeight: '600' },
});
