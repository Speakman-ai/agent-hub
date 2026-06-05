/**
 * FinalizeSection — Settings → Finalize panel (React Native).
 *
 * Mirrors the web `FinalizeSettingsSection`. The wizard runs as a
 * normal worktree-backed session in the mobile chat surface; this
 * section is the entry point:
 *   - project picker
 *   - "Set up Runner" button → POST /api/projects/:id/finalize/setup-wizard
 *   - on success, open the spawned chat session
 *
 * Pure state helpers live in `mobile/src/utils/finalizeWizard.js` so
 * they can be exercised by the existing pure-JS vitest suite. WS
 * refresh is delivered via `useApp().lastFinalizeWizardEvent`.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { pickInitialProjectId, shouldRefreshOnWizardComplete } from '../utils/finalizeWizard';

export default function FinalizeSection({ navigation }) {
  const {
    projects,
    refreshProjects,
    setActiveAgentId,
    setActiveSessionId,
    lastFinalizeWizardEvent,
  } = useApp();

  const [projectId, setProjectId] = useState(() => pickInitialProjectId(projects, ''));
  const [wizardStarting, setWizardStarting] = useState(false);
  const [wizardError, setWizardError] = useState(null);
  const [lastSessionId, setLastSessionId] = useState(null);

  // Keep the picker in sync when the project list mutates underneath us
  // (e.g. a new project is created elsewhere).
  useEffect(() => {
    const next = pickInitialProjectId(projects, projectId);
    if (next !== projectId) setProjectId(next);
  }, [projects, projectId]);

  // Refresh projects on `finalize_wizard_complete` for the focused
  // project (mirrors the web component's window.addEventListener path).
  useEffect(() => {
    if (
      shouldRefreshOnWizardComplete(lastFinalizeWizardEvent, projectId) &&
      typeof refreshProjects === 'function'
    ) {
      refreshProjects();
    }
  }, [lastFinalizeWizardEvent, projectId, refreshProjects]);

  const project = projects.find((p) => p.id === projectId) || null;
  // We track the wizard's agent id separately so the "Open wizard chat"
  // button works even after the user changes the project picker (which
  // clears `project` but not the just-spawned session).
  const [spawnedAgentId, setSpawnedAgentId] = useState(null);

  const handleStartWalkthrough = useCallback(async () => {
    if (!project || wizardStarting) return;
    setWizardStarting(true);
    setWizardError(null);
    try {
      const res = await api.startFinalizeWizard(project.id);
      if (!res?.sessionId) {
        setWizardError('Server did not return a wizard session id');
        return;
      }
      setLastSessionId(res.sessionId);
      setSpawnedAgentId(res.agentId || null);
    } catch (err) {
      setWizardError(err?.message || 'Failed to start setup walkthrough');
    } finally {
      setWizardStarting(false);
    }
  }, [project, wizardStarting]);

  const handleOpenWizardChat = useCallback(() => {
    if (!lastSessionId) return;
    if (spawnedAgentId) setActiveAgentId(spawnedAgentId);
    setActiveSessionId(lastSessionId);
    if (navigation && typeof navigation.navigate === 'function') {
      navigation.navigate('Chat');
    }
  }, [lastSessionId, spawnedAgentId, setActiveAgentId, setActiveSessionId, navigation]);

  if (!projects || projects.length === 0) {
    return <Text style={styles.emptyText}>No projects yet.</Text>;
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Runner</Text>
      <Text style={styles.sectionDesc}>
        Author <Text style={styles.mono}>.agent-hub/ci.yaml</Text> — the config that drives the
        Runner pre-PR pipeline (lint, typecheck, tests, fixture data, etc.). Tap{' '}
        <Text style={styles.boldText}>Set up Runner</Text> to spawn a normal worktree-backed session
        that scans the repo, proposes a config, runs the configured steps to prove the pipeline, then
        pushes and opens a PR for review.
      </Text>

      <Text style={styles.fieldLabel}>Project</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        testID="finalize-project-picker"
      >
        {projects.map((p) => {
          const active = p.id === projectId;
          return (
            <TouchableOpacity
              key={p.id}
              onPress={() => setProjectId(p.id)}
              style={[styles.chip, active && styles.chipActive]}
              testID={`finalize-project-${p.id}`}
            >
              <View
                style={[
                  styles.chipDot,
                  { backgroundColor: p.color || colors.indigo500 },
                ]}
              />
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {p.name || p.id}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Guided setup walkthrough</Text>
        <Text style={styles.cardBody}>
          Spawns a normal worktree-backed session loaded with the{' '}
          <Text style={styles.mono}>finalize-setup</Text> skill. It reads README, package manifests,
          and existing CI workflows, proposes a <Text style={styles.mono}>.agent-hub/ci.yaml</Text>,
          runs the configured steps to prove the pipeline, then pushes and opens a PR for review.
        </Text>

        {lastSessionId && (
          <Text style={styles.successInline} testID="finalize-last-session">
            Last wizard session: <Text style={styles.mono}>{lastSessionId}</Text>
          </Text>
        )}

        <TouchableOpacity
          onPress={handleStartWalkthrough}
          disabled={!project || wizardStarting}
          style={[
            styles.primaryButton,
            (!project || wizardStarting) && styles.primaryButtonDisabled,
          ]}
          testID="finalize-start-button"
        >
          {wizardStarting ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Text style={styles.primaryButtonText}>
              {lastSessionId ? 'Re-run wizard' : 'Set up Runner'}
            </Text>
          )}
        </TouchableOpacity>

        {lastSessionId && (
          <TouchableOpacity
            onPress={handleOpenWizardChat}
            style={styles.secondaryButton}
            testID="finalize-open-chat-button"
          >
            <Text style={styles.secondaryButtonText}>Open wizard chat</Text>
          </TouchableOpacity>
        )}

        {wizardError && (
          <Text style={styles.errorInline} testID="finalize-error">
            {wizardError}
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>What lands in your repo</Text>
        <Text style={styles.bullet}>
          • A single file at <Text style={styles.mono}>.agent-hub/ci.yaml</Text>.
        </Text>
        <Text style={styles.bullet}>
          • Committed on a fresh branch in the setup session&apos;s own worktree, verified locally,
          then pushed and opened as a PR for review.
        </Text>
        <Text style={styles.bullet}>
          • One step per check you want to run before pushing — install, typecheck, lint, test, etc.
          Hard cap: 4 hours of active time.
        </Text>
        <Text style={styles.bullet}>
          • Re-run the wizard any time — it overwrites the existing file.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 8,
  },
  sectionDesc: {
    fontSize: 13,
    color: colors.gray400,
    lineHeight: 18,
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 12,
    color: colors.gray400,
    marginBottom: 4,
    marginTop: 10,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
  },
  chipActive: {
    borderColor: colors.emerald400,
    backgroundColor: colors.emerald800_50,
  },
  chipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  chipText: {
    fontSize: 13,
    color: colors.gray300,
  },
  chipTextActive: {
    color: colors.white,
    fontWeight: '500',
  },
  card: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
    marginBottom: 6,
  },
  cardBody: {
    fontSize: 12,
    color: colors.gray400,
    lineHeight: 17,
  },
  bullet: {
    fontSize: 12,
    color: colors.gray400,
    lineHeight: 18,
    marginTop: 4,
  },
  mono: {
    fontFamily: 'monospace',
    color: colors.gray200,
    fontSize: 12,
  },
  boldText: {
    color: colors.gray200,
    fontWeight: '600',
  },
  successInline: {
    fontSize: 12,
    color: colors.emerald400,
    marginTop: 10,
  },
  targetInline: {
    fontSize: 12,
    color: colors.gray300,
    marginTop: 10,
    lineHeight: 17,
  },
  warnInline: {
    fontSize: 12,
    color: colors.amber400,
    marginTop: 10,
    lineHeight: 17,
  },
  primaryButton: {
    marginTop: 14,
    backgroundColor: colors.emerald500,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: colors.gray700,
  },
  primaryButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    marginTop: 8,
    backgroundColor: 'transparent',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray600,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: colors.gray200,
    fontSize: 14,
    fontWeight: '500',
  },
  errorInline: {
    fontSize: 12,
    color: colors.red400,
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    color: colors.gray500,
  },
});
