import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AdaptiveQuestionnaire from '../components/AdaptiveQuestionnaire';
import { useApp } from '../context/AppContext';
import { api } from '../utils/api';
import { isCompleteProject } from '../utils/newProjectProvisioning';
import { colors } from '../theme/colors';

export default function NewProjectScreen({ navigation }: any) {
  const {
    refreshProjects,
    refreshAgents,
    setActiveAgentId,
    setActiveSessionId,
    subscribeInitialBuild,
  } = useApp();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdProject, setCreatedProject] = useState<any>(null);
  // The project id we're awaiting a first-build session for, plus a guard so
  // the handoff fires once. Refs (not state) so the WS subscription reads the
  // latest without re-registering.
  const awaitingBuildProjectIdRef = useRef<string | null>(null);
  const openedBuildRef = useRef(false);

  // Open the first build session's chat as soon as provisioning dispatches it
  // — mobile parity with the web adaptive flow, which opens the build chat
  // rather than stopping at a "provisioning started" screen.
  const openBuildSession = useCallback(
    (data: any) => {
      if (openedBuildRef.current) return;
      const projectId = awaitingBuildProjectIdRef.current;
      if (!projectId || data?.projectId !== projectId) return;
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
      if (!sessionId) return;
      openedBuildRef.current = true;
      if (data.agentId) setActiveAgentId(data.agentId);
      setActiveSessionId(sessionId);
      navigation?.navigate?.('Chat');
    },
    [navigation, setActiveAgentId, setActiveSessionId],
  );

  useEffect(() => {
    if (!subscribeInitialBuild) return;
    const unsubscribe = subscribeInitialBuild(openBuildSession);
    return () => unsubscribe?.();
  }, [subscribeInitialBuild, openBuildSession]);

  const loadProjectDetails = async (projectId: string, hostOnAgentHub = true) => {
    let lastError: unknown = null;
    // Provisioning creates the row before returning, but retry briefly so a
    // delayed persistence/read path never enables navigation with a partial
    // project object.
    for (const delayMs of [0, 250, 750]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const project = await api.getProject(projectId);
        if (!isCompleteProject(project, projectId, hostOnAgentHub)) {
          throw new Error('Project details are incomplete; waiting for persistence.');
        }
        return project;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Project details are not available yet.');
  };

  const handleSubmit = async (payload: any) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.provisionProject(payload);
      const projectId = result?.projectId || result?.project?.id;
      if (!projectId) throw new Error('Provisioning did not return a project id.');
      // Arm the first-build handoff for this project.
      openedBuildRef.current = false;
      awaitingBuildProjectIdRef.current = projectId;
      const provisioning = {
        jobId: result.jobId,
        wsUrl: result.wsUrl,
        status: 'started',
      };
      const hostOnAgentHub = payload.hostOnAgentHub !== false;
      const fallbackProject = {
        id: projectId,
        name: payload.name === 'idk' ? projectId : payload.name,
        hostOnAgentHub,
        provisioning,
        jobId: result.jobId,
        wsUrl: result.wsUrl,
      };
      try {
        const project = await loadProjectDetails(projectId, hostOnAgentHub);
        setCreatedProject({
          ...fallbackProject,
          ...project,
          provisioning: { ...provisioning, ...(project?.provisioning || {}) },
          loadError: null,
        });
      } catch (err: any) {
        setCreatedProject({
          ...fallbackProject,
          loadError: err?.message || 'Project details are not available yet.',
        });
      }
      refreshProjects?.();
      refreshAgents?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  const retryProjectLoad = async () => {
    if (!createdProject?.id) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await loadProjectDetails(
        createdProject.id,
        createdProject.hostOnAgentHub !== false,
      );
      setCreatedProject((current: any) => ({
        ...current,
        ...project,
        provisioning: { ...(current.provisioning || {}), ...(project?.provisioning || {}) },
        loadError: null,
      }));
      refreshProjects?.();
      refreshAgents?.();
    } catch (err: any) {
      setCreatedProject((current: any) => ({
        ...current,
        loadError: err?.message || 'Project details are not available yet.',
      }));
    } finally {
      setSubmitting(false);
    }
  };

  if (createdProject) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <View style={styles.successBody}>
          <Text style={styles.successTitle}>Project provisioning started</Text>
          <Text style={styles.successName}>{createdProject.name}</Text>
          <Text style={styles.successMeta}>ID: {createdProject.id}</Text>
          <Text style={styles.successHint}>
            Agent Hub is preparing the repository and will open the first build chat automatically
            once it starts. You can open the project board while it runs.
          </Text>
          {createdProject.jobId ? (
            <Text style={styles.jobText}>Job: {createdProject.jobId}</Text>
          ) : null}
          {createdProject.loadError ? (
            <View style={styles.loadErrorBox}>
              <Text style={styles.errorText}>
                Project details are still loading: {createdProject.loadError}
              </Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={retryProjectLoad}
                disabled={submitting}
              >
                <Text style={styles.primaryButtonText}>Retry loading project</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <TouchableOpacity
            style={[
              styles.primaryButton,
              (createdProject.loadError || submitting) && styles.disabledButton,
            ]}
            disabled={!!createdProject.loadError || submitting}
            onPress={() =>
              navigation.navigate('Kanban', {
                projectId: createdProject.id,
                project: createdProject,
                provisioning: createdProject.provisioning,
              })
            }
          >
            <Text style={styles.primaryButtonText}>Open Board</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      {submitting ? (
        <View style={styles.submittingOverlay}>
          <ActivityIndicator color={colors.emerald400} />
          <Text style={styles.submittingText}>Starting project provisioning…</Text>
        </View>
      ) : null}
      <AdaptiveQuestionnaire
        onSubmit={handleSubmit}
        onClose={() => navigation.goBack()}
        submitting={submitting}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  errorBox: {
    padding: 12,
    backgroundColor: colors.red900_50,
    borderBottomWidth: 1,
    borderBottomColor: colors.red600,
  },
  errorText: { color: colors.red400, fontSize: 13 },
  loadErrorBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.amber400,
    backgroundColor: colors.amber900_40,
  },
  submittingOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.gray900,
  },
  submittingText: { color: colors.gray300, fontSize: 12 },
  successBody: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  successTitle: { color: colors.emerald400, fontSize: 16, fontWeight: '600', marginBottom: 8 },
  successName: { color: colors.white, fontSize: 21, fontWeight: '700' },
  successMeta: { color: colors.gray500, fontSize: 12, marginTop: 4 },
  successHint: { color: colors.gray400, fontSize: 13, lineHeight: 19, marginTop: 16 },
  jobText: { color: colors.gray600, fontSize: 11, marginTop: 12 },
  primaryButton: {
    alignItems: 'center',
    paddingVertical: 13,
    borderRadius: 9,
    backgroundColor: colors.emerald600,
    marginTop: 24,
  },
  retryButton: {
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.gray700,
    marginTop: 10,
  },
  disabledButton: { opacity: 0.45 },
  primaryButtonText: { color: colors.white, fontSize: 15, fontWeight: '600' },
});
