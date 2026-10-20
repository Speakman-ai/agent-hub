import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Building2, Check, ChevronDown, Folder } from 'lucide-react';

export interface OrganizationMenuOption {
  id: string;
  name: string;
  /** Unlinked projects. Renders with a folder instead of an organization mark. */
  independent?: boolean;
}

/**
 * The organization switcher used by the sidebar and the Organizations page.
 * Choosing an option closes the menu and reports the id. The open menu
 * filters options as you type.
 */
export default function OrganizationMenu({
  options,
  selectedId,
  onSelect,
  testId = 'organization-menu',
  optionTestIdPrefix = 'organization-menu-option',
  ariaLabel = 'Organization',
  searchLabel = 'Search organizations',
  listLabel = 'Organizations',
  renderMark,
  disabled = false,
  id,
}: {
  options: OrganizationMenuOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  testId?: string;
  optionTestIdPrefix?: string;
  ariaLabel?: string;
  searchLabel?: string;
  listLabel?: string;
  renderMark?: (option: OrganizationMenuOption) => ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const selected = options.find((option) => option.id === selectedId) ?? null;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter((option) => option.name.toLowerCase().includes(needle))
    : options;
  const active = visible[Math.min(activeIndex, Math.max(visible.length - 1, 0))];

  const close = () => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  const choose = (id: string) => {
    close();
    onSelect(id);
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  if (!options.length) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-full items-center gap-2 rounded-lg border border-gray-700/80 bg-gray-800/90 px-2 py-1.5 text-left text-sm text-gray-100 shadow-sm transition-colors hover:border-gray-600 hover:bg-gray-800 disabled:opacity-50"
      >
        {selected && renderMark ? (
          renderMark(selected)
        ) : (
          <MenuMark independent={!!selected?.independent} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {selected?.name ?? 'Select organization'}
        </span>
        <ChevronDown
          size={14}
          className={`flex-shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-xl">
          <div className="border-b border-gray-800 p-1.5">
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-label={searchLabel}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
              placeholder={searchLabel}
              value={query}
              data-testid={`${testId}-search`}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((index) => Math.max(index - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (active) choose(active.id);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
                }
              }}
              className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder:text-gray-500 focus:border-gray-600 focus:outline-none"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={listLabel}
            className="max-h-64 overflow-y-auto py-1"
          >
            {visible.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-gray-500">No matches</p>
            )}
            {visible.map((option) => {
              const isSelected = option.id === selected?.id;
              const isActive = option.id === active?.id;
              return (
                <button
                  key={option.id}
                  id={`${listId}-${option.id}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`${optionTestIdPrefix}-${option.id}`}
                  onMouseEnter={() =>
                    setActiveIndex(visible.findIndex((item) => item.id === option.id))
                  }
                  onClick={() => choose(option.id)}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors ${
                    isActive || isSelected
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-300 hover:bg-gray-800/70 hover:text-white'
                  }`}
                >
                  {renderMark ? (
                    renderMark(option)
                  ) : (
                    <MenuMark independent={!!option.independent} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {isSelected && <Check size={14} className="flex-shrink-0 text-emerald-400" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuMark({ independent }: { independent: boolean }) {
  return (
    <span
      className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${
        independent ? 'bg-gray-700 text-gray-300' : 'bg-sky-500/15 text-sky-300'
      }`}
    >
      {independent ? <Folder size={13} /> : <Building2 size={13} />}
    </span>
  );
}
