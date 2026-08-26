import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Check, HelpCircle } from 'lucide-react';
import {
  IDK,
  STEP_IDS,
  STEP_LABELS,
  HOSTING_OPTIONS,
  ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY,
  initialDraft,
  isDescriptionValid,
  canContinue,
  advance,
  goBack,
  visibleSteps,
  currentVisibleStep,
  toProvisioningPayload,
} from '@shared/utils/adaptiveQuestionnaire';
import { api } from '../utils/api';

/**
 * Adaptive Questionnaire.
 *
 * Collects just enough context to start a real repo. The description is
 * the product spec — the first build session chooses the stack and writes
 * the code. Only the first step is mandatory; hosting / name / visibility
 * expose an **idk** escape hatch. The draft is persisted to sessionStorage
 * so it survives navigation.
 *
 * @param {object} props
 * @param {(payload: object) => void} [props.onSubmit]
 *   Called with the final provisioning payload when the user confirms.
 * @param {() => void} [props.onClose]
 *   Called when the user hits Back on step 1 or closes the wizard.
 * @param {object} [props.initial]
 *   Optional initial draft override (for tests / deep-linking).
 */
export default function AdaptiveQuestionnaire({ onSubmit, onClose, initial }: any) {
  const [draft, setDraft] = useState(() => ({ ...initialDraft(), ...(initial || {}) }));
  const hasRestoredRef = useRef(false);

  // ---- Draft persistence (sessionStorage) ----
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    if (initial) return; // tests / deep-links override persistence
    try {
      const raw = sessionStorage.getItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 2) {
        setDraft({ ...initialDraft(), ...parsed });
      }
    } catch {
      /* ignore */
    }
  }, [initial]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sessionStorage.setItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY, JSON.stringify(draft));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [draft]);

  // ---- Derived state ----
  const stepId = STEP_IDS[draft.step];
  const visible = useMemo(() => visibleSteps(draft), [draft]);
  const currentIdx = currentVisibleStep(draft);
  const totalSteps = visible.length;
  const isLast = stepId === 'review';

  const handleNext = useCallback(() => {
    if (!canContinue(draft)) return;
    setDraft((d: any) => advance(d));
  }, [draft]);

  const handleBack = useCallback(() => {
    if (stepId === 'description') {
      if (onClose) onClose();
      return;
    }
    setDraft((d: any) => goBack(d));
  }, [stepId, onClose]);

  const handleSubmit = useCallback(() => {
    if (!onSubmit) return;
    try {
      sessionStorage.removeItem(ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY);
    } catch {
      /* ignore */
    }
    onSubmit(toProvisioningPayload(draft));
  }, [draft, onSubmit]);

  const pickIdk = useCallback((field: any) => {
    setDraft((d: any) => ({ ...d, [field]: IDK }));
  }, []);

  // ---- AI fill for idk name ----
  // Entering the review step with a blank / idk name kicks a one-shot
  // suggestion call; results land in the draft as ordinary, editable values.
  const [suggesting, setSuggesting] = useState(false);
  const suggestedRef = useRef(false);
  useEffect(() => {
    if (stepId !== 'review' || suggestedRef.current) return;
    const needsName = draft.name === IDK || !String(draft.name || '').trim();
    if (!needsName) return;
    suggestedRef.current = true;
    setSuggesting(true);
    api
      .suggestProjectSetup({
        description: draft.description,
        model: draft.generationModel || undefined,
      })
      .then((r: any) => {
        setDraft((d: any) => ({
          ...d,
          ...(needsName && r?.name ? { name: r.name } : {}),
        }));
      })
      .catch(() => {
        /* fall back to idk semantics — provisioning derives a slug from the description */
      })
      .finally(() => setSuggesting(false));
  }, [stepId, draft]);

  return (
    <div
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="adaptive-questionnaire"
    >
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-4 py-3">
        <button
          type="button"
          onClick={handleBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2 text-sm font-medium text-gray-200 hover:bg-gray-700 hover:text-white transition-colors"
          aria-label="Back"
          data-testid="aq-back"
        >
          <ArrowLeft size={16} className="text-gray-400" />
          Back
        </button>
        <h1 className="min-w-0 flex-1 text-center text-base font-semibold text-white sm:text-left">
          New Project
        </h1>
        <div className="text-xs text-gray-400" data-testid="aq-step-counter">
          Step {currentIdx + 1} of {totalSteps}
        </div>
      </header>

      {/* Progress strip */}
      <StepStrip visible={visible} currentIdx={currentIdx} />

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-2xl">
          {stepId === 'description' && <DescriptionStep draft={draft} setDraft={setDraft} />}
          {stepId === 'hosting' && (
            <HostingStep draft={draft} setDraft={setDraft} onIdk={() => pickIdk('hosting')} />
          )}
          {stepId === 'identity' && <IdentityStep draft={draft} setDraft={setDraft} />}
          {stepId === 'review' && <ReviewStep draft={draft} suggesting={suggesting} />}
        </div>
      </div>

      {/* Footer actions */}
      <footer className="shrink-0 border-t border-gray-800 bg-gray-900/90 px-4 py-3">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-3">
          {isLast ? (
            <button
              type="button"
              onClick={handleSubmit}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition-colors"
              data-testid="aq-submit"
            >
              Create Project
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              disabled={!canContinue(draft)}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition-colors disabled:cursor-not-allowed"
              data-testid="aq-continue"
            >
              Continue
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Progress strip                                                          */
/* ---------------------------------------------------------------------- */

function StepStrip({ visible, currentIdx }: any) {
  return (
    <nav
      aria-label="Questionnaire progress"
      data-testid="aq-step-strip"
      className="w-full flex flex-wrap items-center justify-center gap-1 sm:gap-2 py-3 border-b border-gray-800/80 bg-gray-900/40"
    >
      {visible.map((id: any, i: any) => {
        const isDone = i < currentIdx;
        const isActive = i === currentIdx;
        return (
          <div key={id} className="flex items-center gap-1 sm:gap-2">
            {i > 0 && (
              <div
                className={`hidden sm:block w-4 md:w-8 h-px ${isDone || isActive ? 'bg-emerald-600/80' : 'bg-gray-700'}`}
              />
            )}
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] sm:text-xs font-medium border ${
                isDone
                  ? 'border-emerald-600/60 bg-emerald-950/40 text-emerald-300'
                  : isActive
                    ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                    : 'border-gray-700 text-gray-500'
              }`}
            >
              <span
                className={`tabular-nums w-4 h-4 inline-flex items-center justify-center rounded-full text-[10px] ${
                  isDone
                    ? 'bg-emerald-600 text-white'
                    : isActive
                      ? 'bg-emerald-500/30 text-emerald-200'
                      : 'bg-gray-800 text-gray-500'
                }`}
              >
                {isDone ? '✓' : i + 1}
              </span>
              <span>{STEP_LABELS[id]}</span>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/* ---------------------------------------------------------------------- */
/* Step panels                                                             */
/* ---------------------------------------------------------------------- */

function StepTitle({ title, subtitle }: any) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}
    </div>
  );
}

function IdkButton({ onClick, selected }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="aq-idk"
      className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
        selected
          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-200'
          : 'border-gray-700 bg-gray-800/60 text-gray-300 hover:border-gray-600 hover:bg-gray-800'
      }`}
    >
      <HelpCircle
        size={18}
        className={selected ? 'text-indigo-300' : 'text-gray-500'}
        aria-hidden="true"
      />
      <div className="flex-1">
        <div className="text-sm font-medium">idk — decide later</div>
        <div className="text-xs text-gray-500">
          We&apos;ll defer this to the agent and pick a sensible default.
        </div>
      </div>
      {selected && <Check size={16} className="text-indigo-300" aria-hidden="true" />}
    </button>
  );
}

function DescriptionStep({ draft, setDraft }: any) {
  const invalid = draft.description.length > 0 && !isDescriptionValid(draft.description);
  const [models, setModels] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    try {
      api
        .getModelConfig()
        .then((cfg: any) => alive && setModels(cfg?.engineValidModels?.['claude-code'] || []))
        .catch(() => alive && setModels([]));
    } catch {
      setModels([]);
    }
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div>
      <StepTitle
        title="What are you building?"
        subtitle="This is the spec the first build session implements — stack, tests, Docker, and preview included. One or two sentences is plenty."
      />
      <textarea
        value={draft.description}
        onChange={(e: any) => setDraft((d: any) => ({ ...d, description: e.target.value }))}
        placeholder="e.g. an adaptive survey tool that auto-branches based on answers"
        rows={5}
        autoFocus
        aria-label="What are you building?"
        data-testid="aq-description-input"
        className={`w-full bg-gray-950 border rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 resize-y transition-colors ${
          invalid
            ? 'border-red-700 focus:border-red-500 focus:ring-red-500'
            : 'border-gray-700 focus:border-emerald-500 focus:ring-emerald-500'
        }`}
      />
      {invalid && (
        <p className="mt-2 text-xs text-red-400" role="alert">
          Description can&apos;t be empty — tell us what you&apos;re building.
        </p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <label htmlFor="aq-generation-model" className="text-xs text-gray-400">
          AI model for generated answers
        </label>
        <select
          id="aq-generation-model"
          value={draft.generationModel || ''}
          onChange={(e: any) =>
            setDraft((d: any) => ({ ...d, generationModel: e.target.value || null }))
          }
          data-testid="aq-generation-model"
          className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-emerald-500"
        >
          <option value="">Default</option>
          {models.map((m: any) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-xs text-gray-600">
        Used when you answer &ldquo;idk&rdquo; for the project name — the AI fills it in at review.
      </p>
    </div>
  );
}

function HostingStep({ draft, setDraft, onIdk }: any) {
  return (
    <div>
      <StepTitle
        title="Where should your code live?"
        subtitle="Agent Hub hosting gives you native pull requests, CI, and branch protection with zero external setup."
      />
      <div className="space-y-2">
        {HOSTING_OPTIONS.map((opt: any) => {
          const selected = draft.hosting === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDraft((d: any) => ({ ...d, hosting: opt.value }))}
              data-testid={`aq-hosting-${opt.value}`}
              className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-gray-700 bg-gray-800/60 hover:border-gray-600 hover:bg-gray-800'
              }`}
            >
              <div className="flex-1">
                <div className="text-sm font-medium text-white">{opt.label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{opt.blurb}</div>
              </div>
              {selected && <Check size={16} className="text-emerald-400" aria-hidden="true" />}
            </button>
          );
        })}
        <IdkButton onClick={onIdk} selected={draft.hosting === IDK} />
      </div>
    </div>
  );
}

function IdentityStep({ draft, setDraft }: any) {
  const nameIsIdk = draft.name === IDK;
  return (
    <div>
      <StepTitle title="Name & visibility" subtitle="You can still pick idk for either field." />
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="aq-name-input">
            Project name
          </label>
          <div className="flex gap-2">
            <input
              id="aq-name-input"
              type="text"
              value={nameIsIdk ? '' : draft.name}
              disabled={nameIsIdk}
              placeholder="my-project"
              onChange={(e: any) => setDraft((d: any) => ({ ...d, name: e.target.value }))}
              data-testid="aq-name-input"
              className={`flex-1 bg-gray-950 border rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 transition-colors ${
                nameIsIdk
                  ? 'border-indigo-700 opacity-60'
                  : 'border-gray-700 focus:border-emerald-500 focus:ring-emerald-500'
              }`}
            />
            <button
              type="button"
              onClick={() => setDraft((d: any) => ({ ...d, name: nameIsIdk ? '' : IDK }))}
              data-testid="aq-name-idk"
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                nameIsIdk
                  ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                  : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              idk
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Visibility</label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: 'private', label: 'Private' },
              { value: 'public', label: 'Public' },
              { value: IDK, label: 'idk' },
            ].map((v: any) => {
              const selected = draft.visibility === v.value;
              const isIdkOpt = v.value === IDK;
              return (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setDraft((d: any) => ({ ...d, visibility: v.value }))}
                  data-testid={`aq-visibility-${v.value}`}
                  className={`rounded-lg border p-3 text-sm font-medium transition-colors ${
                    selected
                      ? isIdkOpt
                        ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200'
                        : 'border-emerald-500 bg-emerald-500/10 text-emerald-200'
                      : 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewStep({ draft, suggesting = false }: any) {
  const payload = toProvisioningPayload(draft);
  const rows = [
    ['What', payload.description],
    ['Hosting', payload.hostOnAgentHub ? 'Agent Hub' : 'GitHub only'],
    ['Name', formatValue(payload.name)],
    ['Visibility', formatValue(payload.visibility)],
  ];
  return (
    <div>
      <StepTitle
        title="Review & confirm"
        subtitle="The first build session will choose the stack, write the app, tests, Docker setup, and preview from the description."
      />
      {suggesting && (
        <p className="mb-3 text-xs text-indigo-300" data-testid="aq-suggesting">
          ✨ Filling in your idk answers with AI…
        </p>
      )}
      <dl className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
        {rows.map(([label, value]: any) => (
          <div
            key={label}
            className="grid grid-cols-[110px_1fr] gap-3 px-4 py-3 bg-gray-900/60"
            data-testid={`aq-review-${label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
            <dd className="text-sm text-gray-200 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function formatValue(v: any) {
  if (v == null) return '—';
  if (v === IDK) return <span className="italic text-indigo-300">idk — defer to agent</span>;
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return String(v);
}
