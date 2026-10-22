import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ServerAgentSkillRef } from '@shared/utils/hub';
import type { ServerAgentSettings } from '@shared/utils/serverAgentSettingsStore';
import {
  addSkillRef,
  addableSkillGroups,
  describeSkillRef,
  removeSkillRef,
  type ServerAgentSkillOptions,
} from '@shared/utils/serverAgentSkills';
import { api } from '../utils/api';
import { saveServerAgentSettings } from '../utils/serverAgentSettings';

/**
 * Skills the user adds to their Server Agent: any global or bundled skill, or
 * a skill from a project they can access. Each add or remove saves at once.
 */
export function ServerAgentSkillsSection({
  accountKey,
  settings,
  enabled,
}: {
  accountKey: string;
  settings: ServerAgentSettings | null;
  enabled: boolean;
}) {
  const [options, setOptions] = useState<ServerAgentSkillOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOptions(null);
    setOptionsError(null);
    Promise.resolve()
      .then(() => api.getServerAgentSkillOptions())
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOptionsError(err instanceof Error ? err.message : 'Could not load skills.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

  const added = settings?.skills ?? [];
  const builtIn = settings?.builtInSkills ?? options?.builtIn ?? [];
  const groups = addableSkillGroups(options, added, query);

  const save = async (next: ServerAgentSkillRef[]) => {
    setSaving(true);
    setError(null);
    try {
      await saveServerAgentSettings(accountKey, { skills: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save skills.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="block" data-testid="server-agent-skills">
      <span className="text-sm font-medium text-gray-200">Skills</span>
      <span className="mt-1 block text-xs text-gray-500">
        Always loaded: {builtIn.length ? builtIn.join(', ') : 'the Agent Hub skills'}. Add any
        global skill, or a skill from a project you can access. The agent lists added skills and
        loads them when it needs them.
      </span>

      {added.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="server-agent-skills-added">
          {added.map((ref) => {
            const label = describeSkillRef(ref, options);
            return (
              <li
                key={`${ref.projectId ?? ''}/${ref.id}`}
                data-testid={`server-agent-skill-${ref.id}`}
                className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-white">{label.name}</span>
                <span className="shrink-0 text-xs text-gray-500">{label.scope}</span>
                <button
                  type="button"
                  onClick={() => void save(removeSkillRef(added, ref))}
                  disabled={!enabled || saving}
                  aria-label={`Remove ${label.name}`}
                  data-testid={`server-agent-skill-remove-${ref.id}`}
                  className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-white disabled:opacity-50"
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!picking ? (
        <button
          type="button"
          onClick={() => setPicking(true)}
          disabled={!enabled || saving}
          data-testid="server-agent-skills-add"
          className="mt-2 inline-flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} /> Add skill
        </button>
      ) : (
        <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900">
          <div className="flex items-center gap-2 border-b border-gray-800 p-2">
            <input
              type="text"
              value={query}
              autoFocus
              placeholder="Search skills"
              onChange={(e) => setQuery(e.target.value)}
              data-testid="server-agent-skills-search"
              className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white placeholder-gray-500 focus:border-cyan-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                setPicking(false);
                setQuery('');
              }}
              aria-label="Close skill picker"
              className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {optionsError && (
              <div className="px-2 py-1.5 text-xs text-red-400">
                Could not load skills: {optionsError}
              </div>
            )}
            {!optionsError && !options && (
              <div className="px-2 py-1.5 text-xs text-gray-500">Loading skills…</div>
            )}
            {options && groups.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-gray-500">No more skills to add.</div>
            )}
            {groups.map((group) => (
              <div key={group.key} className="py-1">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  {group.label}
                </div>
                {group.items.map(({ ref, option }) => (
                  <button
                    key={`${group.key}/${option.id}`}
                    type="button"
                    disabled={saving}
                    onClick={() => void save(addSkillRef(added, ref))}
                    data-testid={`server-agent-skills-option-${group.key}-${option.id}`}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-gray-800 disabled:opacity-50"
                  >
                    <div className="truncate text-sm text-white">{option.name}</div>
                    {option.description && (
                      <div className="truncate text-xs text-gray-500">{option.description}</div>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <span role="alert" className="mt-1 block text-xs text-red-400">
          {error}
        </span>
      )}
    </section>
  );
}
