import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';

const OTHER_SENTINEL = '__other__';

/**
 * AskUserQuestion — mobile port of client/src/components/AskUserQuestion.jsx.
 *
 * Renders a multi-question picker inline in the chat transcript when the
 * assistant emits an `agenthub:ask` fenced block (parsed server-side into an
 * `ask_user_question` stream event).
 *
 * Differences vs. web:
 *   - No side-by-side preview pane. When an option has a preview it renders
 *     stacked beneath the selected option as plain monospace text (no
 *     highlight.js — keeps the bundle light and avoids WebView on Android).
 *   - Hover→focus is replaced with explicit tap-to-select; the preview
 *     updates when the user taps an option.
 *
 * Props:
 *   askId      — stable id from the stream event
 *   questions  — array of { question, header, multiSelect, options[] }
 *   onSubmit   — (messageText: string) => void; invoked with the prose +
 *                `agenthub:ask:answer` fenced-block payload.
 *   submitted  — true once the user has submitted; disables all inputs.
 */
function AskUserQuestion({ askId, questions, onSubmit, submitted }) {
  // Per-question state. For single-select: selected is an option label or
  // OTHER_SENTINEL. For multi-select: selected is a Set<string>. `otherText`
  // and `notes` are preserved independently so toggling away and back keeps
  // what the user typed.
  const [state, setState] = useState(() =>
    questions.map((q) => ({
      selected: q.multiSelect ? new Set() : null,
      otherText: '',
      notes: '',
      focusedIdx: 0,
    })),
  );
  const [error, setError] = useState(null);

  const anyPreview = useMemo(
    () => questions.map((q) => q.options.some((o) => !!o.preview)),
    [questions],
  );

  function updateQuestion(i, patch) {
    setState((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function toggleMulti(i, label) {
    setState((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s;
        const next = new Set(s.selected);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return { ...s, selected: next };
      }),
    );
  }

  function validate() {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const s = state[i];
      if (q.multiSelect) {
        const hasSelections = s.selected && s.selected.size > 0;
        const hasOther = s.selected && s.selected.has(OTHER_SENTINEL);
        if (!hasSelections) {
          return { questionIdx: i, reason: 'Please select at least one option.' };
        }
        if (hasOther && !s.otherText.trim()) {
          return { questionIdx: i, reason: '"Other" requires text.' };
        }
      } else {
        if (!s.selected) {
          return { questionIdx: i, reason: 'Please select an option.' };
        }
        if (s.selected === OTHER_SENTINEL && !s.otherText.trim()) {
          return { questionIdx: i, reason: '"Other" requires text.' };
        }
      }
    }
    return null;
  }

  function buildPayload() {
    const answers = {};
    const annotations = {};

    questions.forEach((q, i) => {
      const s = state[i];
      let value;
      if (q.multiSelect) {
        // Emit selected labels as an array so Claude can distinguish multiple
        // selections from a single "Other" free-text that happens to contain a
        // newline (same shape as the web picker).
        const labels = [];
        for (const sel of s.selected) {
          labels.push(sel === OTHER_SENTINEL ? s.otherText.trim() : sel);
        }
        value = labels;
      } else {
        value = s.selected === OTHER_SENTINEL ? s.otherText.trim() : s.selected;
      }
      answers[q.question] = value;

      const anno = {};
      if (s.notes.trim()) anno.notes = s.notes.trim();
      if (!q.multiSelect && anyPreview[i] && s.selected && s.selected !== OTHER_SENTINEL) {
        const opt = q.options.find((o) => o.label === s.selected);
        if (opt?.preview) anno.preview = opt.preview;
      }
      if (Object.keys(anno).length > 0) annotations[q.question] = anno;
    });

    return { answers, annotations };
  }

  function handleSubmit() {
    if (submitted) return;
    const bad = validate();
    if (bad) {
      setError(bad);
      return;
    }
    setError(null);
    const { answers, annotations } = buildPayload();
    const bodyJson = JSON.stringify({ askId, answers, annotations }, null, 2);
    const message = `Here are my answers:\n\n\`\`\`agenthub:ask:answer\n${bodyJson}\n\`\`\``;
    onSubmit?.(message);
  }

  return (
    <View style={styles.container} testID={`ask-${askId}`}>
      <View style={styles.headerBar}>
        <AppIcon name="help-circle-outline" size={14} color={colors.indigo400} />
        <Text style={styles.headerText}>
          {submitted
            ? 'Answers submitted'
            : `Pick your ${questions.length > 1 ? 'answers' : 'answer'}`}
        </Text>
      </View>

      <View style={styles.body}>
        {questions.map((q, i) => (
          <QuestionCard
            key={`${askId}-${i}`}
            question={q}
            state={state[i]}
            hasPreview={anyPreview[i]}
            disabled={submitted}
            errored={error?.questionIdx === i}
            onSelectSingle={(label) => updateQuestion(i, { selected: label })}
            onToggleMulti={(label) => toggleMulti(i, label)}
            onOtherText={(txt) => updateQuestion(i, { otherText: txt })}
            onNotes={(txt) => updateQuestion(i, { notes: txt })}
            onFocusOption={(idx) => updateQuestion(i, { focusedIdx: idx })}
          />
        ))}

        {error && (
          <View style={styles.errorBanner}>
            <AppIcon name="alert-circle-outline" size={14} color={colors.rose400} />
            <Text style={styles.errorText}>
              Question {error.questionIdx + 1}: {error.reason}
            </Text>
          </View>
        )}

        <View style={styles.submitRow}>
          <TouchableOpacity
            onPress={handleSubmit}
            disabled={submitted}
            style={[styles.submitBtn, submitted && styles.submitBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel={submitted ? 'Answers submitted' : 'Submit answers'}
          >
            <Text style={[styles.submitBtnText, submitted && styles.submitBtnTextDisabled]}>
              {submitted ? 'Submitted' : 'Submit answers'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function QuestionCard({
  question,
  state,
  hasPreview,
  disabled,
  errored,
  onSelectSingle,
  onToggleMulti,
  onOtherText,
  onNotes,
  onFocusOption,
}) {
  const { selected, otherText, notes, focusedIdx } = state;
  const isMulti = question.multiSelect;
  const showPreview = hasPreview && !isMulti;

  const focusedOption =
    showPreview && focusedIdx < question.options.length ? question.options[focusedIdx] : null;

  return (
    <View style={[styles.questionCard, errored && styles.questionCardErrored]}>
      <View style={styles.questionHeader}>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>
            {(question.header || '').slice(0, 12)}
          </Text>
        </View>
        <Text style={styles.questionText}>{question.question}</Text>
      </View>

      <View style={styles.optionList}>
        {question.options.map((opt, idx) => {
          const isChecked = isMulti ? selected.has(opt.label) : selected === opt.label;
          return (
            <OptionRow
              key={opt.label}
              option={opt}
              multi={isMulti}
              checked={isChecked}
              focused={showPreview && focusedIdx === idx}
              disabled={disabled}
              onPress={() => {
                if (isMulti) onToggleMulti(opt.label);
                else onSelectSingle(opt.label);
                if (showPreview) onFocusOption(idx);
              }}
            />
          );
        })}
        <OtherRow
          multi={isMulti}
          checked={isMulti ? selected.has(OTHER_SENTINEL) : selected === OTHER_SENTINEL}
          disabled={disabled}
          otherText={otherText}
          onSelect={() => {
            if (isMulti) onToggleMulti(OTHER_SENTINEL);
            else onSelectSingle(OTHER_SENTINEL);
          }}
          onTextChange={onOtherText}
        />
      </View>

      {showPreview && <PreviewPane preview={focusedOption?.preview} />}

      <View style={styles.notesSection}>
        <Text style={styles.notesLabel}>NOTES (OPTIONAL)</Text>
        <TextInput
          value={notes}
          onChangeText={onNotes}
          editable={!disabled}
          multiline
          placeholder="Add context or reasoning…"
          placeholderTextColor={colors.gray600}
          style={[styles.notesInput, disabled && styles.disabledFaded]}
        />
      </View>
    </View>
  );
}

function OptionRow({ option, multi, checked, focused, disabled, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={option.label}
      style={[
        styles.optionRow,
        focused && styles.optionRowFocused,
        disabled && styles.disabledFaded,
      ]}
    >
      <View style={[styles.indicator, multi ? styles.indicatorSquare : styles.indicatorRound]}>
        {checked && (
          multi ? (
            <AppIcon name="checkmark" size={12} color={colors.white} />
          ) : (
            <View style={styles.radioDot} />
          )
        )}
      </View>
      <View style={styles.optionTextContainer}>
        <Text style={styles.optionLabel}>{option.label}</Text>
        {option.description ? (
          <Text style={styles.optionDescription}>{option.description}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function OtherRow({ multi, checked, disabled, otherText, onSelect, onTextChange }) {
  return (
    <View style={[styles.otherRow, checked && styles.otherRowActive, disabled && styles.disabledFaded]}>
      <TouchableOpacity
        onPress={onSelect}
        disabled={disabled}
        activeOpacity={0.7}
        accessibilityRole={multi ? 'checkbox' : 'radio'}
        accessibilityState={{ checked, disabled: !!disabled }}
        accessibilityLabel="Other"
        style={[styles.indicator, multi ? styles.indicatorSquare : styles.indicatorRound]}
      >
        {checked && (
          multi ? (
            <AppIcon name="checkmark" size={12} color={colors.white} />
          ) : (
            <View style={styles.radioDot} />
          )
        )}
      </TouchableOpacity>
      <View style={styles.otherContent}>
        <Text style={styles.otherLabel}>Other…</Text>
        <TextInput
          value={otherText}
          onChangeText={(txt) => {
            onTextChange(txt);
            if (!checked && txt.length > 0) onSelect();
          }}
          editable={!disabled}
          placeholder="Type your own answer"
          placeholderTextColor={colors.gray600}
          style={styles.otherInput}
        />
      </View>
    </View>
  );
}

function PreviewPane({ preview }) {
  if (!preview) {
    return (
      <View style={styles.previewEmpty}>
        <Text style={styles.previewEmptyText}>Tap an option to preview</Text>
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.previewScroll}
      contentContainerStyle={styles.previewContent}
      nestedScrollEnabled
    >
      <Text style={styles.previewCode}>{preview}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderColor: 'rgba(67, 56, 202, 0.5)',
    backgroundColor: 'rgba(49, 46, 129, 0.2)',
    borderRadius: 10,
    overflow: 'hidden',
    marginVertical: 6,
    marginHorizontal: 12,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(49, 46, 129, 0.3)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(67, 56, 202, 0.4)',
  },
  headerText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.indigo400,
  },
  body: {
    padding: 10,
    gap: 12,
  },
  questionCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: 'rgba(3, 7, 18, 0.3)',
  },
  questionCardErrored: {
    borderColor: 'rgba(190, 18, 60, 0.6)',
  },
  questionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerBadge: {
    backgroundColor: 'rgba(67, 56, 202, 0.4)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  headerBadgeText: {
    color: colors.indigo400,
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  questionText: {
    flex: 1,
    color: colors.gray100,
    fontSize: 13,
    lineHeight: 18,
  },
  optionList: {
    padding: 10,
    gap: 4,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionRowFocused: {
    backgroundColor: 'rgba(49, 46, 129, 0.3)',
    borderColor: 'rgba(79, 70, 229, 0.4)',
  },
  indicator: {
    width: 16,
    height: 16,
    marginTop: 2,
    borderWidth: 1.5,
    borderColor: colors.indigo400,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicatorRound: { borderRadius: 8 },
  indicatorSquare: { borderRadius: 3 },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.indigo500,
  },
  optionTextContainer: {
    flex: 1,
  },
  optionLabel: {
    color: colors.gray100,
    fontSize: 13,
  },
  optionDescription: {
    color: colors.gray400,
    fontSize: 11,
    marginTop: 2,
  },
  otherRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  otherRowActive: {
    backgroundColor: 'rgba(49, 46, 129, 0.2)',
    borderColor: 'rgba(79, 70, 229, 0.4)',
  },
  otherContent: {
    flex: 1,
  },
  otherLabel: {
    color: colors.gray300,
    fontSize: 13,
  },
  otherInput: {
    marginTop: 4,
    backgroundColor: 'rgba(17, 24, 39, 0.6)',
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.gray200,
    fontSize: 12,
  },
  previewEmpty: {
    marginHorizontal: 10,
    marginBottom: 10,
    paddingVertical: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.gray800,
    borderRadius: 6,
    backgroundColor: 'rgba(3, 7, 18, 0.4)',
    alignItems: 'center',
  },
  previewEmptyText: {
    color: colors.gray600,
    fontSize: 11,
  },
  previewScroll: {
    marginHorizontal: 10,
    marginBottom: 10,
    maxHeight: 240,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 6,
    backgroundColor: 'rgba(3, 7, 18, 0.7)',
  },
  previewContent: {
    padding: 8,
  },
  previewCode: {
    color: colors.gray300,
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  notesSection: {
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  notesLabel: {
    color: colors.gray500,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  notesInput: {
    backgroundColor: 'rgba(17, 24, 39, 0.6)',
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.gray200,
    fontSize: 12,
    minHeight: 32,
    maxHeight: 100,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(136, 19, 55, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(190, 18, 60, 0.5)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  errorText: {
    color: colors.rose400,
    fontSize: 11,
    flex: 1,
  },
  submitRow: {
    alignItems: 'flex-end',
    paddingTop: 2,
  },
  submitBtn: {
    backgroundColor: colors.indigo600,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  submitBtnDisabled: {
    backgroundColor: 'rgba(55, 65, 81, 0.5)',
  },
  submitBtnText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  submitBtnTextDisabled: {
    color: colors.gray500,
  },
  disabledFaded: {
    opacity: 0.6,
  },
});

export default AskUserQuestion;
