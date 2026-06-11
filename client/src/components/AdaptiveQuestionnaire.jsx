import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Check, HelpCircle } from 'lucide-react';
import {
  IDK,
  STEP_IDS,
  STEP_LABELS,
  APP_TYPE_OPTIONS,
  INTEGRATION_OPTIONS,
  AUTH_PROVIDER_OPTIONS,
  HOSTING_OPTIONS,
  ADAPTIVE_QUESTIONNAIRE_DRAFT_KEY,
  initialDraft,
  isDescriptionValid,
  canContinue,
  advance,
  goBack,
  visibleSteps,
  currentVisibleStep,
  stackOptionsFor,
  recommendedStack,
  toProvisioningPayload,
} from '../utils/adaptiveQuestionnaire.js';
import { api } from '../utils/api.js';

/**
 * Adaptive Questionnaire.
 *
 * Collects just enough context to scaffold a real repo. Only the first
 * step (What are you building?) is mandatory; every later step exposes an
 * **idk** escape hatch that records "defer to agent/default" semantics. The
 * draft is persisted to sessionStorage so it survives navigation.
 *
 * @param {object} props
 * @param {(payload: object) => void} [props.onSubmit]
 *   Called with the final provisioning payload when the user confirms.
 * @param {() => void} [props.onClose]
 *   Called when the user hits Back on step 1 or closes the wizard.
 * @param {object} [props.initial]
 *   Optional initial draft override (for tests / deep-linking).
 */
export default function AdaptiveQuestionnaire({ onSubmit, onClose, initial }) {
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
      if (parsed && parsed.v === 1) {
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
    setDraft((d) => advance(d));
  }, [draft]);

  const handleBack = useCallback(() => {
    if (stepId === 'description') {
      if (onClose) onClose();
      return;
    }
    setDraft((d) => goBack(d));
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

  const pickIdk = useCallback((field) => {
    setDraft((d) => ({ ...d, [field]: IDK }));
  }, []);

  // ---- AI fill for idk answers ----
  // Entering the review step with any idk (or blank-name) answers kicks a
  // one-shot suggestion call; results land in the draft as ordinary,
  // editable values (Back still works to change them by hand).
  const [suggesting, setSuggesting] = useState(false);
  const suggestedRef = useRef(false);
  useEffect(() => {
    if (stepId !== 'review' || suggestedRef.current) return;
    const needsName = draft.name === IDK || !String(draft.name || '').trim();
    const needsAppType = draft.appType === IDK;
    const needsStack = draft.stack === IDK;
    if (!needsName && !needsAppType && !needsStack) return;
    suggestedRef.current = true;
    setSuggesting(true);
    api
      .suggestProjectSetup({
        description: draft.description,
        appType: needsAppType ? undefined : draft.appType,
        stack: needsStack ? undefined : draft.stack,
        model: draft.generationModel || undefined,
      })
      .then((r) => {
        setDraft((d) => ({
          ...d,
          ...(needsName && r?.name ? { name: r.name } : {}),
          ...(needsAppType && r?.appType ? { appType: r.appType } : {}),
          ...(needsStack && r?.stack ? { stack: r.stack } : {}),
        }));
      })
      .catch(() => {
        /* fall back to idk semantics — provisioning has its own defaults */
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
          {stepId === 'appType' && (
            <AppTypeStep draft={draft} setDraft={setDraft} onIdk={() => pickIdk('appType')} />
          )}
          {stepId === 'stack' && (
            <StackStep draft={draft} setDraft={setDraft} onIdk={() => pickIdk('stack')} />
          )}
          {stepId === 'integrations' && (
            <IntegrationsStep
              draft={draft}
              setDraft={setDraft}
              onIdk={() => pickIdk('integrations')}
            />
          )}
          {stepId === 'auth' && (
            <AuthStep draft={draft} setDraft={setDraft} onIdk={() => pickIdk('authDetail')} />
          )}
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

function StepStrip({ visible, currentIdx }) {
  return (
    <nav
      aria-label="Questionnaire progress"
      data-testid="aq-step-strip"
      className="w-full flex flex-wrap items-center justify-center gap-1 sm:gap-2 py-3 border-b border-gray-800/80 bg-gray-900/40"
    >
      {visible.map((id, i) => {
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

function StepTitle({ title, subtitle }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}
    </div>
  );
}

function IdkButton({ onClick, selected }) {
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

function DescriptionStep({ draft, setDraft }) {
  const invalid = draft.description.length > 0 && !isDescriptionValid(draft.description);
  const [models, setModels] = useState([]);
  useEffect(() => {
    let alive = true;
    try {
      api
        .getModelConfig()
        .then((cfg) => alive && setModels(cfg?.engineValidModels?.['claude-code'] || []))
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
        subtitle="One or two sentences is plenty. This is the only required question — everything else has an idk escape hatch."
      />
      <textarea
        value={draft.description}
        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
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
          onChange={(e) => setDraft((d) => ({ ...d, generationModel: e.target.value || null }))}
          data-testid="aq-generation-model"
          className="bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-emerald-500"
        >
          <option value="">Default</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-xs text-gray-600">
        Used when you answer &ldquo;idk&rdquo; — the AI fills those in for you at the review step.
      </p>
    </div>
  );
}

function AppTypeStep({ draft, setDraft, onIdk }) {
  return (
    <div>
      <StepTitle
        title="What kind of app?"
        subtitle="Pick one — we&rsquo;ll use it to recommend a stack."
      />
      <div className="space-y-2">
        {APP_TYPE_OPTIONS.map((opt) => {
          const selected = draft.appType === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  appType: opt.value,
                  // Reset stack to the recommended default when app type changes
                  stack: recommendedStack(opt.value),
                }))
              }
              data-testid={`aq-apptype-${opt.value}`}
              className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-gray-700 bg-gray-800/60 hover:border-gray-600 hover:bg-gray-800'
              }`}
            >
              <div className="flex-1">
                <div className="text-sm font-medium text-white">{opt.label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{opt.description}</div>
              </div>
              {selected && <Check size={16} className="text-emerald-400" aria-hidden="true" />}
            </button>
          );
        })}
        <IdkButton onClick={onIdk} selected={draft.appType === IDK} />
      </div>
    </div>
  );
}

function StackStep({ draft, setDraft, onIdk }) {
  const options = stackOptionsFor(draft.appType);
  return (
    <div>
      <StepTitle
        title="Which stack?"
        subtitle={
          options.length
            ? 'The recommended default for your app type is pre-selected.'
            : 'No app-type-specific recommendation — pick idk and we\u2019ll use an opinionated default.'
        }
      />
      <div className="space-y-2">
        {options.map((opt) => {
          const selected = draft.stack === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, stack: opt.value }))}
              data-testid={`aq-stack-${opt.value}`}
              className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-gray-700 bg-gray-800/60 hover:border-gray-600 hover:bg-gray-800'
              }`}
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  {opt.label}
                  {opt.recommended && (
                    <span className="text-[10px] uppercase tracking-wide bg-emerald-900/40 text-emerald-300 px-1.5 py-0.5 rounded">
                      Recommended
                    </span>
                  )}
                </div>
              </div>
              {selected && <Check size={16} className="text-emerald-400" aria-hidden="true" />}
            </button>
          );
        })}
        <IdkButton onClick={onIdk} selected={draft.stack === IDK} />
      </div>
    </div>
  );
}

function IntegrationsStep({ draft, setDraft, onIdk }) {
  const current = Array.isArray(draft.integrations) ? draft.integrations : [];
  const toggle = (value) => {
    setDraft((d) => {
      const prev = Array.isArray(d.integrations) ? d.integrations : [];
      const next = prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value];
      // If user removes 'auth' after previously selecting it, clear authDetail
      const patch = { integrations: next };
      if (!next.includes('auth')) patch.authDetail = null;
      return { ...d, ...patch };
    });
  };
  return (
    <div>
      <StepTitle
        title="Which integrations?"
        subtitle="Multi-select. Anything you skip here can still be added later."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {INTEGRATION_OPTIONS.map((opt) => {
          const selected = current.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              aria-pressed={selected}
              data-testid={`aq-integration-${opt.value}`}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-gray-700 bg-gray-800/60 hover:border-gray-600 hover:bg-gray-800'
              }`}
            >
              <div className="flex-1">
                <div className="text-sm font-medium text-white">{opt.label}</div>
                <div className="text-xs text-gray-400 mt-0.5">{opt.description}</div>
              </div>
              {selected && <Check size={16} className="text-emerald-400" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="mt-3">
        <IdkButton onClick={onIdk} selected={draft.integrations === IDK} />
      </div>
    </div>
  );
}

function AuthStep({ draft, setDraft, onIdk }) {
  const detail = draft.authDetail && draft.authDetail !== IDK ? draft.authDetail : null;
  const provider = detail?.provider ?? null;
  return (
    <div>
      <StepTitle
        title="How should users sign in?"
        subtitle="You selected the Auth integration — tell us a bit more, or punt on individual fields with idk."
      />
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Provider</label>
          <div className="space-y-2">
            {AUTH_PROVIDER_OPTIONS.map((opt) => {
              const selected = provider === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      authDetail: {
                        provider: opt.value,
                        userModel:
                          d.authDetail && d.authDetail !== IDK ? d.authDetail.userModel : IDK,
                      },
                    }))
                  }
                  data-testid={`aq-auth-provider-${opt.value}`}
                  className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    selected
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-gray-700 bg-gray-800/60 hover:border-gray-600 hover:bg-gray-800'
                  }`}
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white">{opt.label}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{opt.description}</div>
                  </div>
                  {selected && <Check size={16} className="text-emerald-400" aria-hidden="true" />}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  authDetail: {
                    provider: IDK,
                    userModel: d.authDetail && d.authDetail !== IDK ? d.authDetail.userModel : IDK,
                  },
                }))
              }
              data-testid="aq-auth-provider-idk"
              className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                provider === IDK
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-200'
                  : 'border-gray-700 bg-gray-800/60 text-gray-300 hover:border-gray-600 hover:bg-gray-800'
              }`}
            >
              <HelpCircle size={16} className="text-gray-500" aria-hidden="true" />
              <span className="text-sm">idk — pick for me</span>
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            User model extras (optional)
          </label>
          <input
            type="text"
            value={detail && detail.userModel !== IDK ? detail.userModel : ''}
            placeholder="e.g. teams, orgs, roles (leave blank for defaults)"
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                authDetail: {
                  provider: d.authDetail && d.authDetail !== IDK ? d.authDetail.provider : IDK,
                  userModel: e.target.value,
                },
              }))
            }
            data-testid="aq-auth-usermodel"
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
          />
        </div>

        <IdkButton onClick={onIdk} selected={draft.authDetail === IDK} />
      </div>
    </div>
  );
}

function HostingStep({ draft, setDraft, onIdk }) {
  return (
    <div>
      <StepTitle
        title="Where should your code live?"
        subtitle="Agent Hub hosting gives you native pull requests, CI, and branch protection with zero external setup."
      />
      <div className="space-y-2">
        {HOSTING_OPTIONS.map((opt) => {
          const selected = draft.hosting === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, hosting: opt.value }))}
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

function IdentityStep({ draft, setDraft }) {
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
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              data-testid="aq-name-input"
              className={`flex-1 bg-gray-950 border rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 transition-colors ${
                nameIsIdk
                  ? 'border-indigo-700 opacity-60'
                  : 'border-gray-700 focus:border-emerald-500 focus:ring-emerald-500'
              }`}
            />
            <button
              type="button"
              onClick={() => setDraft((d) => ({ ...d, name: nameIsIdk ? '' : IDK }))}
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
            ].map((v) => {
              const selected = draft.visibility === v.value;
              const isIdkOpt = v.value === IDK;
              return (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, visibility: v.value }))}
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

function ReviewStep({ draft, suggesting = false }) {
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
    <div>
      <StepTitle
        title="Review & confirm"
        subtitle="Anything marked idk will be filled in by the provisioning agent with a sensible default."
      />
      {suggesting && (
        <p className="mb-3 text-xs text-indigo-300" data-testid="aq-suggesting">
          ✨ Filling in your idk answers with AI…
        </p>
      )}
      <dl className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
        {rows.map(([label, value]) => (
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

function formatValue(v) {
  if (v == null) return '—';
  if (v === IDK) return <span className="italic text-indigo-300">idk — defer to agent</span>;
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return String(v);
}

function formatAuth(detail) {
  if (detail === IDK) return <span className="italic text-indigo-300">idk — defer to agent</span>;
  const provider = detail.provider === IDK ? 'idk' : detail.provider;
  const userModel = detail.userModel === IDK ? 'idk' : detail.userModel || '—';
  return `${provider} · user model: ${userModel}`;
}
