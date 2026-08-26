import { epicBranchTogglePatch } from '../utils/epics';

function ToggleSwitch({ checked, onChange }: any) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label="Keep on feature branch"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 ${
        checked ? 'bg-emerald-600' : 'bg-white/10'
      }`}
    >
      <span
        className={`pointer-events-none absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-200 ease-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export default function FeatureBranchPanel({ form, onChange, onBlur }: any) {
  const enabled = !!form.pr_base_branch?.trim();

  return (
    <div className="space-y-3" data-testid="feature-branch-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-100">Keep on feature branch</div>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
            Merge this feature&apos;s tickets into a shared branch before opening the final pull
            request to the repo default branch.
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={(on: boolean) => onChange(epicBranchTogglePatch(form, on), { immediate: true })}
        />
      </div>

      {enabled ? (
        <div>
          <label
            htmlFor="feature-pr-base"
            className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-gray-500"
          >
            Feature branch
          </label>
          <input
            id="feature-pr-base"
            type="text"
            value={form.pr_base_branch ?? ''}
            onChange={(event) => onChange({ pr_base_branch: event.target.value })}
            onBlur={onBlur}
            placeholder="feature/platform-reliability"
            data-testid="feature-pr-base-input"
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 font-mono text-xs text-gray-100 placeholder-gray-500 transition-colors focus:border-emerald-500/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <p className="mt-1.5 text-[11px] leading-snug text-gray-500">
            Ticket pull requests target this branch and skip CI. CI runs on the final pull request
            to the repo default branch.
          </p>
        </div>
      ) : null}
    </div>
  );
}
