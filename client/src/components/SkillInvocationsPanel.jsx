import { memo } from 'react';
import { Sparkles, CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import { relativeTime } from '../utils/time.js';
import { formatInjectedBytes } from '../utils/formatBytes.js';

function statusMeta(status) {
  switch (status) {
    case 'loaded':
      return {
        label: 'Loaded',
        icon: CheckCircle,
        className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
      };
    case 'not-found':
      return {
        label: 'Not found',
        icon: AlertCircle,
        className: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
      };
    default:
      return {
        label: 'Malformed',
        icon: XCircle,
        className: 'bg-red-500/10 text-red-300 border-red-500/30',
      };
  }
}

function SkillInvocationsPanel({ invocations }) {
  const rows = Array.isArray(invocations)
    ? invocations
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    : [];

  return (
    <section className="mt-2 mb-3 border border-gray-700/50 rounded-xl bg-gray-850 overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-800/50 border-b border-gray-700/40 flex items-center gap-2">
        <Sparkles size={16} className="text-sky-300" />
        <h3 className="text-sm font-medium text-gray-200">Skill Invocations</h3>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-3 text-xs text-gray-500">No skills loaded in this session yet.</p>
      ) : (
        <ul aria-live="polite" className="divide-y divide-gray-700/30">
          {rows.map((row) => {
            const meta = statusMeta(row.status);
            const Icon = meta.icon;
            const source =
              row.source === 'project' ? 'project' : row.source === 'default' ? 'default' : null;
            const bytes = formatInjectedBytes(row.injected_bytes);
            return (
              <li key={row.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-sm font-semibold text-gray-100 truncate"
                    title={row.reason || undefined}
                  >
                    {row.skill_id}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${meta.className}`}
                    data-testid={`skill-status-${row.status}`}
                  >
                    <Icon size={12} />
                    {meta.label}
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                  {source && (
                    <span className="px-1.5 py-0.5 rounded border border-gray-600/60 bg-gray-800/50 text-gray-300">
                      {source}
                    </span>
                  )}
                  {bytes && <span>{bytes}</span>}
                  <span>{relativeTime(row.created_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default memo(SkillInvocationsPanel);
