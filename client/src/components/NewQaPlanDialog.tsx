import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { api, type QaCreatePlanInput } from '../utils/api';
import {
  matchQaEnvironment,
  selectableQaEnvironments,
  type QaEnvironmentWire,
} from '@shared/utils/qaEnvironments';

interface EpicOption {
  id: string;
  name: string;
}

interface CardOption {
  id: string;
  title: string;
  shortId: number | null;
  epicId: string | null;
}

export interface QaPlanDraft {
  title: string;
  targetUrl: string;
  goal: string;
  epicId: string;
  cardId: string;
}

export type QaPlanDraftErrors = Partial<Record<'title' | 'targetUrl', string>>;

/** Mirrors the server rule: the QA agent drives the target in a browser. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateQaPlanDraft(draft: QaPlanDraft): QaPlanDraftErrors {
  const errors: QaPlanDraftErrors = {};
  if (!draft.title.trim()) errors.title = 'Title is required';
  if (!draft.targetUrl.trim()) errors.targetUrl = 'Target URL is required';
  else if (!isHttpUrl(draft.targetUrl)) {
    errors.targetUrl = 'Enter a full http:// or https:// URL';
  }
  return errors;
}

export function draftToCreateInput(draft: QaPlanDraft): QaCreatePlanInput {
  return {
    title: draft.title.trim(),
    targetUrl: draft.targetUrl.trim(),
    goal: draft.goal.trim(),
    epicId: draft.epicId || null,
    cardId: draft.cardId || null,
  };
}

/** Cards offered by the picker: the chosen epic's cards when one is set, newest first. */
export function filterCardOptions(
  cards: CardOption[],
  epicId: string,
  query: string,
): CardOption[] {
  const q = query.trim().toLowerCase();
  const num = /^#?\d+$/.test(q) ? q.replace('#', '') : null;
  return cards
    .filter((c) => !epicId || c.epicId === epicId)
    .filter(
      (c) =>
        !q ||
        c.title.toLowerCase().includes(q) ||
        (num !== null && c.shortId != null && String(c.shortId).startsWith(num)),
    )
    .sort((a, b) => (b.shortId ?? 0) - (a.shortId ?? 0))
    .slice(0, 200);
}

function toCardOptions(raw: unknown): CardOption[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { cards?: unknown })?.cards)
      ? (raw as { cards: unknown[] }).cards
      : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .filter((c) => typeof c.id === 'string' && typeof c.title === 'string')
    .map((c) => ({
      id: c.id as string,
      title: c.title as string,
      shortId: typeof c.short_id === 'number' ? c.short_id : null,
      epicId: typeof c.epic_id === 'string' ? c.epic_id : null,
    }));
}

function toEpicOptions(raw: unknown): EpicOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .filter((e) => typeof e.id === 'string' && typeof e.name === 'string')
    .map((e) => ({ id: e.id as string, name: e.name as string }));
}

export interface NewQaPlanDialogProps {
  projectId: string;
  onClose: () => void;
  /** Called with the new plan id once it exists. */
  onCreated: (planId: string) => void | Promise<void>;
}

const inputClass =
  'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none';

export default function NewQaPlanDialog({ projectId, onClose, onCreated }: NewQaPlanDialogProps) {
  const [draft, setDraft] = useState<QaPlanDraft>({
    title: '',
    targetUrl: '',
    goal: '',
    epicId: '',
    cardId: '',
  });
  const [touched, setTouched] = useState(false);
  const [epics, setEpics] = useState<EpicOption[]>([]);
  const [cards, setCards] = useState<CardOption[]>([]);
  const [environments, setEnvironments] = useState<QaEnvironmentWire[]>([]);
  const [cardQuery, setCardQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.getEpics(projectId).catch(() => []),
      api.getBoardCards(projectId).catch(() => []),
      api.listQaEnvironments(projectId).catch(() => ({ environments: [] })),
    ]).then(([e, c, envRes]) => {
      if (cancelled) return;
      setEpics(toEpicOptions(e));
      setCards(toCardOptions(c));
      const envs = selectableQaEnvironments(envRes?.environments ?? []);
      setEnvironments(envs);
      // Default to the first environment unless the user already typed a URL.
      if (envs[0]) {
        setDraft((d) => (d.targetUrl ? d : { ...d, targetUrl: envs[0].baseUrl.trim() }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const errors = validateQaPlanDraft(draft);
  const cardOptions = useMemo(
    () => filterCardOptions(cards, draft.epicId, cardQuery),
    [cards, draft.epicId, cardQuery],
  );
  const selectedCard = cards.find((c) => c.id === draft.cardId);
  const selectedEnv = matchQaEnvironment(environments, draft.targetUrl);

  const set = <K extends keyof QaPlanDraft>(key: K, value: QaPlanDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { plan } = await api.createQaPlan(projectId, draftToCreateInput(draft));
      await onCreated(plan.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the QA plan');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New QA plan"
        data-testid="qa-new-plan-dialog"
        onSubmit={submit}
        noValidate
        className="flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-xl"
      >
        <div className="flex items-center">
          <h2 className="text-base font-semibold text-gray-100">New QA plan</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={submitting}
            className="ml-auto text-gray-500 hover:text-gray-300"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Creates a draft plan and opens a chat with the QA agent to draft its test cases.
        </p>

        {/* Locked while creating: the dialog closes on success, so later typing would be lost. */}
        <fieldset
          disabled={submitting}
          data-testid="qa-new-fields"
          className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
        >
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Title
            <input
              data-testid="qa-new-title"
              className={inputClass}
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              autoFocus
            />
            {touched && errors.title && <span className="text-red-400">{errors.title}</span>}
          </label>

          {environments.length > 0 && (
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Environment
              <select
                data-testid="qa-new-environment"
                className={inputClass}
                value={selectedEnv?.id ?? ''}
                onChange={(e) => {
                  const env = environments.find((x) => x.id === e.target.value);
                  set('targetUrl', env ? env.baseUrl.trim() : '');
                }}
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name} ({env.baseUrl.trim()})
                  </option>
                ))}
                <option value="">Custom URL</option>
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Target URL
            <input
              data-testid="qa-new-target"
              className={inputClass}
              type="url"
              placeholder="https://staging.example.com"
              value={draft.targetUrl}
              onChange={(e) => set('targetUrl', e.target.value)}
              onBlur={() => draft.targetUrl && setTouched(true)}
            />
            {touched && errors.targetUrl && (
              <span className="text-red-400" data-testid="qa-new-target-error">
                {errors.targetUrl}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Goal
            <textarea
              data-testid="qa-new-goal"
              className={`${inputClass} min-h-[72px]`}
              placeholder="What should this plan prove works?"
              value={draft.goal}
              onChange={(e) => set('goal', e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Epic (optional)
            <select
              data-testid="qa-new-epic"
              className={inputClass}
              value={draft.epicId}
              onChange={(e) => {
                const epicId = e.target.value;
                setDraft((d) => {
                  const card = cards.find((c) => c.id === d.cardId);
                  const keepCard = !epicId || card?.epicId === epicId;
                  return { ...d, epicId, cardId: keepCard ? d.cardId : '' };
                });
              }}
            >
              <option value="">None</option>
              {epics.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-xs text-gray-400">
            <span>Card (optional)</span>
            <input
              data-testid="qa-new-card-filter"
              className={inputClass}
              placeholder="Filter cards by title or #number"
              value={cardQuery}
              onChange={(e) => setCardQuery(e.target.value)}
            />
            <select
              aria-label="Card"
              data-testid="qa-new-card"
              className={inputClass}
              value={draft.cardId}
              onChange={(e) => set('cardId', e.target.value)}
            >
              <option value="">None</option>
              {selectedCard && !cardOptions.includes(selectedCard) && (
                <option value={selectedCard.id}>
                  {selectedCard.shortId != null ? `#${selectedCard.shortId} ` : ''}
                  {selectedCard.title}
                </option>
              )}
              {cardOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shortId != null ? `#${c.shortId} ` : ''}
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        {error && (
          <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="qa-new-submit"
            disabled={submitting}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-60"
          >
            {submitting ? 'Creating…' : 'Create and open chat'}
          </button>
        </div>
      </form>
    </div>
  );
}
