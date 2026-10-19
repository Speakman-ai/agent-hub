import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { createUseOrganizationAgents } from '@shared/hooks/useOrganizationAgents';
import {
  ORGANIZATION_AGENT_TOOLS,
  ORGANIZATION_TOOL_LABELS,
  draftFromAgent,
  newAgentDraft,
  organizationAgentStatus,
  patchFromDraft,
  rosterAgents,
  toggleValue,
  type OrganizationAgent,
  type OrganizationAgentDraft,
  type OrganizationAgentsController,
  type OrganizationAgentTemplate,
  type OrganizationChat,
} from '@shared/utils/organization-agents';
import type { Organization, OrganizationProject } from '@shared/utils/organizations';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

const useOrganizationAgents = createUseOrganizationAgents({
  useEffect,
  useMemo,
  useSyncExternalStore,
});

export type OrganizationChatTarget = {
  organizationId: string;
  agentId: string;
  sessionId: string;
  agent?: OrganizationAgent | null;
  session?: any;
};
type Editing = { agent: OrganizationAgent | null; draft: OrganizationAgentDraft } | null;

function Button({
  children,
  onPress,
  disabled = false,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={children}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.text}>{children}</Text>
    </TouchableOpacity>
  );
}
function Choice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
}) {
  return (
    <View style={styles.row}>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} />
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

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
        if (live)
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

export default function OrganizationAgentsSection({
  organization,
  linkedProjects,
  scope,
  onOpenChat,
  refreshKey,
}: {
  organization: Organization;
  linkedProjects: OrganizationProject[];
  scope: () => string;
  onOpenChat?: (target: OrganizationChatTarget) => void;
  refreshKey?: unknown;
}) {
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
        agentId: result.agent?.id ?? agent.id,
        sessionId: result.session.id,
        agent: result.agent ?? agent,
        session: result.session,
      });
  };
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Agents</Text>
      {!!state.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      )}
      {state.busy && !state.ready && <Text style={styles.text}>Loading agents…</Text>}
      {state.ready && !roster.length && (
        <Text style={styles.help}>
          No active agents.{' '}
          {canManage
            ? 'Add an agent to chat in this organization.'
            : 'Ask an organization Owner or Admin to add one.'}
        </Text>
      )}
      {roster.map((agent) => {
        const status = organizationAgentStatus(agent);
        const template = state.templates.find((t) => t.id === agent.organizationTemplate?.id);
        return (
          <View key={agent.id} style={styles.card}>
            <Text style={styles.text}>
              {agent.name}
              {agent.isAssistant ? ' · Assistant' : ''}
              {template ? ` · from ${template.label} template` : ''}
              {status === 'disabled' ? ' · Disabled' : ''}
            </Text>
            <Button disabled={status !== 'active'} onPress={() => void openChat(agent)}>
              {`Chat with ${agent.name}`}
            </Button>
            {canManage && (
              <Button
                disabled={state.busy}
                onPress={() => {
                  setChoosing(false);
                  setEditing({ agent, draft: draftFromAgent(agent) });
                }}
              >
                {`Edit ${agent.name}`}
              </Button>
            )}
          </View>
        );
      })}
      {canManage && !editing && !choosing && (
        <Button onPress={() => setChoosing(true)}>Add agent</Button>
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
        <View style={styles.section}>
          <Text style={styles.subheading}>Archived agents</Text>
          {archived.map((agent) => (
            <Button
              key={agent.id}
              disabled={state.busy}
              onPress={() => void controller.update(agent, { archived: false })}
            >
              {`Restore ${agent.name}`}
            </Button>
          ))}
        </View>
      )}
      <ChatHistory
        chats={state.chats}
        onOpen={(chat) =>
          onOpenChat?.({
            organizationId: organization.id,
            agentId: chat.agentId,
            sessionId: chat.id,
            agent: state.agents.find((a) => a.id === chat.agentId) ?? null,
          })
        }
      />
    </View>
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
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <View style={styles.card}>
      <Text style={styles.help}>
        Start from scratch or from an optional template. A template only fills in a name and
        instructions you can edit. It grants no tools or projects.
      </Text>
      <Button onPress={() => onChoose(null)}>Start from scratch</Button>
      {templates.map((template) => (
        <View key={template.id} style={styles.section}>
          <Button onPress={() => onChoose(template)}>{`Use ${template.label} template`}</Button>
          <Text style={styles.help}>{template.description}</Text>
          <Button onPress={() => setPreview(preview === template.id ? null : template.id)}>
            {`Preview ${template.label} instructions`}
          </Button>
          {preview === template.id && <Text style={styles.text}>{template.instructions}</Text>}
        </View>
      ))}
      <Button onPress={onCancel}>Cancel</Button>
    </View>
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
    <View style={styles.card}>
      <Text style={styles.subheading}>{agent ? `Edit ${agent.name}` : 'New agent'}</Text>
      <TextInput
        style={styles.input}
        accessibilityLabel="Agent name"
        placeholder="Agent name"
        placeholderTextColor={colors.gray500}
        maxLength={200}
        value={draft.name}
        onChangeText={(name) => set({ name })}
      />
      <TextInput
        style={[styles.input, { minHeight: 120 }]}
        accessibilityLabel="Instructions"
        placeholder="Instructions"
        placeholderTextColor={colors.gray500}
        multiline
        maxLength={32000}
        value={draft.systemPrompt}
        onChangeText={(systemPrompt) => set({ systemPrompt })}
      />
      <Text style={styles.text}>Model</Text>
      <View style={styles.row}>
        {modelChoices.map((model) => (
          <TouchableOpacity
            key={model}
            accessibilityRole="radio"
            accessibilityLabel={`Model: ${model}`}
            accessibilityState={{ selected: draft.model === model }}
            style={[styles.button, draft.model === model && styles.selected]}
            onPress={() => set({ model })}
          >
            <Text style={styles.text}>{model}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.text}>Tool permissions</Text>
      {ORGANIZATION_AGENT_TOOLS.map((tool) => (
        <Choice
          key={tool}
          label={ORGANIZATION_TOOL_LABELS[tool]}
          value={draft.tools.includes(tool)}
          onChange={() => set({ tools: toggleValue(draft.tools, tool) })}
        />
      ))}
      <Text style={styles.text}>Project access</Text>
      <Choice
        label="All linked projects"
        value={draft.allLinked}
        onChange={() => set({ allLinked: !draft.allLinked })}
      />
      {!draft.allLinked &&
        (linkedProjects.length ? (
          linkedProjects.map((project) => (
            <Choice
              key={project.id}
              label={project.name}
              value={draft.projectIds.includes(project.id)}
              onChange={() => set({ projectIds: toggleValue(draft.projectIds, project.id) })}
            />
          ))
        ) : (
          <Text style={styles.help}>No linked projects you can access.</Text>
        ))}
      <Text style={styles.help}>
        Each person chatting only reaches the projects they can already access.
      </Text>
      <Choice
        label="Enabled"
        value={draft.enabled}
        onChange={() => set({ enabled: !draft.enabled })}
      />
      <Button disabled={busy || !draft.name.trim()} onPress={() => void save()}>
        {agent ? 'Save agent' : 'Create agent'}
      </Button>
      <Button onPress={onDone}>Cancel</Button>
      {agent &&
        (!confirmArchive ? (
          <Button onPress={() => setConfirmArchive(true)}>Archive agent</Button>
        ) : (
          <>
            <Text style={styles.help}>
              Archiving stops new chats. Existing conversations stay in each person&apos;s history.
            </Text>
            <Button
              disabled={busy}
              onPress={async () => {
                if (await controller.update(agent, { archived: true })) onDone();
              }}
            >
              {`Confirm archive of ${agent.name}`}
            </Button>
          </>
        ))}
    </View>
  );
}

function ChatHistory({
  chats,
  onOpen,
}: {
  chats: OrganizationChat[];
  onOpen: (chat: OrganizationChat) => void;
}) {
  if (!chats.length) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.subheading}>Your conversations</Text>
      {chats.map((chat) => (
        <View key={chat.id}>
          <Button onPress={() => onOpen(chat)}>{`Open ${chat.name}`}</Button>
          <Text style={styles.help}>
            {chat.agentName ?? 'Removed agent'}
            {!chat.agentAvailable ? ' (history only)' : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  card: { gap: 8, borderWidth: 1, borderColor: colors.gray800, borderRadius: 8, padding: 12 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  heading: { color: colors.white, fontSize: 18, fontWeight: '600' },
  subheading: { color: colors.gray200, fontSize: 16, fontWeight: '600' },
  text: { color: colors.gray200, fontSize: 14 },
  help: { color: colors.gray400, fontSize: 14 },
  error: { color: colors.red400 },
  button: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
  },
  selected: { backgroundColor: colors.gray700 },
  input: {
    color: colors.white,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
  },
});
