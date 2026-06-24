const LABEL_CLASS = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5';
const FIELD_CLASS =
  'w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 focus:border-emerald-500/40 transition-colors';
const FIELD_MONO_CLASS = `${FIELD_CLASS} font-mono text-xs`;
const SELECT_CLASS = `${FIELD_CLASS} cursor-pointer`;
const HINT_CLASS = 'text-[11px] text-gray-500 mt-1.5 leading-snug';

export const EMPTY_AUTONOMOUS_FORM = {
  autonomous: 0,
  autonomous_interval: 5,
  autonomous_max_concurrent: 1,
  autonomous_model: '',
  autonomous_send_it: 0,
  pr_base_branch: '',
} as Record<string, any>;

export function epicToAutonomousForm(epic: any) {
  return {
    autonomous: epic.autonomous || 0,
    autonomous_interval: epic.autonomous_interval || 5,
    autonomous_max_concurrent: epic.autonomous_max_concurrent || 1,
    autonomous_model: epic.autonomous_model || '',
    autonomous_send_it: epic.autonomous_send_it || 0,
    pr_base_branch: epic.pr_base_branch || '',
  };
}

function FieldLabel({ htmlFor, children }: any) {
  return (
    <label htmlFor={htmlFor} className={LABEL_CLASS}>
      {children}
    </label>
  );
}

function ToggleSwitch({ checked, onChange, ariaLabel }: any) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 ${
        checked ? 'bg-emerald-600' : 'bg-white/10'
      }`}
    >
      <span
        className={`pointer-events-none absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-200 ease-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/** Inline autonomous dispatch settings for epic or phase scope. */
export default function EpicAutonomousPanel({
  form,
  onChange,
  modelConfig,
  scopeLabel = 'epic',
}: any) {
  const scopeNoun = scopeLabel === 'phase' ? 'phase' : 'epic';
  return (
    <div className="space-y-5" data-testid="epic-autonomous-panel">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-100">Enable autonomous dispatch</div>
          <p className={`${HINT_CLASS} mt-0.5`}>
            {scopeNoun === 'phase'
              ? 'Configure auto-dispatch — tickets are assigned only when you click Run phase.'
              : `Automatically assign To Do tickets in this ${scopeNoun} when agent slots are free.`}
          </p>
        </div>
        <ToggleSwitch
          checked={!!form.autonomous}
          ariaLabel="Autonomous mode"
          onChange={(on: any) => onChange({ autonomous: on ? 1 : 0 })}
        />
      </div>

      {scopeLabel !== 'phase' ? (
        <div>
          <FieldLabel htmlFor="autonomous-pr-base">PR base branch</FieldLabel>
          <input
            id="autonomous-pr-base"
            type="text"
            value={form.pr_base_branch ?? ''}
            onChange={(e: any) => onChange({ pr_base_branch: e.target.value })}
            placeholder="feature/epic-integration"
            data-testid="autonomous-pr-base-input"
            className={FIELD_MONO_CLASS}
          />
          <p className={HINT_CLASS}>
            Default base branch for cards in this epic. Cards can override individually. Leave empty
            to use the repo default. Integration branches enforce serial dispatch.
          </p>
        </div>
      ) : (
        <p className={HINT_CLASS}>Phases inherit the epic&apos;s PR base branch setting.</p>
      )}

      {form.autonomous === 1 ? (
        <div className="space-y-5">
          <div>
            <FieldLabel htmlFor="autonomous-max-concurrent">Max concurrent</FieldLabel>
            <input
              id="autonomous-max-concurrent"
              type="number"
              value={form.autonomous_max_concurrent || 1}
              onChange={(e: any) =>
                onChange({
                  autonomous_max_concurrent: parseInt(e.target.value, 10) || 1,
                })
              }
              min={1}
              max={5}
              disabled={!!form.pr_base_branch?.trim()}
              data-testid="autonomous-max-concurrent-input"
              className={`w-20 ${FIELD_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
            />
            <p className={HINT_CLASS}>
              Limits cards in both In Progress and Review — new work won&apos;t start until PRs are
              merged.
            </p>
            {form.pr_base_branch?.trim() ? (
              <p className="text-[11px] text-amber-400/90 mt-1.5 leading-snug">
                Integration branch enforces serial dispatch (effective max:{' '}
                <span className="font-mono">1</span>).
              </p>
            ) : null}
          </div>

          <div>
            <FieldLabel htmlFor="autonomous-model">Session model</FieldLabel>
            <select
              id="autonomous-model"
              key={modelConfig ? 'models-loaded' : 'models-pending'}
              value={form.autonomous_model ?? ''}
              onChange={(e: any) => onChange({ autonomous_model: e.target.value })}
              data-testid="autonomous-model-select"
              className={SELECT_CLASS}
            >
              <option value="">Each agent&apos;s default</option>
              {modelConfig?.engineValidModels &&
                Object.entries(modelConfig.engineValidModels).map(([eng, models]: any) => (
                  <optgroup key={eng} label={eng}>
                    {(models || []).map((m: any) => (
                      <option key={`${eng}:${m}`} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-100">Auto Merge</div>
              <p className={`${HINT_CLASS} mt-0.5`}>
                Start dispatched sessions with Finalize auto-merge enabled, even when the
                project&apos;s auto-merge is off.
              </p>
            </div>
            <ToggleSwitch
              checked={form.autonomous_send_it === 1}
              ariaLabel="Auto Merge"
              onChange={(on: any) => onChange({ autonomous_send_it: on ? 1 : 0 })}
            />
          </div>
        </div>
      ) : (
        <p className={`${HINT_CLASS} text-center py-2`}>
          Turn on autonomous dispatch to configure concurrency, model, and Auto Merge.
        </p>
      )}
    </div>
  );
}
