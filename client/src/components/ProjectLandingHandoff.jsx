import { useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  ExternalLink,
  KanbanSquare,
  MessageSquare,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import { scoreBand } from '../utils/auditReport.js';

/**
 * ProjectLandingHandoff — Act V of the New Project storyboard.
 *
 * Shown after the user confirms the Act IV roster. Gives them a single
 * readable "you just created this" screen with:
 *
 *   • Header summary   — project name + repo link
 *   • Summary chips    — app type, stack, integrations, audit band
 *   • Audit highlights — top findings (up to 3) or a "clean" callout
 *   • Roster panel     — per-track assigned agent with a "Chat" action
 *   • Next steps       — starter CTAs (open kanban, browse skills, etc.)
 *
 * The component is deliberately **presentational** — all outbound routing
 * funnels through two optional callbacks:
 *
 *   - onOpenProject({ projectId, repoUrl? })            — "Open project"
 *   - onStartChat({ projectId, agentId, trackId? })     — "Chat with X"
 *   - onOpenStarterTask({ projectId, task })            — "Open kanban" etc.
 *
 * All three are fired through the same upstream `onProjectCreated`
 * handler in NewProjectAdaptiveFlow — callers decide how to route.
 *
 * Empty / error handoffs:
 *   - `report === null` (audit load failed) → renders a neutral "audit
 *     unavailable" strip but still renders the roster + next steps.
 *   - `repoUrl` empty (github skipped) → repo row is hidden but the rest
 *     of the summary still renders.
 *   - `roster` empty → roster panel collapses to a muted "no agents
 *     assigned yet" message; next steps remain clickable.
 */
export default function ProjectLandingHandoff({
  projectId,
  projectName,
  repoUrl,
  payload,
  report,
  roster = [],
  agents = [],
  onOpenProject,
  onStartChat,
  onOpenStarterTask,
  onClose,
}) {
  const band = report ? scoreBand(report.score) : 'unknown';
  const topFindings = useMemo(() => pickTopFindings(report?.findings || []), [report]);
  const assignedRoster = useMemo(() => roster.filter((r) => r && r.agentId), [roster]);
  const agentById = useMemo(() => {
    const map = new Map();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  const integrations = normalizeIntegrations(payload?.integrations);
  const stackChips = summarizeStack(payload);
  const appTypeLabel = payload?.appType && humanizeAppType(payload.appType);

  return (
    <div
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="project-landing"
      data-audit-band={band}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900/90 px-4 py-3">
        <Sparkles size={16} className="text-emerald-400 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-gray-500">Project ready</div>
          <div className="truncate text-sm font-semibold text-white">
            {projectName || projectId || 'New project'}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-gray-200"
            data-testid="pl-close"
          >
            Close
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <SummarySection
            repoUrl={repoUrl}
            appTypeLabel={appTypeLabel}
            stackChips={stackChips}
            integrations={integrations}
            band={band}
            score={report?.score ?? null}
          />

          <AuditHighlights band={band} findings={topFindings} hasReport={!!report} />

          <RosterPanel
            roster={roster}
            agentById={agentById}
            onStartChat={(row) =>
              onStartChat?.({ projectId, agentId: row.agentId, trackId: row.trackId })
            }
          />

          <NextStepsPanel
            assignedRoster={assignedRoster}
            agentById={agentById}
            onOpenProject={() => onOpenProject?.({ projectId, repoUrl })}
            onStartChat={(row) =>
              onStartChat?.({ projectId, agentId: row.agentId, trackId: row.trackId })
            }
            onOpenStarterTask={(task) => onOpenStarterTask?.({ projectId, task })}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function SummarySection({ repoUrl, appTypeLabel, stackChips, integrations, band, score }) {
  return (
    <section
      aria-label="Project summary"
      data-testid="pl-summary"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <Compass size={14} className="text-gray-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Summary</h2>
        <span
          className={`ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneForBand(band)}`}
          data-testid="pl-summary-band"
        >
          {bandLabel(band)}
          {score != null && <span className="text-gray-400">· {score}/100</span>}
        </span>
      </header>
      <dl className="divide-y divide-gray-800 text-sm">
        {repoUrl ? (
          <SummaryRow label="Repo">
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 break-all"
              data-testid="pl-repo-link"
            >
              {displayRepo(repoUrl)}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </SummaryRow>
        ) : (
          <SummaryRow label="Repo">
            <span className="text-gray-500" data-testid="pl-repo-none">
              Local only — no remote created
            </span>
          </SummaryRow>
        )}
        {appTypeLabel && (
          <SummaryRow label="Type">
            <span className="text-gray-100" data-testid="pl-apptype">
              {appTypeLabel}
            </span>
          </SummaryRow>
        )}
        {stackChips.length > 0 && (
          <SummaryRow label="Stack">
            <ChipList chips={stackChips} testId="pl-stack" />
          </SummaryRow>
        )}
        <SummaryRow label="Integrations">
          {integrations.length > 0 ? (
            <ChipList chips={integrations} testId="pl-integrations" />
          ) : (
            <span className="text-gray-500" data-testid="pl-integrations-none">
              None selected
            </span>
          )}
        </SummaryRow>
      </dl>
    </section>
  );
}

function SummaryRow({ label, children }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px]">{children}</dd>
    </div>
  );
}

function ChipList({ chips, testId }) {
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {chips.map((c) => (
        <li
          key={c}
          className="rounded-full border border-gray-700 bg-gray-950 px-2 py-0.5 text-[11px] text-gray-200"
        >
          {c}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Audit highlights                                                    */
/* ------------------------------------------------------------------ */

function AuditHighlights({ band, findings, hasReport }) {
  if (!hasReport) {
    return (
      <section
        aria-label="Audit highlights"
        data-testid="pl-audit-unavailable"
        className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-400"
      >
        Audit report is not available — you can still proceed; the team will run it when the first
        session starts.
      </section>
    );
  }

  if (findings.length === 0) {
    return (
      <section
        aria-label="Audit highlights"
        data-testid="pl-audit-clean"
        className={`rounded-lg border px-4 py-3 text-sm ${
          band === 'green'
            ? 'border-emerald-700 bg-emerald-950/30 text-emerald-200'
            : 'border-gray-800 bg-gray-900/40 text-gray-300'
        }`}
      >
        <div className="flex items-start gap-2">
          <CheckCircle2 size={14} className="mt-0.5 text-emerald-400" aria-hidden="true" />
          <div>No blocking findings. You can start working right away.</div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Audit highlights"
      data-testid="pl-audit-highlights"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <AlertTriangle size={14} className="text-amber-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Audit highlights</h2>
        <span className="ml-auto text-xs text-gray-500">
          Top {findings.length} of {findings.length === 1 ? 'finding' : 'findings'}
        </span>
      </header>
      <ul className="divide-y divide-gray-800">
        {findings.map((f) => (
          <li
            key={f.id}
            className="flex items-start gap-2 px-4 py-2.5 text-[13px]"
            data-testid={`pl-finding-${f.id}`}
            data-severity={f.severity}
          >
            <SeverityIcon severity={f.severity} />
            <div className="min-w-0 flex-1">
              <div className="text-gray-200 break-words">{f.message}</div>
              {f.hint && (
                <div className="text-xs text-gray-500">
                  <span className="font-medium">Hint:</span> {f.hint}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SeverityIcon({ severity }) {
  const common = 'shrink-0 mt-0.5';
  if (severity === 'error')
    return <XCircle size={14} className={`${common} text-red-400`} aria-label="error" />;
  if (severity === 'warn')
    return <AlertTriangle size={14} className={`${common} text-amber-400`} aria-label="warn" />;
  return <CheckCircle2 size={14} className={`${common} text-gray-500`} aria-label="info" />;
}

/* ------------------------------------------------------------------ */
/* Roster                                                              */
/* ------------------------------------------------------------------ */

function RosterPanel({ roster, agentById, onStartChat }) {
  return (
    <section
      aria-label="Assigned agents"
      data-testid="pl-roster"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <Users size={14} className="text-gray-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Your team</h2>
        <span className="ml-auto text-xs text-gray-500">
          {roster.length} {roster.length === 1 ? 'track' : 'tracks'}
        </span>
      </header>
      {roster.length === 0 ? (
        <div className="px-4 py-5 text-sm text-gray-500" data-testid="pl-roster-empty">
          No agents assigned yet — you can add a roster from the project settings.
        </div>
      ) : (
        <ul className="divide-y divide-gray-800">
          {roster.map((row) => {
            const agent = row.agentId ? agentById.get(row.agentId) : null;
            const hasAgent = !!agent;
            return (
              <li
                key={row.trackId || row.id}
                className="flex items-center gap-3 px-4 py-2.5 text-sm"
                data-testid={`pl-roster-row-${row.trackId || row.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-gray-100 font-medium truncate">{row.label}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {hasAgent ? agent.name || agent.id : 'Unassigned'}
                  </div>
                </div>
                {hasAgent ? (
                  <button
                    type="button"
                    onClick={() => onStartChat(row)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-100 hover:bg-gray-800"
                    data-testid={`pl-chat-${row.trackId || row.id}`}
                  >
                    <MessageSquare size={12} aria-hidden="true" /> Chat
                  </button>
                ) : (
                  <span
                    className="text-[11px] uppercase tracking-wide text-gray-500"
                    data-testid={`pl-roster-row-${row.trackId || row.id}-empty`}
                  >
                    unassigned
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Next steps                                                          */
/* ------------------------------------------------------------------ */

function NextStepsPanel({
  assignedRoster,
  agentById,
  onOpenProject,
  onStartChat,
  onOpenStarterTask,
}) {
  const leadRow = pickLead(assignedRoster);
  const leadAgent = leadRow ? agentById.get(leadRow.agentId) : null;

  return (
    <section
      aria-label="Next steps"
      data-testid="pl-next-steps"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <Sparkles size={14} className="text-emerald-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Next steps</h2>
      </header>
      <div className="flex flex-col gap-2 p-4">
        {leadRow && leadAgent && (
          <NextStepButton
            primary
            testId="pl-next-chat-lead"
            icon={<MessageSquare size={14} aria-hidden="true" />}
            title={`Brief ${leadAgent.name || leadAgent.id}`}
            description={`Start a chat with your ${leadRow.label.toLowerCase()} and describe the first task.`}
            onClick={() => onStartChat(leadRow)}
          />
        )}
        <NextStepButton
          testId="pl-next-kanban"
          icon={<KanbanSquare size={14} aria-hidden="true" />}
          title="Open the kanban board"
          description="Write acceptance criteria for your first ticket and let the team pick it up."
          onClick={() => onOpenStarterTask({ type: 'kanban' })}
        />
        <NextStepButton
          testId="pl-next-skills"
          icon={<Sparkles size={14} aria-hidden="true" />}
          title="Browse agent skills"
          description="See what each agent can do out of the box — deploys, tests, docs."
          onClick={() => onOpenStarterTask({ type: 'skills' })}
        />
        <NextStepButton
          testId="pl-next-open"
          icon={<Compass size={14} aria-hidden="true" />}
          title="Open the project home"
          description="Jump straight into the project without starting a chat yet."
          onClick={onOpenProject}
        />
      </div>
    </section>
  );
}

function NextStepButton({ icon, title, description, onClick, primary, testId }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group w-full rounded-md border px-3 py-2.5 text-left transition-colors ${
        primary
          ? 'border-emerald-700 bg-emerald-950/40 hover:bg-emerald-950/60'
          : 'border-gray-800 bg-gray-950/40 hover:bg-gray-900'
      }`}
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        <span className={primary ? 'text-emerald-300' : 'text-gray-400'}>{icon}</span>
        {title}
      </div>
      <div className="mt-0.5 pl-6 text-xs text-gray-400">{description}</div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** Pick the top ~3 audit findings, preferring error > warn > info. Exported
 *  for testing. */
export function pickTopFindings(findings, max = 3) {
  const order = { error: 0, warn: 1, info: 2 };
  return [...findings]
    .sort((a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99))
    .slice(0, max);
}

/** Normalize the questionnaire's `integrations` into a list of display chips. */
export function normalizeIntegrations(integrations) {
  if (!integrations || integrations === 'idk') return [];
  if (!Array.isArray(integrations)) return [];
  return integrations.map((id) => humanizeIntegration(id));
}

function humanizeIntegration(id) {
  switch (id) {
    case 'github':
      return 'GitHub';
    case 'aws':
      return 'AWS';
    case 'auth':
      return 'Auth';
    case 'db':
      return 'Database';
    case 'kanban':
      return 'Kanban';
    case 'slack':
      return 'Slack';
    case 'stripe':
      return 'Payments';
    case 'analytics':
      return 'Analytics';
    default:
      return id;
  }
}

function humanizeAppType(t) {
  switch (t) {
    case 'web-app':
      return 'Web app';
    case 'api':
      return 'API / Backend';
    case 'cli':
      return 'CLI tool';
    case 'mobile':
      return 'Mobile app';
    case 'desktop':
      return 'Desktop app';
    case 'ml':
      return 'ML / Data pipeline';
    case 'library':
      return 'Library / SDK';
    default:
      return t;
  }
}

/** Extract stack chips from a questionnaire payload. The stack field can
 *  be a string (idk sentinel), an object { frontend, backend, … }, or an
 *  array — we render whatever we can find. */
export function summarizeStack(payload) {
  if (!payload) return [];
  const s = payload.stack;
  if (!s || s === 'idk') return [];
  if (Array.isArray(s)) return s.filter(Boolean).map(String);
  if (typeof s === 'string') return [s];
  if (typeof s === 'object') {
    return Object.values(s)
      .filter((v) => v && v !== 'idk')
      .map(String);
  }
  return [];
}

function pickLead(roster) {
  if (!roster.length) return null;
  const preferred = ['architect', 'lead', 'frontend', 'backend'];
  for (const p of preferred) {
    const hit = roster.find((r) => r.trackId === p);
    if (hit) return hit;
  }
  return roster[0];
}

function toneForBand(band) {
  switch (band) {
    case 'green':
      return 'border-emerald-700 bg-emerald-950/40 text-emerald-200';
    case 'amber':
      return 'border-amber-700 bg-amber-950/40 text-amber-200';
    case 'red':
      return 'border-red-700 bg-red-950/40 text-red-200';
    default:
      return 'border-gray-700 bg-gray-900/60 text-gray-300';
  }
}

function bandLabel(band) {
  switch (band) {
    case 'green':
      return 'Ready';
    case 'amber':
      return 'Needs work';
    case 'red':
      return 'Not ready';
    default:
      return 'Audit pending';
  }
}

function displayRepo(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}
