import { useState } from 'react';
import { Check, Circle, Clock, Plus, Sparkles, PenLine } from 'lucide-react';
import { AddSpecItemForm, EditDecisionForm } from './ScopeForms';

const STATUS_META: Record<string, { label: string; className: string; Icon: typeof Check }> = {
  open: { label: 'Open', className: 'text-amber-400', Icon: Circle },
  chosen: { label: 'Locked', className: 'text-emerald-400', Icon: Check },
  deferred: { label: 'Deferred', className: 'text-gray-400', Icon: Clock },
};

function SpecItemCard({ item, index, savingId, onUpdateSpecItem, onDecideForMe, layout }: any) {
  const [editing, setEditing] = useState(false);
  const meta = STATUS_META[item.status] || STATUS_META.open;
  const StatusIcon = meta.Icon;
  const chosen = item.status === 'chosen';
  const deciding = savingId === item.id;

  return (
    <div
      className={`rounded-xl border bg-white/[0.02] p-4 relative flex flex-col ${
        chosen ? 'border-emerald-500/20 bg-emerald-500/[0.03]' : 'border-white/[0.08]'
      } ${layout === 'grid' ? 'h-full' : ''}`}
      data-testid={`spec-item-${item.id}`}
    >
      <span
        className={`absolute top-3 right-3 inline-flex items-center gap-1 text-[10px] font-medium ${meta.className}`}
      >
        <StatusIcon size={12} />
        {meta.label}
      </span>

      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
        {item.tag}
      </p>
      <h4 className="text-sm font-semibold text-gray-100 pr-20 leading-snug">{item.title}</h4>

      <div className="mt-2 flex-1">
        {editing ? (
          <EditDecisionForm
            initial={item.decision || ''}
            saving={deciding}
            submitLabel={chosen ? 'Save' : 'Lock decision'}
            placeholder={
              chosen
                ? undefined
                : '## Decision\nYour choice…\n\n## Rationale\nWhy — tradeoffs, risks, context for agents…'
            }
            onCancel={() => setEditing(false)}
            onSubmit={(decision: string) => {
              onUpdateSpecItem?.(item.id, { decision, status: 'chosen' });
              setEditing(false);
            }}
          />
        ) : chosen ? (
          <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">
            {item.decision}
          </p>
        ) : (
          <p className="text-xs text-gray-500 italic leading-relaxed">
            Write the decision yourself, or use Decide for me to research trade-offs and lock a
            recommendation with rationale.
          </p>
        )}
      </div>

      {!editing && (
        <div className="mt-4 pt-3 border-t border-white/[0.06] flex flex-wrap items-center gap-2">
          {!chosen && (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-300 hover:text-gray-100 bg-white/[0.06] hover:bg-white/[0.08] px-2 py-1 rounded-md transition-colors"
                data-testid={`write-decision-${item.id}`}
              >
                <PenLine size={10} />
                Write decision
              </button>
              <button
                type="button"
                disabled={deciding}
                onClick={() => onDecideForMe?.(item.id)}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-300 hover:text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/15 disabled:opacity-50 px-2 py-1 rounded-md transition-colors"
                data-testid={`decide-for-me-${item.id}`}
              >
                <Sparkles size={10} />
                {deciding ? 'Starting…' : 'Decide for me'}
              </button>
            </>
          )}
          {chosen ? (
            <button
              type="button"
              className="text-[10px] text-gray-500 hover:text-gray-300 ml-auto"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ) : (
            <span className="text-[10px] text-gray-600 ml-auto">#{index + 1}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Spec decisions panel — hero section on the epic page. */
export default function EpicSpecView({
  specItems = [],
  onAddSpecItem,
  onUpdateSpecItem,
  onDecideForMe,
  savingId,
  layout = 'stack',
  showHeader = true,
  addFormOpen: addFormOpenProp,
  onAddFormOpenChange,
}: any) {
  const [addFormOpenLocal, setAddFormOpenLocal] = useState(false);
  const addFormOpen = addFormOpenProp ?? addFormOpenLocal;
  const setAddFormOpen = onAddFormOpenChange ?? setAddFormOpenLocal;

  const handleAddSubmit = (payload: { tag: string; title: string }) => {
    onAddSpecItem?.(payload);
    setAddFormOpen(false);
  };

  const openCount = specItems.filter((s: any) => s.status === 'open').length;
  const chosenCount = specItems.filter((s: any) => s.status === 'chosen').length;
  const showAddForm = addFormOpen || specItems.length === 0;

  return (
    <section className="space-y-3" data-testid="epic-spec-view">
      {showHeader && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-100">Spec decisions</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Architecture choices for this epic. Write them yourself or use Decide for me.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {specItems.length > 0 && (
              <span className="text-[11px] text-gray-500">
                <span className="text-emerald-400 font-medium">{chosenCount}</span>/
                {specItems.length} locked
              </span>
            )}
            {!showAddForm && (
              <button
                type="button"
                onClick={() => setAddFormOpen(true)}
                disabled={savingId === 'new'}
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 bg-emerald-600/20 hover:bg-emerald-600/30 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors"
              >
                <Plus size={12} />
                Spec decision
              </button>
            )}
          </div>
        </div>
      )}

      {showAddForm && (
        <AddSpecItemForm
          onSubmit={handleAddSubmit}
          onCancel={specItems.length > 0 ? () => setAddFormOpen(false) : undefined}
          saving={savingId === 'new'}
          autoFocus
          compact={layout === 'grid'}
        />
      )}

      {openCount > 0 && specItems.length > 0 && (
        <p className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          {openCount} open decision{openCount !== 1 ? 's' : ''} — lock them before implementation
          tickets run autonomously.
        </p>
      )}

      {specItems.length > 0 && (
        <div
          className={layout === 'grid' ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-3'}
        >
          {specItems.map((item: any, i: number) => (
            <SpecItemCard
              key={item.id}
              item={item}
              index={i}
              savingId={savingId}
              onUpdateSpecItem={onUpdateSpecItem}
              onDecideForMe={onDecideForMe}
              layout={layout}
            />
          ))}
        </div>
      )}
    </section>
  );
}
