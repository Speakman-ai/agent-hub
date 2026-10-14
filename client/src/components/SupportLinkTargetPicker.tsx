import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api';
import { isImeComposing } from '../utils/keyboard';
import type {
  SupportTicketLinkTargetCard,
  SupportTicketLinkTargetSession,
  SupportTicketLinkTargets,
} from '../utils/api';

export type LinkTarget =
  | { kind: 'card'; id: string; label: string }
  | { kind: 'session'; id: string; label: string };

type Option = LinkTarget & { detail: string };

const SEARCH_DEBOUNCE_MS = 200;

export function cardOptionLabel(c: SupportTicketLinkTargetCard): string {
  return `${c.short_id != null ? `#${c.short_id} · ` : ''}${c.title}`;
}

export function sessionOptionDetail(s: SupportTicketLinkTargetSession): string {
  const card =
    s.card_id != null
      ? `card ${s.card_short_id != null ? `#${s.card_short_id}` : 'linked'}`
      : 'no card yet, one will be created';
  return `${s.agent_name} · ${card}`;
}

export function buildLinkTargetOptions(targets: SupportTicketLinkTargets | null): Option[] {
  if (!targets) return [];
  return [
    ...targets.cards.map(
      (c): Option => ({
        kind: 'card',
        id: c.id,
        label: cardOptionLabel(c),
        detail: c.column_name,
      }),
    ),
    ...targets.sessions.map(
      (s): Option => ({
        kind: 'session',
        id: s.id,
        label: s.name,
        detail: sessionOptionDetail(s),
      }),
    ),
  ];
}

/**
 * Searchable picker for what a support ticket links to: a kanban card, or a
 * session (linked through its card). Results come from the server so the
 * whole board is searchable, not just what fits in a preloaded list.
 */
export default function SupportLinkTargetPicker({
  projectId,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  className = '',
}: {
  projectId: string;
  value: LinkTarget | null;
  onChange: (target: LinkTarget | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // Results are keyed to the query that produced them. Only results for the
  // current query are selectable, so Enter/click never picks a stale match
  // while the debounce or the replacement request is in flight.
  const [results, setResults] = useState<{
    query: string;
    targets: SupportTicketLinkTargets;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const listId = `link-target-list-${useId()}`;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    const handle = setTimeout(() => {
      api
        .searchSupportTicketLinkTargets(projectId, query, { signal: controller.signal })
        .then((res) => {
          setResults({ query, targets: res });
          setActive(0);
        })
        .catch((err: any) => {
          if (controller.signal.aborted) return;
          setError(err?.message || 'Search failed');
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [open, projectId, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const fresh = results !== null && results.query === query;
  const options = useMemo(
    () => (fresh && results ? buildLinkTargetOptions(results.targets) : []),
    [fresh, results],
  );

  const choose = (opt: Option) => {
    onChange({ kind: opt.kind, id: opt.id, label: opt.label } as LinkTarget);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter/arrows/Escape belong to the IME while composing CJK text.
    if (isImeComposing(e)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && options[active]) {
        e.preventDefault();
        choose(options[active]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const inputText = value && !open ? value.label : query;
  const firstSessionIndex = options.findIndex((o) => o.kind === 'session');
  const optionId = (opt: Option) => `${listId}-${opt.kind}-${opt.id}`;
  // Focus stays on the input, so the active row is announced through
  // aria-activedescendant; it is cleared when nothing is selectable.
  const activeOption = open ? options[active] : undefined;
  const activeDescendant = activeOption ? optionId(activeOption) : undefined;

  useEffect(() => {
    if (!activeDescendant) return;
    document.getElementById(activeDescendant)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeDescendant]);

  return (
    <span ref={rootRef} className={`relative block w-full ${className}`}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendant}
        aria-label="Card or session to link the ticket to"
        data-testid="link-target-input"
        placeholder={value ? value.label : 'Search cards or sessions (#123, title)…'}
        value={inputText}
        disabled={disabled}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
          if (value) onChange(null);
        }}
        onKeyDown={onKeyDown}
        className="w-full text-xs bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 disabled:opacity-50"
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          data-testid="link-target-list"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 min-w-[18rem] overflow-auto rounded border border-gray-700 bg-gray-900 py-1 shadow-lg"
        >
          {!fresh && !error ? (
            <li className="px-2 py-1 text-[11px] text-gray-500">Searching…</li>
          ) : null}
          {error ? <li className="px-2 py-1 text-[11px] text-red-400">{error}</li> : null}
          {fresh && !error && !options.length ? (
            <li className="px-2 py-1 text-[11px] text-gray-500">No matching cards or sessions</li>
          ) : null}
          {options.map((opt, i) => (
            <li key={`${opt.kind}:${opt.id}`} role="presentation">
              {i === 0 && opt.kind === 'card' ? (
                <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-gray-500">
                  Cards
                </div>
              ) : null}
              {i === firstSessionIndex ? (
                <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-gray-500">
                  Sessions
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                id={optionId(opt)}
                tabIndex={-1}
                aria-selected={i === active}
                data-testid={`link-target-option-${opt.kind}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(opt)}
                className={`flex w-full flex-col items-start px-2 py-1 text-left ${
                  i === active ? 'bg-gray-800' : ''
                }`}
              >
                <span className="w-full truncate text-xs text-gray-200">{opt.label}</span>
                {opt.detail ? (
                  <span className="w-full truncate text-[10px] text-gray-500">{opt.detail}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
