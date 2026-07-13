import { DEFAULT_EPIC_COLOR } from '../utils/epics';

export const EPIC_COLORS = [
  '#6366F1',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#06B6D4',
  '#3B82F6',
];

export const EMPTY_EPIC_FORM = {
  name: '',
  description: '',
  labels: '',
  assigned_user_id: '',
  color: DEFAULT_EPIC_COLOR,
} as Record<string, any>;

const LABEL_CLASS = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5';
const FIELD_CLASS =
  'w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-colors';

function FieldLabel({ htmlFor, children }: any) {
  return (
    <label htmlFor={htmlFor} className={LABEL_CLASS}>
      {children}
    </label>
  );
}

/** Inline feature metadata fields for the feature screen. */
export default function EpicDetailsPanel({ form, onChange, autoFocusName = false }: any) {
  return (
    <div className="space-y-5" data-testid="epic-details-panel">
      <div>
        <FieldLabel htmlFor="epic-name">Name</FieldLabel>
        <input
          id="epic-name"
          type="text"
          value={form.name}
          onChange={(e: any) => onChange({ name: e.target.value })}
          placeholder="e.g. Platform reliability"
          autoFocus={autoFocusName}
          data-testid="epic-name-input"
          className={FIELD_CLASS}
        />
      </div>

      <div>
        <FieldLabel htmlFor="epic-description">Description</FieldLabel>
        <textarea
          id="epic-description"
          value={form.description}
          onChange={(e: any) => onChange({ description: e.target.value })}
          placeholder="Optional summary or goals for this feature"
          rows={3}
          data-testid="epic-description-input"
          className={`${FIELD_CLASS} resize-y min-h-[88px] leading-relaxed`}
        />
      </div>

      <div>
        <FieldLabel htmlFor="epic-labels">Labels</FieldLabel>
        <input
          id="epic-labels"
          type="text"
          value={form.labels ?? ''}
          onChange={(e: any) => onChange({ labels: e.target.value })}
          placeholder="platform, q1, infra"
          data-testid="epic-labels-input"
          className={FIELD_CLASS}
        />
      </div>

      <div>
        <span className={LABEL_CLASS}>Color</span>
        <div className="flex flex-wrap items-center gap-2">
          {EPIC_COLORS.map((color: any) => (
            <button
              key={color}
              type="button"
              aria-label={`Select color ${color}`}
              aria-pressed={form.color === color}
              onClick={() => onChange({ color })}
              className={`h-7 w-7 rounded-full transition-all ${
                form.color === color
                  ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-950 scale-110'
                  : 'hover:scale-105 opacity-90 hover:opacity-100'
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
