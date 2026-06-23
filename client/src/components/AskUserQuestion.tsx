import { useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import 'highlight.js/styles/github-dark.css';
import { HelpCircle, AlertCircle } from 'lucide-react';

// Register a modest set of languages — keeps bundle light while covering the
// common cases Claude is likely to put in a preview (code snippets, config).
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);

const OTHER_SENTINEL = '__other__';

/**
 * AskUserQuestion
 * ---------------
 * Renders a multi-question picker in-line in the chat transcript when Claude
 * emits an `agenthub:ask` fenced block (see server/stream-parser.ts).
 *
 * The user's submission is sent back as a normal chat message containing a
 * matching `agenthub:ask:answer` fenced block. The outer caller (SessionTail
 * → App) owns the WebSocket send; this component just calls `onSubmit(text)`.
 *
 * Props:
 *   askId      — stable id from the stream event (for React keys / dedup)
 *   questions  — array of { question, header, multiSelect, options[] }
 *   onSubmit   — (messageText: string) => void; called with the formatted
 *                chat message (prose prefix + fenced answer block)
 *   submitted  — true once the user has submitted; disables all inputs
 */
function AskUserQuestion({ askId, questions, onSubmit, submitted }: any) {
  // Per-question state. For single-select: selected is an option label or
  // OTHER_SENTINEL. For multi-select: selected is a Set<string>. We also
  // track the "Other" free-text box separately so toggling away and back
  // preserves what the user typed, and a per-question notes textarea.
  const [state, setState] = useState(() =>
    questions.map((q: any) => ({
      selected: q.multiSelect ? new Set() : null,
      otherText: '',
      notes: '',
      // For single-select with previews, track which option is focused for
      // the side-by-side preview panel. Defaults to the first option.
      focusedIdx: 0,
    })),
  );
  const [error, setError] = useState<any>(null);

  const anyPreview = useMemo(
    () => questions.map((q: any) => q.options.some((o: any) => !!o.preview)),
    [questions],
  );

  function updateQuestion(i: any, patch: any) {
    setState((prev: any) => prev.map((s: any, idx: any) => (idx === i ? { ...s, ...patch } : s)));
  }

  function toggleMulti(i: any, label: any) {
    setState((prev: any) =>
      prev.map((s: any, idx: any) => {
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
        // Empty selection + no "Other" → blocked.
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
    const answers: Record<string, any> = {};
    const annotations: Record<string, any> = {};

    questions.forEach((q: any, i: any) => {
      const s = state[i];
      let value: any;
      if (q.multiSelect) {
        // Emit selected labels as an array so Claude can distinguish multiple
        // selections from a single "Other" free-text that happens to contain a
        // newline. The system-prompt teaching in server/chat.ts documents this
        // shape as `value is an array of strings` for multi-select questions.
        const labels: any[] = [];
        for (const sel of s.selected) {
          labels.push(sel === OTHER_SENTINEL ? s.otherText.trim() : sel);
        }
        value = labels;
      } else {
        value = s.selected === OTHER_SENTINEL ? s.otherText.trim() : s.selected;
      }
      answers[q.question] = value;

      const anno: Record<string, any> = {};
      if (s.notes.trim()) anno.notes = s.notes.trim();
      // Preview annotation captures which option's preview they chose, when
      // previews were involved (single-select only).
      if (!q.multiSelect && anyPreview[i] && s.selected && s.selected !== OTHER_SENTINEL) {
        const opt = q.options.find((o: any) => o.label === s.selected);
        if (opt?.preview) anno.preview = opt.preview;
      }
      if (Object.keys(anno).length > 0) annotations[q.question] = anno;
    });

    return { answers, annotations };
  }

  function handleSubmit() {
    const bad = validate();
    if (bad) {
      setError(bad);
      return;
    }
    setError(null);
    const { answers, annotations } = buildPayload();
    // askId is included in the payload so that:
    //   1. Claude can tie answers back to the original picker it emitted
    //   2. The client can derive `askSubmitted` from message history on reload
    //      by scanning for answer blocks whose askId matches a rendered picker
    const bodyJson = JSON.stringify({ askId, answers, annotations }, null, 2);
    const message = `Here are my answers:\n\n\`\`\`agenthub:ask:answer\n${bodyJson}\n\`\`\``;
    onSubmit(message);
  }

  return (
    <div
      data-ask-id={askId}
      className="border border-indigo-700/50 bg-indigo-950/20 rounded-lg overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-indigo-900/30 border-b border-indigo-700/40">
        <HelpCircle size={14} className="text-indigo-300" />
        <span className="text-xs font-medium text-indigo-200">
          {submitted
            ? 'Answers submitted'
            : `Pick your ${questions.length > 1 ? 'answers' : 'answer'}`}
        </span>
      </div>

      <div className="p-3 space-y-4">
        {questions.map((q: any, i: any) => (
          <QuestionCard
            key={`${askId}-${i}`}
            question={q}
            state={state[i]}
            hasPreview={anyPreview[i]}
            disabled={submitted}
            errored={error?.questionIdx === i}
            onSelectSingle={(label: any) => updateQuestion(i, { selected: label })}
            onToggleMulti={(label: any) => toggleMulti(i, label)}
            onOtherText={(txt: any) => updateQuestion(i, { otherText: txt })}
            onNotes={(txt: any) => updateQuestion(i, { notes: txt })}
            onFocusOption={(idx: any) => updateQuestion(i, { focusedIdx: idx })}
          />
        ))}

        {error && (
          <div className="flex items-center gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-700/50 rounded-md px-3 py-2">
            <AlertCircle size={14} />
            <span>
              Question {error.questionIdx + 1}: {error.reason}
            </span>
          </div>
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitted}
            className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
              submitted
                ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {submitted ? 'Submitted' : 'Submit answers'}
          </button>
        </div>
      </div>
    </div>
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
}: any) {
  const { selected, otherText, notes, focusedIdx } = state;
  const isMulti = question.multiSelect;
  const showPreviewPane = hasPreview && !isMulti;

  const focusedOption =
    showPreviewPane && focusedIdx < question.options.length ? question.options[focusedIdx] : null;

  return (
    <div
      className={`rounded-md border ${errored ? 'border-rose-700/60' : 'border-gray-800'} bg-gray-950/30`}
    >
      <div className="px-3 py-2 border-b border-gray-800 flex items-start gap-2">
        <span className="inline-block text-[10px] uppercase tracking-wide bg-indigo-700/40 text-indigo-200 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
          {question.header.slice(0, 12)}
        </span>
        <span className="text-sm text-gray-100">{question.question}</span>
      </div>

      <div className={`${showPreviewPane ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : ''} p-3`}>
        <div className="space-y-1.5">
          {question.options.map((opt: any, idx: any) => {
            const isChecked = isMulti ? selected.has(opt.label) : selected === opt.label;
            return (
              <OptionRow
                key={opt.label}
                option={opt}
                type={isMulti ? 'checkbox' : 'radio'}
                checked={isChecked}
                focused={showPreviewPane && focusedIdx === idx}
                disabled={disabled}
                onChange={() => {
                  if (isMulti) onToggleMulti(opt.label);
                  else onSelectSingle(opt.label);
                  if (showPreviewPane) onFocusOption(idx);
                }}
                onFocus={() => showPreviewPane && onFocusOption(idx)}
              />
            );
          })}
          <OtherRow
            type={isMulti ? 'checkbox' : 'radio'}
            checked={isMulti ? selected.has(OTHER_SENTINEL) : selected === OTHER_SENTINEL}
            disabled={disabled}
            otherText={otherText}
            onSelect={() => {
              if (isMulti) onToggleMulti(OTHER_SENTINEL);
              else onSelectSingle(OTHER_SENTINEL);
            }}
            onTextChange={onOtherText}
          />
        </div>

        {showPreviewPane && (
          <div>
            <PreviewPane preview={focusedOption?.preview} />
          </div>
        )}
      </div>

      <div className="px-3 pb-3">
        <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e: any) => onNotes(e.target.value)}
          disabled={disabled}
          rows={1}
          placeholder="Add context or reasoning…"
          className="w-full text-xs bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-gray-200 placeholder-gray-600 resize-y focus:outline-none focus:border-indigo-500/60 disabled:opacity-50"
        />
      </div>
    </div>
  );
}

function OptionRow({ option, type, checked, focused, disabled, onChange, onFocus }: any) {
  return (
    <label
      className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
        focused
          ? 'bg-indigo-900/30 border border-indigo-600/40'
          : 'border border-transparent hover:bg-gray-900/50'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      onMouseEnter={onFocus}
    >
      <input
        type={type}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 accent-indigo-500"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-100">{option.label}</div>
        {option.description && <div className="text-xs text-gray-400">{option.description}</div>}
      </div>
    </label>
  );
}

function OtherRow({ type, checked, disabled, otherText, onSelect, onTextChange }: any) {
  return (
    <div
      className={`flex items-start gap-2 px-2 py-1.5 rounded border ${
        checked ? 'border-indigo-600/40 bg-indigo-900/20' : 'border-transparent'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <input
        type={type}
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        className="mt-1.5 accent-indigo-500"
        aria-label="Other"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-300">Other…</div>
        <input
          type="text"
          value={otherText}
          onChange={(e: any) => {
            onTextChange(e.target.value);
            if (!checked) onSelect();
          }}
          disabled={disabled}
          placeholder="Type your own answer"
          className="mt-1 w-full text-xs bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500/60 disabled:opacity-50"
        />
      </div>
    </div>
  );
}

function PreviewPane({ preview }: any) {
  const highlighted = useMemo(() => {
    if (!preview) return null;
    try {
      // Auto-detect language; falls back to plaintext. highlight.js returns
      // HTML which we inject via dangerouslySetInnerHTML inside a <code> tag.
      const result = hljs.highlightAuto(preview);
      return result.value;
    } catch {
      return null;
    }
  }, [preview]);

  if (!preview) {
    return (
      <div className="h-full min-h-[120px] flex items-center justify-center text-xs text-gray-600 bg-gray-950/40 border border-dashed border-gray-800 rounded">
        Hover an option to preview
      </div>
    );
  }

  return (
    <pre className="text-xs bg-gray-950/70 border border-gray-800 rounded p-2 overflow-auto max-h-80 font-mono">
      {highlighted ? (
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlighted }}
          data-testid="ask-preview-code"
        />
      ) : (
        <code className="text-gray-300">{preview}</code>
      )}
    </pre>
  );
}

export default AskUserQuestion;
