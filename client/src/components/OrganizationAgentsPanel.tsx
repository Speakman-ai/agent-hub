import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createUseOrganizationAgents } from '@shared/hooks/useOrganizationAgents';
import {
  ORGANIZATION_AGENT_TOOLS,
  ORGANIZATION_TOOL_LABELS,
  draftFromAgent,
  newAgentDraft,
  organizationAgentComputerLabel,
  organizationAgentStatus,
  patchFromDraft,
  rosterAgents,
  toggleValue,
  type OrganizationAgent,
  type OrganizationAgentDraft,
  type OrganizationAgentsController,
  type OrganizationAgentTemplate,
  type OrganizationChatTarget,
} from '@shared/utils/organization-agents';
import type { Organization, OrganizationProject } from '@shared/utils/organizations';
import { api } from '../utils/api';

const useOrganizationAgents = createUseOrganizationAgents({
  useEffect,
  useMemo,
  useSyncExternalStore,
});
const button =
  'rounded-lg border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'rounded-lg border border-gray-700 bg-gray-900 p-2 text-sm';

export type { OrganizationChatTarget };
type Props = {
  organization: Organization;
  linkedProjects: OrganizationProject[];
  scope: () => string;
  refreshKey?: unknown;
  onOpenChat?: (target: OrganizationChatTarget) => void;
};
type Editing = { agent: OrganizationAgent | null; draft: OrganizationAgentDraft } | null;

function useModels() {
  const [models, setModels] = useState<{ list: string[]; fallback: string }>({
    list: [],
    fallback: '',
  });
  useEffect(() => {
    let live = true;
    api
      .getModelConfig()
      .then((config: any) => {
        if (!live) return;
        setModels({
          list: config?.engineValidModels?.['claude-code'] ?? [],
          fallback: config?.engineDefaultModels?.['claude-code'] ?? '',
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return models;
}

export default function OrganizationAgentsPanel({
  organization,
  linkedProjects,
  scope,
  refreshKey,
  onOpenChat,
}: Props) {
  const { state, controller } = useOrganizationAgents(
    api.organizationAgents,
    scope,
    organization.id,
    refreshKey,
  );
  const models = useModels();
  const [editing, setEditing] = useState<Editing>(null);
  const [choosing, setChoosing] = useState(false);
  const roster = rosterAgents(state.agents);
  const archived = state.agents.filter((a) => organizationAgentStatus(a) === 'archived');
  const canManage = organization.canManage;

  const openChat = async (agent: OrganizationAgent) => {
    const result = await controller.startChat(agent.id);
    if (result?.session?.id)
      onOpenChat?.({
        organizationId: organization.id,
        organizationName: organization.name,
        agentId: result.agent?.id ?? agent.id,
        sessionId: result.session.id,
        agent: result.agent ?? agent,
        session: result.session,
      });
  };

  return (
    <div className="space-y-3" aria-label="Organization agents">
      <h4 className="font-medium">Agents</h4>
      {state.error && (
        <div role="alert" className="text-red-300">
          {state.error}
        </div>
      )}
      {state.busy && !state.ready && <p role="status">Loading agents…</p>}
      {state.ready && !roster.length && (
        <p>
          No active agents.{' '}
          {canManage
            ? 'Add an agent to chat in this organization.'
            : 'Ask an organization Owner or Admin to add one.'}
        </p>
      )}
      {roster.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          canManage={canManage}
          busy={state.busy}
          templates={state.templates}
          onChat={() => void openChat(agent)}
          onEdit={() => {
            setChoosing(false);
            setEditing({ agent, draft: draftFromAgent(agent) });
          }}
        />
      ))}
      {canManage && !editing && !choosing && (
        <button className={button} onClick={() => setChoosing(true)}>
          Add agent
        </button>
      )}
      {canManage && choosing && (
        <TemplateChooser
          templates={state.templates}
          onChoose={(template) => {
            setChoosing(false);
            setEditing({ agent: null, draft: newAgentDraft(template, models.fallback) });
          }}
          onCancel={() => setChoosing(false)}
        />
      )}
      {canManage && editing && (
        <AgentEditor
          key={editing.agent?.id ?? 'new'}
          editing={editing}
          models={models.list}
          linkedProjects={linkedProjects}
          busy={state.busy}
          controller={controller}
          onDone={() => setEditing(null)}
        />
      )}
      {canManage && archived.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-sm font-medium text-gray-300">Archived agents</h5>
          {archived.map((agent) => (
            <div className="flex flex-wrap items-center gap-2" key={agent.id}>
              <span>{agent.name}</span>
              <button
                className={button}
                disabled={state.busy}
                onClick={() => void controller.update(agent, { archived: false })}
              >
                Restore {agent.name}
              </button>
            </div>
          ))}
        </div>
      )}
      <ChatHistory
        chats={state.chats}
        onOpen={(chat) =>
          onOpenChat?.({
            organizationId: organization.id,
            organizationName: organization.name,
            agentId: chat.agentId,
            sessionId: chat.id,
            agent: state.agents.find((a) => a.id === chat.agentId) ?? null,
          })
        }
      />
    </div>
  );
}

function AgentRow({
  agent,
  canManage,
  busy,
  templates,
  onChat,
  onEdit,
}: {
  agent: OrganizationAgent;
  canManage: boolean;
  busy: boolean;
  templates: OrganizationAgentTemplate[];
  onChat: () => void;
  onEdit: () => void;
}) {
  const status = organizationAgentStatus(agent);
  const template = templates.find((t) => t.id === agent.organizationTemplate?.id);
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`organization-agent-${agent.id}`}
    >
      <span className="font-medium">{agent.name}</span>
      {agent.isAssistant && <span className="text-xs text-gray-400">Assistant</span>}
      {template && <span className="text-xs text-gray-400">from {template.label} template</span>}
      {status === 'disabled' && <span className="text-xs text-yellow-300">Disabled</span>}
      <span
        className="text-xs text-gray-400"
        data-testid={`organization-agent-computer-${agent.id}`}
      >
        {organizationAgentComputerLabel(agent)}
      </span>
      <button className={button} disabled={status !== 'active'} onClick={onChat}>
        Chat with {agent.name}
      </button>
      {canManage && (
        <button className={button} disabled={busy} onClick={onEdit}>
          Edit {agent.name}
        </button>
      )}
    </div>
  );
}

function TemplateChooser({
  templates,
  onChoose,
  onCancel,
}: {
  templates: OrganizationAgentTemplate[];
  onChoose: (template: OrganizationAgentTemplate | null) => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-gray-800 p-3">
      <p className="text-sm text-gray-400">
        Start from scratch or from an optional template. A template only fills in a name and
        instructions you can edit. It grants no tools or projects.
      </p>
      <button className={button} onClick={() => onChoose(null)}>
        Start from scratch
      </button>
      {templates.map((template) => (
        <div key={template.id} className="space-y-1">
          <button className={button} onClick={() => onChoose(template)}>
            Use {template.label} template
          </button>
          <p className="text-sm text-gray-400">{template.description}</p>
          <details>
            <summary className="cursor-pointer text-sm text-gray-400">Preview instructions</summary>
            <p className="whitespace-pre-wrap text-sm text-gray-300">{template.instructions}</p>
          </details>
        </div>
      ))}
      <button className={button} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function AgentEditor({
  editing,
  models,
  linkedProjects,
  busy,
  controller,
  onDone,
}: {
  editing: NonNullable<Editing>;
  models: string[];
  linkedProjects: OrganizationProject[];
  busy: boolean;
  controller: OrganizationAgentsController;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(editing.draft);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const set = (patch: Partial<OrganizationAgentDraft>) => setDraft({ ...draft, ...patch });
  const agent = editing.agent;
  const modelChoices =
    draft.model && !models.includes(draft.model) ? [draft.model, ...models] : models;
  const save = async () => {
    const id = agent
      ? await controller.update(agent, patchFromDraft(agent, draft))
      : await controller.create(draft);
    if (id) onDone();
  };
  return (
    <form
      className="space-y-3 rounded-lg border border-gray-800 p-3"
      aria-label={agent ? `Edit ${agent.name}` : 'New agent'}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.name.trim()) void save();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Agent name
        <input
          className={input}
          maxLength={200}
          value={draft.name}
          onChange={(event) => set({ name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Instructions
        <textarea
          className={`${input} min-h-[8rem]`}
          maxLength={32000}
          value={draft.systemPrompt}
          onChange={(event) => set({ systemPrompt: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Model
        <select
          className={input}
          value={draft.model}
          onChange={(event) => set({ model: event.target.value })}
        >
          {!draft.model && <option value="">Default model</option>}
          {modelChoices.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="space-y-1">
        <legend className="text-sm">Tool permissions</legend>
        {ORGANIZATION_AGENT_TOOLS.map((tool) => (
          <label className="flex items-center gap-2 text-sm" key={tool}>
            <input
              type="checkbox"
              checked={draft.tools.includes(tool)}
              onChange={() => set({ tools: toggleValue(draft.tools, tool) })}
            />
            {ORGANIZATION_TOOL_LABELS[tool]}
          </label>
        ))}
        {draft.tools.includes('computer') && (
          <label className="ml-6 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.computerByDefault}
              onChange={() => set({ computerByDefault: !draft.computerByDefault })}
            />
            Computer on by default in new chats
          </label>
        )}
        {draft.tools.includes('computer') && (
          <p className="ml-6 text-sm text-gray-400">
            Each person gets a private desktop for this agent. It starts on first use, and each chat
            can turn it on or off.
          </p>
        )}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-sm">Project access</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="project-scope"
            checked={draft.allLinked}
            onChange={() => set({ allLinked: true })}
          />
          All linked projects
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="project-scope"
            checked={!draft.allLinked}
            onChange={() => set({ allLinked: false })}
          />
          Selected projects
        </label>
        {!draft.allLinked &&
          (linkedProjects.length ? (
            linkedProjects.map((project) => (
              <label className="ml-6 flex items-center gap-2 text-sm" key={project.id}>
                <input
                  type="checkbox"
                  checked={draft.projectIds.includes(project.id)}
                  onChange={() => set({ projectIds: toggleValue(draft.projectIds, project.id) })}
                />
                {project.name}
              </label>
            ))
          ) : (
            <p className="ml-6 text-sm text-gray-400">No linked projects you can access.</p>
          ))}
        <p className="text-sm text-gray-400">
          Each person chatting only reaches the projects they can already access.
        </p>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={() => set({ enabled: !draft.enabled })}
        />
        Enabled
      </label>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy || !draft.name.trim()}>
          {agent ? 'Save agent' : 'Create agent'}
        </button>
        <button type="button" className={button} onClick={onDone}>
          Cancel
        </button>
        {agent &&
          (!confirmArchive ? (
            <button type="button" className={button} onClick={() => setConfirmArchive(true)}>
              Archive agent
            </button>
          ) : (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={async () => {
                if (await controller.update(agent, { archived: true })) onDone();
              }}
            >
              Confirm archive of {agent.name}
            </button>
          ))}
      </div>
      {agent && confirmArchive && (
        <p className="text-sm text-gray-400">
          Archiving stops new chats. Existing conversations stay in each person&apos;s history.
        </p>
      )}
    </form>
  );
}

function ChatHistory({
  chats,
  onOpen,
}: {
  chats: {
    id: string;
    name: string;
    agentId: string;
    agentName: string | null;
    agentAvailable: boolean;
  }[];
  onOpen: (chat: any) => void;
}) {
  if (!chats.length) return null;
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-medium text-gray-300">Your conversations</h5>
      {chats.map((chat) => (
        <div className="flex flex-wrap items-center gap-2" key={chat.id}>
          <button className={button} onClick={() => onOpen(chat)}>
            Open {chat.name}
          </button>
          <span className="text-sm text-gray-400">
            {chat.agentName ?? 'Removed agent'}
            {!chat.agentAvailable && ' (history only)'}
          </span>
        </div>
      ))}
    </div>
  );
}
