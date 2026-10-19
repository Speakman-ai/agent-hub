import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
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
import { colors } from '../theme/colors';
import { HubChatPlainTextWithRefs } from './HubChatRefs';
import type { OrganizationChatTarget } from './OrganizationAgentsSection';

const useOrganizationPortfolio = createUseOrganizationPortfolio({
  useEffect,
  useMemo,
  useSyncExternalStore,
});
const tone: Record<DispatchDisplayState, string> = {
  pending: colors.yellow400,
  running: colors.sky400,
  completed: colors.emerald400,
  failed: colors.red400,
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

function Button({
  children,
  onPress,
  disabled = false,
  selected,
  label,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  label?: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label ?? children}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, selected && styles.selected, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.text}>{children}</Text>
    </TouchableOpacity>
  );
}

type Props = {
  organization: Organization;
  scope: () => string;
  refreshKey?: unknown;
  onOpenProject?: (projectId: string) => void;
  onOpenSession?: (agentId: string, sessionId: string) => void;
  onOpenChat?: (target: OrganizationChatTarget) => void;
};

/** Mobile twin of the web portfolio panel: same API, controller and state semantics. */
export default function OrganizationPortfolioSection({
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
    <View style={styles.section} accessibilityLabel="Organization portfolio">
      <Text style={styles.heading}>Portfolio</Text>
      <Button disabled={state.busy} onPress={() => void controller.load()}>
        Refresh portfolio
      </Button>
      {!!state.error && <Text style={styles.error}>{state.error}</Text>}
      {state.busy && <Text style={styles.help}>Loading portfolio…</Text>}
      {state.ready && (
        <>
          <Text style={styles.help}>
            Projects you can access in {organization.name}. Retrieved {time(state.retrievedAt)}.
          </Text>
          {!state.projects.length && (
            <Text style={styles.help}>
              No linked projects you can access. Linking never grants project access.
            </Text>
          )}
          {state.projects.map((p) => (
            <ProjectCard key={p.id} project={p} onOpenProject={onOpenProject} />
          ))}
          {state.nextOffset !== null && (
            <Button onPress={() => void controller.loadMore()}>Load more projects</Button>
          )}
          <DispatchForm state={state} controller={controller} />
          <Text style={styles.subheading}>Dispatched work</Text>
          {!state.dispatches.length && <Text style={styles.help}>Nothing dispatched yet.</Text>}
          {state.dispatches.map((d) => (
            <DispatchItem
              key={d.requestId}
              dispatch={d}
              projects={state.projects}
              onOpenRef={openRef}
              onOpenSession={onOpenSession}
              onOpenChat={() =>
                onOpenChat?.({
                  organizationId: organization.id,
                  agentId: d.organizationAgentId,
                  sessionId: d.initiatingSessionId,
                  agent: state.agents.find((a) => a.id === d.organizationAgentId) ?? null,
                })
              }
            />
          ))}
        </>
      )}
    </View>
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
    <View style={styles.card} accessibilityLabel={project.name}>
      <Text style={styles.subheading}>{project.name}</Text>
      <Text style={styles.text}>
        {project.board.openCards} open of {project.board.totalCards} cards · {project.board.epics}{' '}
        epics · {project.wiki.pages} wiki pages · {project.sessions.own} of your sessions
      </Text>
      <Text style={styles.help}>
        Agents: {project.agents.map((a) => a.name).join(', ') || 'none'}
        {project.agentsTruncated ? ` (+${project.agentCount - project.agents.length})` : ''}
      </Text>
      <Text style={styles.help}>
        Source: {project.source.projectName} · {project.source.record} · updated{' '}
        {time(project.timestamp)}
      </Text>
      {onOpenProject && (
        <Button onPress={() => onOpenProject(project.id)}>{`Open ${project.name}`}</Button>
      )}
    </View>
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
      <Text style={styles.help}>
        No organization agent can dispatch project agents. Ask an organization Owner or Admin to
        enable “Dispatch project agents” on one.
      </Text>
    );
  return (
    <View style={styles.card} accessibilityLabel="Dispatch a project agent">
      <Text style={styles.subheading}>Dispatch a project agent</Text>
      <Text style={styles.help}>From organization agent</Text>
      <View style={styles.row}>
        {sources.map((a) => (
          <Button
            key={a.id}
            label={`From ${a.name}`}
            selected={a.id === source?.id}
            onPress={() => {
              setSourceId(a.id);
              setProjectId('');
              setAgentId('');
            }}
          >
            {a.name}
          </Button>
        ))}
      </View>
      <Text style={styles.help}>Project</Text>
      {!projects.length && (
        <Text style={styles.help}>{source?.name} has no linked projects in scope.</Text>
      )}
      <View style={styles.row}>
        {projects.map((p) => (
          <Button
            key={p.id}
            label={`Project ${p.name}`}
            selected={p.id === projectId}
            onPress={() => {
              setProjectId(p.id);
              setAgentId('');
            }}
          >
            {p.name}
          </Button>
        ))}
      </View>
      {project && (
        <>
          <Text style={styles.help}>Agent</Text>
          <View style={styles.row}>
            {targets.map((a) => (
              <Button
                key={a.id}
                label={`Agent ${a.name}`}
                selected={a.id === agentId}
                onPress={() => setAgentId(a.id)}
              >
                {a.name}
              </Button>
            ))}
          </View>
        </>
      )}
      <TextInput
        style={styles.input}
        accessibilityLabel="Task for the project agent"
        placeholder="What should the project agent do?"
        placeholderTextColor={colors.gray500}
        multiline
        maxLength={50000}
        value={prompt}
        onChangeText={setPrompt}
      />
      {!!state.dispatchError && <Text style={styles.error}>{state.dispatchError}</Text>}
      <Button
        label="Dispatch"
        disabled={!ready || state.dispatching}
        onPress={() => {
          if (!ready || !source) return;
          // Pin the defaulted source so a roster refresh cannot change a retry's intent (and key).
          setSourceId(source.id);
          void controller.dispatch(source.id, { projectId, agentId, prompt });
        }}
      >
        {state.dispatching ? 'Dispatching…' : 'Dispatch'}
      </Button>
    </View>
  );
}

function DispatchItem({
  dispatch: d,
  projects,
  onOpenRef,
  onOpenSession,
  onOpenChat,
}: {
  dispatch: OrganizationDispatch;
  projects: PortfolioProject[];
  onOpenRef: (ref: HubChatResolvedRef) => void;
  onOpenSession?: (agentId: string, sessionId: string) => void;
  onOpenChat: () => void;
}) {
  const state = dispatchDisplayState(d);
  const project = projects.find((p) => p.id === d.projectId);
  const agent = project?.agents.find((a) => a.id === d.agentId);
  const detail = dispatchDetail(d);
  return (
    <View style={styles.card} accessibilityLabel={`Dispatch ${d.name}`}>
      <Text style={[styles.badge, { color: tone[state] }]}>{DISPATCH_STATE_LABELS[state]}</Text>
      <Text style={styles.subheading}>{d.name}</Text>
      <Text style={styles.help}>
        {project?.name ?? d.projectId} · {agent?.name ?? d.agentId}
      </Text>
      {!!detail && <Text style={styles.text}>{detail}</Text>}
      {!!d.ref && (
        <Text style={styles.text}>
          <HubChatPlainTextWithRefs text={d.ref} onOpenRef={onOpenRef} />
        </Text>
      )}
      {!!d.sessionId && onOpenSession && (
        <Button onPress={() => onOpenSession(d.agentId, d.sessionId!)}>Open target session</Button>
      )}
      <Button onPress={onOpenChat}>Open organization chat</Button>
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
  badge: { fontSize: 13, fontWeight: '600' },
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
    minHeight: 88,
    textAlignVertical: 'top',
  },
});
