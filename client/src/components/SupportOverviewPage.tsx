import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LifeBuoy, Folder, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { relativeTime } from '../utils/time';
import { createRequestGenerationState, beginRequest } from '@shared/utils/requestGeneration';
import {
  groupTicketsByProject,
  paginate,
  pageCount,
  clampPage,
  type SupportSeverity,
} from '@shared/utils/supportOverview';

/**
 * Cross-project support dashboard: every project's support issues on one page,
 * grouped into a section per project and paginated within each section so a
 * busy project can't run its list all the way down the page.
 *
 * Reads the existing overview endpoint (`GET /api/support-tickets`), which
 * already returns tickets enriched with `project_name` plus a count-ordered
 * `projects` option set — the section order. Status is filtered server-side;
 * the per-project grouping and pagination are client-side (pure helpers in
 * `@shared/utils/supportOverview`, unit-tested there).
 */

const SECTION_PAGE_SIZE = 6;
const REFRESH_MS = 15000;

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-gray-500',
};

const SEVERITY_ORDER: readonly SupportSeverity[] = ['critical', 'high', 'medium', 'low'];

// Status filter groups → the `status` query value (comma-separated list the
// overview route accepts). "Open" is the working queue; "All" drops the filter.
const STATUS_FILTERS: { key: string; label: string; status?: string }[] = [
  { key: 'open', label: 'Open', status: 'new,investigating' },
  { key: 'all', label: 'All' },
];

interface OverviewTicket {
  id: string;
  project_id: string;
  project_name?: string | null;
  severity?: string | null;
  status?: string | null;
  subject?: string | null;
  body?: string | null;
  created_at?: string | null;
}

interface OverviewData {
  tickets: OverviewTicket[];
  projects: { id: string; name: string; count: number }[];
}

interface SupportOverviewPageProps {
  onOpenProjectSupport?: (projectId: string, ticketId?: string | null) => void;
}

export default function SupportOverviewPage({ onOpenProjectSupport }: SupportOverviewPageProps) {
  const [data, setData] = useState<OverviewData>({ tickets: [], projects: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusKey, setStatusKey] = useState('open');

  const mountedRef = useRef(true);
  const genRef = useRef(createRequestGenerationState());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const statusValue = useMemo(
    () => STATUS_FILTERS.find((f) => f.key === statusKey)?.status,
    [statusKey],
  );

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const req = beginRequest(genRef.current, { silent });
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      let committed = false;
      try {
        const res = await api.getAllSupportTickets(statusValue ? { status: statusValue } : {});
        if (mountedRef.current && req.canCommit()) {
          req.commit();
          committed = true;
          setData({
            tickets: Array.isArray(res?.tickets) ? res.tickets : [],
            projects: Array.isArray(res?.projects) ? res.projects : [],
          });
          setError(null);
        }
      } catch (err: any) {
        if (!silent && mountedRef.current && req.canCommit()) {
          req.commit();
          committed = true;
          setError(err?.message || String(err));
        }
      } finally {
        if (mountedRef.current && (committed || req.ownsLoading())) setLoading(false);
      }
    },
    [statusValue],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Light auto-refresh so the board stays current without a manual reload.
  useEffect(() => {
    const id = setInterval(() => load({ silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const sections = useMemo(
    () => groupTicketsByProject(data.tickets, data.projects),
    [data.tickets, data.projects],
  );

  const totalTickets = data.tickets.length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
          <h1 className="text-lg font-semibold text-white flex items-center gap-2">
            <LifeBuoy size={18} className="text-blue-400" />
            Support issues
          </h1>
          <button
            onClick={() => load()}
            className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-gray-800/50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Support issues from every project in one place, grouped by project.
        </p>

        <div className="flex items-center gap-2 mb-5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusKey(f.key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                statusKey === f.key
                  ? 'bg-blue-500/20 text-blue-200 border-blue-500/40'
                  : 'text-gray-400 border-gray-700 hover:bg-gray-800/50 hover:text-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="text-[11px] text-gray-600 ml-auto">
            {totalTickets} issue{totalTickets === 1 ? '' : 's'} across {sections.length} project
            {sections.length === 1 ? '' : 's'}
          </span>
        </div>

        {error ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-8 text-center text-sm text-red-400">
            Failed to load support issues: {error}
          </div>
        ) : loading && totalTickets === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-8 text-center text-sm text-gray-600">
            Loading support issues…
          </div>
        ) : sections.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-8 text-center text-sm text-gray-600">
            No support issues in this view. Everything is triaged.
          </div>
        ) : (
          <div className="space-y-6">
            {sections.map((section) => (
              <ProjectSupportSection
                key={section.id}
                section={section}
                onOpenProjectSupport={onOpenProjectSupport}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectSupportSection({
  section,
  onOpenProjectSupport,
}: {
  section: ReturnType<typeof groupTicketsByProject>[number];
  onOpenProjectSupport?: (projectId: string, ticketId?: string | null) => void;
}) {
  const [page, setPage] = useState(1);
  const total = section.tickets.length;
  const pages = pageCount(total, SECTION_PAGE_SIZE);

  // A refresh can shrink a section below the current page — clamp so we never
  // strand the user on an empty page.
  useEffect(() => {
    setPage((p) => clampPage(p, total, SECTION_PAGE_SIZE));
  }, [total]);

  const visible = useMemo(
    () => paginate(section.tickets, page, SECTION_PAGE_SIZE),
    [section.tickets, page],
  );

  const start = (clampPage(page, total, SECTION_PAGE_SIZE) - 1) * SECTION_PAGE_SIZE;

  return (
    <section aria-label={`${section.name} support issues`}>
      <div className="flex items-center justify-between gap-3 mb-2 px-1">
        <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2 min-w-0">
          <Folder size={14} className="text-gray-500 flex-shrink-0" />
          <span className="truncate">{section.name}</span>
          <span className="text-[11px] font-normal text-gray-500 flex-shrink-0">
            {total} issue{total === 1 ? '' : 's'}
          </span>
        </h2>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {SEVERITY_ORDER.map((sev) =>
            section.severityCounts[sev] > 0 ? (
              <span
                key={sev}
                className="inline-flex items-center gap-1 text-[11px] text-gray-400"
                title={`${section.severityCounts[sev]} ${sev}`}
              >
                <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[sev]}`} aria-hidden />
                {section.severityCounts[sev]}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
        {visible.map((ticket) => (
          <SupportRow key={ticket.id} ticket={ticket} onOpenProjectSupport={onOpenProjectSupport} />
        ))}
      </div>

      {pages > 1 ? (
        <div className="flex items-center justify-between mt-2 px-1">
          <span className="text-[11px] text-gray-600">
            {start + 1}–{start + visible.length} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="p-1 rounded-lg text-gray-400 enabled:hover:bg-gray-800/50 enabled:hover:text-gray-200 disabled:opacity-40 transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-[11px] text-gray-500 tabular-nums">
              {clampPage(page, total, SECTION_PAGE_SIZE)} / {pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="p-1 rounded-lg text-gray-400 enabled:hover:bg-gray-800/50 enabled:hover:text-gray-200 disabled:opacity-40 transition-colors"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SupportRow({
  ticket,
  onOpenProjectSupport,
}: {
  ticket: OverviewTicket;
  onOpenProjectSupport?: (projectId: string, ticketId?: string | null) => void;
}) {
  const actionable = Boolean(ticket.project_id && onOpenProjectSupport);
  const title = ticket.subject?.trim() || ticket.body?.trim() || '(no subject)';
  const dot = SEVERITY_DOT[ticket.severity || 'low'] || SEVERITY_DOT.low;
  const inner = (
    <>
      <span
        className={`h-2 w-2 rounded-full flex-shrink-0 ${dot}`}
        title={`${ticket.severity || 'low'} severity`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{title}</div>
        <div className="text-[11px] text-gray-500 truncate">
          {ticket.status ? ticket.status : ''}
        </div>
      </div>
      <div className="text-[11px] text-gray-500 flex-shrink-0">
        {ticket.created_at ? relativeTime(ticket.created_at) : ''}
      </div>
    </>
  );

  if (!actionable) {
    return <div className="px-4 py-3 flex items-center gap-3">{inner}</div>;
  }
  return (
    <button
      onClick={() => onOpenProjectSupport!(ticket.project_id, ticket.id)}
      className="w-full text-left px-4 py-3 flex items-center gap-3 transition-colors hover:bg-gray-800/50 cursor-pointer"
    >
      {inner}
    </button>
  );
}
