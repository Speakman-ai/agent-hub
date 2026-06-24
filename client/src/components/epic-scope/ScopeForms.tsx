import { useState } from 'react';

export const SCOPE_LABEL_CLASS =
  'block text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1';
export const SCOPE_FIELD_CLASS =
  'w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-500/40';
export const SCOPE_TEXTAREA_CLASS = `${SCOPE_FIELD_CLASS} resize-y min-h-[72px] text-xs leading-relaxed`;

function FormActions({ onCancel, submitLabel, disabled, compact }: any) {
  return (
    <div className={`flex items-center gap-2 ${compact ? '' : 'pt-1'}`}>
      <button
        type="submit"
        disabled={disabled}
        className="px-2.5 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/40 text-white rounded-lg transition-colors"
      >
        {submitLabel}
      </button>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 rounded-lg hover:bg-white/[0.06]"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/** Tag + title fields for a new spec decision. */
export function AddSpecItemForm({
  onSubmit,
  onCancel,
  saving = false,
  autoFocus = false,
  compact = false,
}: any) {
  const [tag, setTag] = useState('');
  const [title, setTitle] = useState('');

  const handleSubmit = (e: any) => {
    e.preventDefault();
    const t = tag.trim();
    const n = title.trim();
    if (!t || !n) return;
    onSubmit?.({ tag: t, title: n });
    setTag('');
    setTitle('');
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={`rounded-xl border border-white/[0.08] bg-white/[0.02] ${compact ? 'p-3 space-y-2' : 'p-4 space-y-3'}`}
      data-testid="add-spec-item-form"
    >
      <div
        className={
          compact
            ? 'grid grid-cols-1 gap-2 sm:grid-cols-2'
            : 'grid grid-cols-1 sm:grid-cols-2 gap-3'
        }
      >
        <div>
          <label htmlFor="spec-tag" className={SCOPE_LABEL_CLASS}>
            Tag
          </label>
          <input
            id="spec-tag"
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="e.g. MODEL"
            autoFocus={autoFocus}
            className={SCOPE_FIELD_CLASS}
          />
        </div>
        <div className={compact ? 'sm:col-span-1' : 'sm:col-span-1'}>
          <label htmlFor="spec-title" className={SCOPE_LABEL_CLASS}>
            Decision / question
          </label>
          <input
            id="spec-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be decided?"
            className={SCOPE_FIELD_CLASS}
          />
        </div>
      </div>
      <FormActions
        onCancel={onCancel}
        submitLabel={saving ? 'Adding…' : 'Add decision'}
        disabled={saving || !tag.trim() || !title.trim()}
        compact={compact}
      />
    </form>
  );
}

/** Single name field for a new phase. */
export function AddPhaseForm({
  onSubmit,
  onCancel,
  saving = false,
  autoFocus = true,
  submitLabel = 'Add phase',
  inline = false,
}: any) {
  const [name, setName] = useState('');

  const handleSubmit = (e: any) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    onSubmit?.(n);
    setName('');
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={
        inline
          ? 'flex flex-wrap items-end gap-2'
          : 'rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3'
      }
      data-testid="add-phase-form"
    >
      <div className={inline ? 'flex-1 min-w-[140px]' : undefined}>
        {!inline && (
          <label htmlFor="phase-name" className={SCOPE_LABEL_CLASS}>
            Phase name
          </label>
        )}
        <input
          id="phase-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Phase name"
          autoFocus={autoFocus}
          className={SCOPE_FIELD_CLASS}
        />
      </div>
      <FormActions
        onCancel={onCancel}
        submitLabel={saving ? 'Adding…' : submitLabel}
        disabled={saving || !name.trim()}
        compact={inline}
      />
    </form>
  );
}

/** Single title field for a new ticket in a phase. */
export function AddTicketForm({ onSubmit, onCancel, saving = false }: any) {
  const [title, setTitle] = useState('');

  const handleSubmit = (e: any) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    onSubmit?.(t);
    setTitle('');
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 p-2" data-testid="add-ticket-form">
      <label htmlFor="ticket-title" className={SCOPE_LABEL_CLASS}>
        Ticket title
      </label>
      <input
        id="ticket-title"
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs to be built?"
        autoFocus
        className={SCOPE_FIELD_CLASS}
      />
      <FormActions
        onCancel={onCancel}
        submitLabel={saving ? 'Adding…' : 'Add'}
        disabled={saving || !title.trim()}
        compact
      />
    </form>
  );
}

/** Edit locked decision text on a spec card. */
export function EditDecisionForm({
  initial = '',
  onSubmit,
  onCancel,
  saving = false,
  submitLabel = 'Save',
  placeholder,
}: any) {
  const [decision, setDecision] = useState(initial);

  const handleSubmit = (e: any) => {
    e.preventDefault();
    const d = decision.trim();
    if (!d) return;
    onSubmit?.(d);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 mt-2" data-testid="edit-decision-form">
      <label htmlFor={`decision-${initial.slice(0, 8)}`} className={SCOPE_LABEL_CLASS}>
        Decision
      </label>
      <textarea
        id={`decision-${initial.slice(0, 8)}`}
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
        rows={6}
        placeholder={placeholder}
        className={SCOPE_TEXTAREA_CLASS}
      />
      <FormActions
        onCancel={onCancel}
        submitLabel={saving ? 'Saving…' : submitLabel}
        disabled={saving || !decision.trim()}
        compact
      />
    </form>
  );
}
