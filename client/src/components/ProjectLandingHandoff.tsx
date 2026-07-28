import { Compass, ExternalLink, KanbanSquare, Sparkles } from 'lucide-react';

/**
 * ProjectLandingHandoff — the final screen of the New Project flow.
 *
 * Shown once provisioning completes. Gives the user a single readable
 * "you just created this" screen with:
 *
 *   • Header summary   — project name + repo link
 *   • Summary chips    — app type, stack, integrations
 *   • Next steps       — starter CTAs (open kanban, browse skills, etc.)
 *
 * The component is deliberately **presentational** — all outbound routing
 * funnels through two optional callbacks:
 *
 *   - onOpenProject({ projectId, repoUrl? })     — "Open project"
 *   - onOpenStarterTask({ projectId, task })     — "Open kanban" etc.
 *
 * Both are fired through the same upstream `onProjectCreated` handler in
 * NewProjectAdaptiveFlow — callers decide how to route.
 *
 * Empty handoff: `repoUrl` empty (github skipped) → the repo row renders a
 * "local only" note and the rest of the summary still renders.
 */
export default function ProjectLandingHandoff({
  projectId,
  projectName,
  repoUrl,
  payload,
  onOpenProject,
  onOpenStarterTask,
  onClose,
}: any) {
  const integrations = normalizeIntegrations(payload?.integrations);
  const stackChips = summarizeStack(payload);
  const appTypeLabel = payload?.appType && humanizeAppType(payload.appType);

  return (
    <div
      className="flex flex-col w-full h-full bg-gray-950 text-white"
      data-testid="project-landing"
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
          />

          <NextStepsPanel
            onOpenProject={() => onOpenProject?.({ projectId, repoUrl })}
            onOpenStarterTask={(task: any) => onOpenStarterTask?.({ projectId, task })}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function SummarySection({ repoUrl, appTypeLabel, stackChips, integrations }: any) {
  return (
    <section
      aria-label="Project summary"
      data-testid="pl-summary"
      className="rounded-lg border border-gray-800 bg-gray-900/60"
    >
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <Compass size={14} className="text-gray-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Summary</h2>
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

function SummaryRow({ label, children }: any) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <dt className="w-24 shrink-0 text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px]">{children}</dd>
    </div>
  );
}

function ChipList({ chips, testId }: any) {
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {chips.map((c: any) => (
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
/* Next steps                                                          */
/* ------------------------------------------------------------------ */

function NextStepsPanel({ onOpenProject, onOpenStarterTask }: any) {
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
        <NextStepButton
          primary
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

function NextStepButton({ icon, title, description, onClick, primary, testId }: any) {
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

/** Normalize the questionnaire's `integrations` into a list of display chips. */
export function normalizeIntegrations(integrations: any) {
  if (!integrations || integrations === 'idk') return [];
  if (!Array.isArray(integrations)) return [];
  return integrations.map((id: any) => humanizeIntegration(id));
}

function humanizeIntegration(id: any) {
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

function humanizeAppType(t: any) {
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
export function summarizeStack(payload: any) {
  if (!payload) return [];
  const s = payload.stack;
  if (!s || s === 'idk') return [];
  if (Array.isArray(s)) return s.filter(Boolean).map(String);
  if (typeof s === 'string') return [s];
  if (typeof s === 'object') {
    return Object.values(s)
      .filter((v: any) => v && v !== 'idk')
      .map(String);
  }
  return [];
}

function displayRepo(url: any) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}
