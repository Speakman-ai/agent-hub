import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createUseOrganizationPortfolio } from '@shared/hooks/useOrganizationPortfolio';
import {
  DISPATCH_STATE_LABELS,
  dispatchDetail,
  dispatchDisplayState,
  dispatchSourceAgents,
  dispatchTargetProjects,
  type DispatchDisplayState,
  type OrganizationDispatch,
  type PortfolioProject,
} from '@shared/utils/organization-portfolio';
import type { Organization } from '@shared/utils/organizations';
import type { HubChatResolvedRef } from '@shared/utils/hubChatRefs';
import { api } from '../utils/api';
import { HubChatPlainTextWithRefs, HubChatRefOpenContext } from './HubChatRefs';
import type { OrganizationChatTarget } from './OrganizationAgentsPanel';

const useOrganizationPortfolio = createUseOrganizationPortfolio({
  useEffect,
  useMemo,
  useSyncExternalStore,
});
const button =
  'rounded-lg border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'rounded-lg border border-gray-700 bg-gray-900 p-2 text-sm';
const tone: Record<DispatchDisplayState, string> = {
  pending: 'bg-yellow-500/20 text-yellow-200',
  running: 'bg-cyan-500/20 text-cyan-200',
  completed: 'bg-emerald-500/20 text-emerald-200',
  failed: 'bg-red-500/20 text-red-200',
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

type Props = {
  organization: Organization;
  scope: () => string;
  refreshKey?: unknown;
  /** Drill into a linked project with the existing project views. */
  onOpenProject?: (projectId: string) => void;
  /** Open a dispatched target session in the normal chat view. */
  onOpenSession?: (agentId: string, sessionId: string) => void;
  onOpenChat?: (target: OrganizationChatTarget) => void;
};

export default function OrganizationPortfolioPanel({
  organization,
  scope,
  refreshKey,
  onOpenProject,
  onOpenSession,
  onOpenChat,
}: Props) {
  const { state, controller } = useOrganizationPortfolio(
    api.organizationPortfolio,
    api.organizationAgents,
    scope,
    organization.id,
    refreshKey,
  );
  const openRef = (ref: HubChatResolvedRef) => {
    if (ref.kind === 'session' && ref.agentId) onOpenSession?.(ref.agentId, ref.targetId);
  };
  return (
    <HubChatRefOpenContext.Provider value={openRef}>
      <section className="space-y-3" aria-label="Organization portfolio">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">Portfolio</h4>
          <button className={button} disabled={state.busy} onClick={() => void controller.load()}>
            Refresh portfolio
          </button>
        </div>
        {state.error && (
          <div role="alert" className="text-red-300">
            {state.error}
          </div>
        )}
        {state.busy && <p role="status">Loading portfolio…</p>}
        {state.ready && (
          <>
            <p className="text-xs text-gray-400">
              Projects you can access in {organization.name}. Retrieved {time(state.retrievedAt)}.
            </p>
            {!state.projects.length && (
              <p>No linked projects you can access. Linking never grants project access.</p>
            )}
            <ul className="grid gap-2 md:grid-cols-2">
              {state.projects.map((p) => (
                <ProjectCard key={p.id} project={p} onOpenProject={onOpenProject} />
              ))}
            </ul>
            {state.nextOffset !== null && (
              <button className={button} onClick={() => void controller.loadMore()}>
                Load more projects
              </button>
            )}
            <DispatchForm state={state} controller={controller} />
            <DispatchList
              dispatches={state.dispatches}
              projects={state.projects}
              onOpenSession={onOpenSession}
              onOpenChat={(d) =>
                onOpenChat?.({
                  organizationId: organization.id,
                  organizationName: organization.name,
                  agentId: d.organizationAgentId,
                  sessionId: d.initiatingSessionId,
                  agent: state.agents.find((a) => a.id === d.organizationAgentId) ?? null,
                })
              }
            />
          </>
        )}
      </section>
    </HubChatRefOpenContext.Provider>
  );
}

function ProjectCard({
  project,
  onOpenProject,
}: {
  project: PortfolioProject;
  onOpenProject?: (projectId: string) => void;
}) {
  return (
    <li className="rounded-lg border border-gray-800 p-3 space-y-1" aria-label={project.name}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{project.name}</span>
        {onOpenProject && (
          <button className={button} onClick={() => onOpenProject(project.id)}>
            Open {project.name}
          </button>
        )}
      </div>
      <p className="text-sm text-gray-300">
        {project.board.openCards} open of {project.board.totalCards} cards · {project.board.epics}{' '}
        epics · {project.wiki.pages} wiki pages · {project.sessions.own} of your sessions
      </p>
      <p className="text-sm text-gray-400">
        Agents: {project.agents.map((a) => a.name).join(', ') || 'none'}
        {project.agentsTruncated ? ` (+${project.agentCount - project.agents.length})` : ''}
      </p>
      <p className="text-xs text-gray-500">
        Source: {project.source.projectName} · {project.source.record} · updated{' '}
        {time(project.timestamp)}
      </p>
    </li>
  );
}

type PortfolioHook = ReturnType<typeof useOrganizationPortfolio>;
function DispatchForm({ state, controller }: PortfolioHook) {
  const sources = dispatchSourceAgents(state.agents);
  // The draft lives in the controller, so a reload (which remounts this form) keeps it and an
  // accepted dispatch clears the task the user sees.
  const { sourceId, projectId, agentId, prompt } = state.draft;
  const setSourceId = (value: string) => controller.setDraft({ sourceId: value });
  const setProjectId = (value: string) => controller.setDraft({ projectId: value });
  const setAgentId = (value: string) => controller.setDraft({ agentId: value });
  const setPrompt = (value: string) => controller.setDraft({ prompt: value });
  const source = sources.find((a) => a.id === sourceId) ?? sources[0] ?? null;
  const projects = dispatchTargetProjects(state.projects, source);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const targets = project?.agents ?? [];
  const ready = Boolean(
    source && project && targets.some((a) => a.id === agentId) && prompt.trim(),
  );
  if (!sources.length)
    return (
      <p className="text-sm text-gray-400">
        No organization agent can dispatch project agents. Ask an organization Owner or Admin to
        enable “Dispatch project agents” on one.
      </p>
    );
  return (
    <form
      className="space-y-2 rounded-lg border border-gray-800 p-3"
      aria-label="Dispatch a project agent"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || !source) return;
        // Pin the defaulted source so a roster refresh cannot change a retry's intent (and key).
        setSourceId(source.id);
        void controller.dispatch(source.id, { projectId, agentId, prompt });
      }}
    >
      <h5 className="font-medium">Dispatch a project agent</h5>
      <div className="grid gap-2 sm:grid-cols-3">
        <select
          className={`${input} w-full`}
          aria-label="Organization agent"
          value={source?.id ?? ''}
          onChange={(event) => {
            setSourceId(event.target.value);
            setProjectId('');
            setAgentId('');
          }}
        >
          {sources.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className={`${input} w-full`}
          aria-label="Target project"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            setAgentId('');
          }}
        >
          <option value="">Choose a project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className={`${input} w-full`}
          aria-label="Target agent"
          value={agentId}
          disabled={!project}
          onChange={(event) => setAgentId(event.target.value)}
        >
          <option value="">Choose an agent</option>
          {targets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {source && !projects.length && (
        <p className="text-sm text-gray-400">{source.name} has no linked projects in scope.</p>
      )}
      <textarea
        className={`${input} w-full`}
        aria-label="Task for the project agent"
        placeholder="What should the project agent do?"
        rows={3}
        maxLength={50000}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {state.dispatchError && (
        <p role="alert" className="text-sm text-red-300">
          {state.dispatchError}
        </p>
      )}
      <button className={button} disabled={!ready || state.dispatching}>
        {state.dispatching ? 'Dispatching…' : 'Dispatch'}
      </button>
    </form>
  );
}

function DispatchList({
  dispatches,
  projects,
  onOpenSession,
  onOpenChat,
}: {
  dispatches: OrganizationDispatch[];
  projects: PortfolioProject[];
  onOpenSession?: (agentId: string, sessionId: string) => void;
  onOpenChat: (dispatch: OrganizationDispatch) => void;
}) {
  return (
    <div className="space-y-2">
      <h5 className="font-medium">Dispatched work</h5>
      {!dispatches.length && <p className="text-sm text-gray-400">Nothing dispatched yet.</p>}
      <ul className="space-y-2">
        {dispatches.map((d) => {
          const state = dispatchDisplayState(d);
          const project = projects.find((p) => p.id === d.projectId);
          const agent = project?.agents.find((a) => a.id === d.agentId);
          const detail = dispatchDetail(d);
          return (
            <li
              key={d.requestId}
              className="rounded-lg border border-gray-800 p-3 space-y-1"
              aria-label={`Dispatch ${d.name}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs ${tone[state]}`}>
                  {DISPATCH_STATE_LABELS[state]}
                </span>
                <span className="font-medium">{d.name}</span>
                <span className="text-sm text-gray-400">
                  {project?.name ?? d.projectId} · {agent?.name ?? d.agentId}
                </span>
              </div>
              {detail && <p className="text-sm text-gray-300">{detail}</p>}
              {d.ref && (
                <p className="text-sm">
                  <HubChatPlainTextWithRefs text={d.ref} />
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {d.sessionId && onOpenSession && (
                  <button className={button} onClick={() => onOpenSession(d.agentId, d.sessionId!)}>
                    Open target session
                  </button>
                )}
                <button className={button} onClick={() => onOpenChat(d)}>
                  Open organization chat
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
