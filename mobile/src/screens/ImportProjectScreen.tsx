import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { signInWithGithub } from '../utils/oauthSignIn';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  IMPORT_STEP_IDS,
  advanceImportStep,
  buildImportOnboardPayload,
  buildImportPreviewPatch,
  canContinueImport,
  cloneRequestMatches,
  cloneSourceChanged,
  deriveProjectId,
  deriveProjectNameFromCloneUrl,
  deriveProjectNameFromPath,
  goBackImportStep,
  initialImportDraft,
  importEventMatchesOperation,
  normalizeImportAnalysisResult,
  type ImportAnalysisResult,
  type ImportSourceMode,
  type ImportWizardDraft,
  resetImportSourceDraft,
} from '@shared/utils/projectImportWizard';

const CONTEXT_FILES = ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];
const COLORS = [
  '#6366F1',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
  '#F59E0B',
  '#10B981',
  '#06B6D4',
  '#6B7280',
];
const ANALYSIS_ENGINES = ['claude-code', 'cursor-agent', 'codex-cli'];
const ENGINE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'cursor-agent': 'Cursor Agent',
  'codex-cli': 'Codex',
};

function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.button, secondary && styles.secondaryButton, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function ImportProjectScreen({ navigation }: any) {
  const { modelConfig, projectImportEvents, refreshProjects, refreshAgents } = useApp();
  const [draft, setDraft] = useState<ImportWizardDraft>(initialImportDraft);
  const [nameEdited, setNameEdited] = useState(false);
  const [idEdited, setIdEdited] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneId, setCloneId] = useState<string | null>(null);
  const [cloneReady, setCloneReady] = useState(false);
  const [cloneLog, setCloneLog] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeId, setAnalyzeId] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingPreviewSave, setPendingPreviewSave] = useState<{
    project: any;
    patch: Record<string, unknown>;
  } | null>(null);
  const [githubStatus, setGithubStatus] = useState<any>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubConnecting, setGithubConnecting] = useState(false);
  const [repoInfo, setRepoInfo] = useState<any>(null);
  const cloneRequestRef = useRef<{ url: string; target: string } | null>(null);
  const analysisRequestGenerationRef = useRef(0);
  const cloneRequestGenerationRef = useRef(0);
  const processedImportEventIdsRef = useRef(new Set<number>());
  const [completedCloneSource, setCompletedCloneSource] = useState<{
    url: string;
    target: string;
  } | null>(null);

  const analysisOptions = useMemo(() => {
    const valid = modelConfig?.engineValidModels || {};
    return ANALYSIS_ENGINES.map((engine) => ({
      engine,
      models: Array.isArray(valid[engine]) ? valid[engine] : [],
    })).filter((option) => option.models.length > 0);
  }, [modelConfig]);

  const updateDraft = useCallback((patch: Partial<ImportWizardDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    if (nameEdited) return;
    const sourceName =
      draft.sourceMode === 'clone'
        ? deriveProjectNameFromCloneUrl(draft.cloneUrl)
        : deriveProjectNameFromPath(draft.path);
    if (!sourceName) return;
    setDraft((current) => ({
      ...current,
      name: sourceName,
      projectId: idEdited ? current.projectId : deriveProjectId(sourceName),
    }));
  }, [draft.sourceMode, draft.cloneUrl, draft.path, nameEdited, idEdited]);

  useEffect(() => {
    if (!idEdited && draft.name) {
      setDraft((current) => ({ ...current, projectId: deriveProjectId(current.name) }));
    }
  }, [draft.name, idEdited]);

  useEffect(() => {
    if (!draft.analysisEngine && analysisOptions.length > 0) {
      const engine = analysisOptions[0];
      updateDraft({
        analysisEngine: engine.engine,
        analysisModel: modelConfig?.engineDefaultModels?.[engine.engine] || engine.models[0],
      });
    }
  }, [analysisOptions, draft.analysisEngine, modelConfig, updateDraft]);

  const invalidateAnalysis = useCallback(() => {
    analysisRequestGenerationRef.current += 1;
    setAnalyzeId(null);
    setAnalyzing(false);
    setProgressLog([]);
    updateDraft({
      analysisResult: null,
      selectedAgents: {},
      contextFiles: {},
      wikiPages: [],
    });
  }, [updateDraft]);

  const changeAnalysisConfig = useCallback(
    (patch: Pick<ImportWizardDraft, 'analysisEngine' | 'analysisModel'>) => {
      invalidateAnalysis();
      setError(null);
      updateDraft(patch);
    },
    [invalidateAnalysis, updateDraft],
  );

  const changeSourceMode = useCallback(
    (sourceMode: ImportSourceMode) => {
      if (sourceMode === draft.sourceMode) return;
      setCloneId(null);
      setCloning(false);
      setCloneReady(false);
      setCloneLog([]);
      setCompletedCloneSource(null);
      cloneRequestRef.current = null;
      cloneRequestGenerationRef.current += 1;
      invalidateAnalysis();
      setError(null);
      setDraft((current) => resetImportSourceDraft(current, sourceMode));
    },
    [draft.sourceMode, invalidateAnalysis],
  );

  const changeLocalPath = useCallback(
    (path: string) => {
      invalidateAnalysis();
      setError(null);
      updateDraft({ path });
    },
    [invalidateAnalysis, updateDraft],
  );

  const changeCloneSource = useCallback(
    (patch: Pick<ImportWizardDraft, 'cloneUrl' | 'cloneTarget'>) => {
      cloneRequestGenerationRef.current += 1;
      setCloneId(null);
      setCloning(false);
      setCloneReady(false);
      setCloneLog([]);
      setCompletedCloneSource(null);
      cloneRequestRef.current = null;
      invalidateAnalysis();
      setError(null);
      updateDraft({
        ...patch,
        path: '',
        detectedPreview: null,
        previewDecision: null,
      });
    },
    [invalidateAnalysis, updateDraft],
  );

  const handleImportEvent = useCallback(
    (event: any) => {
      if (event.cloneId && event.cloneId === cloneId) {
        if (event.type === 'clone-progress' && event.message) {
          setCloneLog((current) => [...current.slice(-29), event.message]);
        } else if (event.type === 'clone-complete') {
          setCloning(false);
          setCloneReady(true);
          setCompletedCloneSource(cloneRequestRef.current);
          setDraft((current) => ({ ...current, path: event.path || current.path }));
          setCloneLog((current) => [...current, 'Clone complete. Ready to analyze.']);
        } else if (event.type === 'clone-preview-defaults') {
          updateDraft({ previewDecision: null });
          setDraft((current) => ({ ...current, detectedPreview: event.detected || null }));
        } else if (event.type === 'clone-error') {
          setCloning(false);
          setError(event.error || 'Clone failed.');
        }
        return;
      }
      if (event.analyzeId && event.analyzeId === analyzeId) {
        if (event.type === 'analyze-progress') {
          const message = event.message || event.chunk || event.text;
          if (message) setProgressLog((current) => [...current.slice(-29), message]);
        } else if (event.type === 'analyze-complete') {
          const result = normalizeImportAnalysisResult(event.result);
          const selectedAgents: Record<string, boolean> = {};
          (result.agents || []).forEach((_agent, index) => {
            selectedAgents[String(index)] = true;
          });
          updateDraft({
            analysisResult: result,
            selectedAgents,
            contextFiles: result.contextFiles || {},
            wikiPages: Array.isArray(result.wikiPages) ? result.wikiPages : [],
          });
          setAnalyzing(false);
        } else if (event.type === 'analyze-error') {
          setAnalyzing(false);
          setError(event.error || 'Analysis failed.');
        }
      }
    },
    [analyzeId, cloneId, updateDraft],
  );

  useEffect(() => {
    for (const event of projectImportEvents) {
      const eventId = event.importEventId;
      if (typeof eventId !== 'number' || processedImportEventIdsRef.current.has(eventId)) continue;
      if (!importEventMatchesOperation(event, { cloneId, analyzeId })) continue;
      processedImportEventIdsRef.current.add(eventId);
      handleImportEvent(event);
    }
  }, [analyzeId, cloneId, handleImportEvent, projectImportEvents]);

  useEffect(() => {
    if (!completedCloneSource) return;
    const currentSource = {
      url: draft.cloneUrl.trim(),
      target: draft.cloneTarget.trim(),
    };
    if (!cloneSourceChanged(completedCloneSource, currentSource)) return;
    setCompletedCloneSource(null);
    setCloneId(null);
    cloneRequestGenerationRef.current += 1;
    setCloneReady(false);
    setCloneLog([]);
    invalidateAnalysis();
    setError(null);
    setDraft((current) => ({
      ...current,
      path: '',
      detectedPreview: null,
      previewDecision: null,
    }));
  }, [completedCloneSource, draft.cloneTarget, draft.cloneUrl, invalidateAnalysis]);

  const analyze = useCallback(async () => {
    const requestGeneration = ++analysisRequestGenerationRef.current;
    setError(null);
    // Invalidate the previous run before the new request can emit anything.
    // The server streams over a separate WebSocket, so an old completion can
    // otherwise match while this request is still waiting for its analyzeId.
    setAnalyzeId(null);
    setAnalyzing(true);
    setProgressLog([]);
    updateDraft({ analysisResult: null, selectedAgents: {}, contextFiles: {}, wikiPages: [] });
    try {
      const result = await api.analyzeProject({
        cwd: draft.path,
        ...(draft.analysisEngine ? { engine: draft.analysisEngine } : {}),
        ...(draft.analysisModel ? { model: draft.analysisModel } : {}),
      });
      if (analysisRequestGenerationRef.current !== requestGeneration) return;
      setAnalyzeId(result.analyzeId);
      updateDraft({ step: 1 });
    } catch (err: any) {
      if (analysisRequestGenerationRef.current !== requestGeneration) return;
      setAnalyzing(false);
      setError(err?.message || 'Analysis could not start.');
    }
  }, [draft.analysisEngine, draft.analysisModel, draft.path, updateDraft]);

  const startClone = useCallback(async () => {
    const requestGeneration = ++cloneRequestGenerationRef.current;
    const requestSource = {
      url: draft.cloneUrl.trim(),
      target: draft.cloneTarget.trim(),
    };
    setError(null);
    // Do not let buffered events from a prior clone match during the new
    // request's response gap. The old path is cleared at the same time so a
    // failed/retried clone cannot accidentally analyze stale source data.
    setCloneId(null);
    setCloning(true);
    setCloneReady(false);
    setCloneLog(['Starting git clone…']);
    setCompletedCloneSource(null);
    setDraft((current) => ({
      ...current,
      path: '',
      detectedPreview: null,
      previewDecision: null,
    }));
    cloneRequestRef.current = requestSource;
    try {
      const result = await api.cloneProject({
        url: requestSource.url,
        ...(requestSource.target ? { targetDir: requestSource.target } : {}),
      });
      if (
        !cloneRequestMatches(
          requestGeneration,
          cloneRequestGenerationRef.current,
          requestSource,
          cloneRequestRef.current,
        )
      ) {
        return;
      }
      setCloneId(result.cloneId);
    } catch (err: any) {
      if (cloneRequestGenerationRef.current !== requestGeneration) return;
      setCloning(false);
      setError(err?.message || 'Clone could not start.');
    }
  }, [draft.cloneTarget, draft.cloneUrl]);

  const loadGithub = useCallback(async () => {
    setGithubLoading(true);
    setError(null);
    try {
      const [user, cli] = await Promise.all([
        api.getGithubAuthStatus().catch(() => null),
        api.getGithubCliStatus().catch(() => null),
      ]);
      const authenticated = !!user?.connected || !!cli?.authenticated;
      setGithubStatus({
        authenticated,
        user: user?.login || cli?.user || null,
        source: user?.connected ? 'github' : cli?.authenticated ? 'gh-cli' : null,
      });
      if (authenticated && draft.path) {
        const repo = await api.detectGithubRepo(draft.path).catch(() => null);
        setRepoInfo(repo);
        if (repo?.hasRemote && repo.owner && repo.repo) {
          updateDraft({ repoOwner: repo.owner, repoName: repo.repo });
        }
      }
    } catch (err: any) {
      setGithubStatus({ authenticated: false, user: null, source: null });
      setError(err?.message || 'GitHub detection failed.');
    } finally {
      setGithubLoading(false);
    }
  }, [draft.path, updateDraft]);

  useEffect(() => {
    if (draft.step === 2) void loadGithub();
  }, [draft.step, loadGithub]);

  const connectGithub = async () => {
    setGithubConnecting(true);
    setError(null);
    try {
      const outcome = await signInWithGithub();
      if (!outcome.ok) {
        if (!outcome.cancelled) setError('GitHub sign-in did not complete.');
        return;
      }
      await loadGithub();
    } catch (err: any) {
      setError(err?.message || 'GitHub sign-in failed.');
    } finally {
      setGithubConnecting(false);
    }
  };

  const testGithub = async () => {
    try {
      const result = await api.testGithubConnection(draft.repoOwner.trim(), draft.repoName.trim());
      if (!result.ok) setError(result.error || 'GitHub connection test failed.');
      else
        Alert.alert(
          'GitHub connected',
          `${result.repoInfo?.full_name || 'Repository is accessible.'}`,
        );
    } catch (err: any) {
      setError(err?.message || 'GitHub connection test failed.');
    }
  };

  const openCreatedProject = useCallback(
    (project: any) => {
      refreshProjects?.();
      refreshAgents?.();
      navigation.navigate('Kanban', { projectId: project.id, project });
    },
    [navigation, refreshAgents, refreshProjects],
  );

  const createProject = async () => {
    setCreating(true);
    setError(null);
    setPendingPreviewSave(null);
    if (!canContinueImport(draft)) {
      setError(
        'Complete the review, including the agent and preview choices, before creating the project.',
      );
      setCreating(false);
      return;
    }
    try {
      const project = await api.onboardProject(buildImportOnboardPayload(draft));
      const patch = buildImportPreviewPatch(draft.previewDecision);
      if (patch && project?.id) {
        try {
          await api.updateProject(project.id, patch);
        } catch (err: any) {
          setPendingPreviewSave({ project, patch });
          setError(
            `Project created, but preview settings could not be saved. Retry below${
              err?.message ? `: ${err.message}` : '.'
            }`,
          );
          return;
        }
      }
      openCreatedProject(project);
    } catch (err: any) {
      setError(err?.message || 'Project creation failed.');
    } finally {
      setCreating(false);
    }
  };

  const retryPreviewSave = async () => {
    if (!pendingPreviewSave) return;
    setCreating(true);
    setError(null);
    try {
      await api.updateProject(pendingPreviewSave.project.id, pendingPreviewSave.patch);
      const project = pendingPreviewSave.project;
      setPendingPreviewSave(null);
      openCreatedProject(project);
    } catch (err: any) {
      setError(err?.message || 'Preview settings could not be saved. Retry again.');
    } finally {
      setCreating(false);
    }
  };

  const next = () => {
    if (!canContinueImport(draft)) return;
    setDraft((current) => advanceImportStep(current));
  };

  const back = () => {
    if (draft.step === 0) navigation.goBack();
    else setDraft((current) => goBackImportStep(current));
  };

  const step = IMPORT_STEP_IDS[draft.step];
  const canNext = canContinueImport(draft);
  const continueFromSource = () => {
    if (draft.sourceMode === 'local') void analyze();
    else if (cloneReady) void analyze();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={back} style={styles.backButton} testID="import-back">
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Import existing project</Text>
        <Text style={styles.counter}>
          Step {draft.step + 1} of {IMPORT_STEP_IDS.length}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stepStrip}
      >
        {IMPORT_STEP_IDS.map((id, index) => (
          <View key={id} style={[styles.stepPill, index === draft.step && styles.stepPillActive]}>
            <Text style={styles.stepText}>
              {index < draft.step ? '✓ ' : `${index + 1} `}
              {id}
            </Text>
          </View>
        ))}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 'source' ? (
          <SourceStep
            draft={draft}
            update={updateDraft}
            onSourceModeChange={changeSourceMode}
            onLocalPathChange={changeLocalPath}
            onCloneSourceChange={changeCloneSource}
            cloning={cloning}
            cloneReady={cloneReady}
            cloneLog={cloneLog}
            onClone={startClone}
            onNameEdited={() => setNameEdited(true)}
          />
        ) : null}
        {step === 'analyze' ? (
          <AnalyzeStep
            draft={draft}
            analyzing={analyzing}
            progressLog={progressLog}
            analysisOptions={analysisOptions}
            onAnalysisConfigChange={changeAnalysisConfig}
            onAnalyze={() => void analyze()}
          />
        ) : null}
        {step === 'github' ? (
          <GithubStep
            draft={draft}
            update={updateDraft}
            loading={githubLoading}
            connecting={githubConnecting}
            status={githubStatus}
            repoInfo={repoInfo}
            onConnect={connectGithub}
            onTest={testGithub}
          />
        ) : null}
        {step === 'review' ? (
          <ReviewStep draft={draft} update={updateDraft} onIdEdited={() => setIdEdited(true)} />
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        {step === 'source' && draft.sourceMode === 'clone' && !cloneReady ? null : (
          <Button
            label={
              step === 'review'
                ? creating
                  ? pendingPreviewSave
                    ? 'Saving preview…'
                    : 'Creating…'
                  : pendingPreviewSave
                    ? 'Retry preview & open project'
                    : 'Create Project'
                : 'Continue'
            }
            onPress={
              step === 'review'
                ? pendingPreviewSave
                  ? retryPreviewSave
                  : createProject
                : step === 'source'
                  ? continueFromSource
                  : next
            }
            disabled={
              step === 'review'
                ? creating || (!pendingPreviewSave && !canNext)
                : !canNext || analyzing || cloning
            }
            testID={step === 'review' ? 'import-create' : 'import-continue'}
          />
        )}
        {step === 'github' ? (
          <Button
            label="Skip GitHub"
            secondary
            onPress={() => updateDraft({ skipGitHub: true, step: 3 })}
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function SourceStep({
  draft,
  update,
  onSourceModeChange,
  onLocalPathChange,
  onCloneSourceChange,
  cloning,
  cloneReady,
  cloneLog,
  onClone,
  onNameEdited,
}: any) {
  return (
    <View>
      <Title
        title="Select a project source"
        subtitle="The path is resolved on the connected Agent Hub server."
      />
      <View style={styles.segment}>
        {(['local', 'clone'] as const).map((mode) => (
          <TouchableOpacity
            key={mode}
            testID={`import-source-${mode}`}
            style={[styles.segmentButton, draft.sourceMode === mode && styles.segmentSelected]}
            onPress={() => onSourceModeChange(mode)}
          >
            <Text style={styles.segmentText}>
              {mode === 'local' ? 'Local directory' : 'Clone from GitHub'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {draft.sourceMode === 'local' ? (
        <Field label="Project path">
          <TextInput
            style={styles.input}
            value={draft.path}
            onChangeText={onLocalPathChange}
            placeholder="/path/to/project"
            placeholderTextColor={colors.gray600}
            autoCapitalize="none"
            testID="import-path"
          />
        </Field>
      ) : (
        <>
          <Field label="Repository URL">
            <TextInput
              style={styles.input}
              value={draft.cloneUrl}
              onChangeText={(cloneUrl) =>
                onCloneSourceChange({ cloneUrl, cloneTarget: draft.cloneTarget })
              }
              placeholder="https://github.com/org/repo.git"
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
              keyboardType="url"
              testID="import-clone-url"
            />
          </Field>
          <Field label="Clone into (optional)">
            <TextInput
              style={styles.input}
              value={draft.cloneTarget}
              onChangeText={(cloneTarget) =>
                onCloneSourceChange({ cloneUrl: draft.cloneUrl, cloneTarget })
              }
              placeholder="~/projects"
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
              testID="import-clone-target"
            />
          </Field>
          {cloneReady ? (
            <Text style={styles.summaryTitle}>Clone complete. Tap Continue to analyze.</Text>
          ) : (
            <Button
              label={cloning ? 'Cloning…' : 'Clone repository'}
              onPress={onClone}
              disabled={!draft.cloneUrl.trim() || cloning}
              testID="import-clone"
            />
          )}
          {cloneLog?.length ? (
            <View style={styles.progress}>
              {cloneLog.slice(-6).map((line: string, index: number) => (
                <Text key={`${line}-${index}`} style={styles.log}>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      )}
      <Text style={styles.sectionLabel}>Project identity</Text>
      <Field label="Name">
        <TextInput
          style={styles.input}
          value={draft.name}
          onChangeText={(name) => {
            onNameEdited();
            update({ name });
          }}
          placeholder="Project name"
          placeholderTextColor={colors.gray600}
        />
      </Field>
      <Text style={styles.hint}>
        The name is inferred from the source and can be edited before review.
      </Text>
    </View>
  );
}

function AnalyzeStep({
  draft,
  analyzing,
  progressLog,
  analysisOptions,
  onAnalysisConfigChange,
  onAnalyze,
}: any) {
  const result: ImportAnalysisResult | null = draft.analysisResult;
  return (
    <View>
      <Title
        title="Analyze the repository"
        subtitle="Agent Hub inspects the source and suggests agents, commands, context, and starter wiki pages."
      />
      <Field label="Analysis engine">
        <View style={styles.choiceList}>
          {analysisOptions.map((option: any) => (
            <Choice
              key={option.engine}
              testID={`import-analysis-engine-${option.engine}`}
              label={ENGINE_LABELS[option.engine] || option.engine}
              selected={draft.analysisEngine === option.engine}
              onPress={() =>
                onAnalysisConfigChange({
                  analysisEngine: option.engine,
                  analysisModel: option.models[0],
                })
              }
            />
          ))}
        </View>
      </Field>
      {draft.analysisEngine &&
      analysisOptions.find((option: any) => option.engine === draft.analysisEngine)?.models
        ?.length ? (
        <Field label="Analysis model">
          <View style={styles.choiceList}>
            {analysisOptions
              .find((option: any) => option.engine === draft.analysisEngine)
              .models.map((model: string) => (
                <Choice
                  key={model}
                  testID={`import-analysis-model-${model}`}
                  label={model}
                  selected={draft.analysisModel === model}
                  onPress={() =>
                    onAnalysisConfigChange({
                      analysisEngine: draft.analysisEngine,
                      analysisModel: model,
                    })
                  }
                />
              ))}
          </View>
        </Field>
      ) : null}
      {analyzing ? (
        <View style={styles.progress}>
          <ActivityIndicator color={colors.emerald400} />
          <Text style={styles.muted}>Analyzing…</Text>
          {progressLog.slice(-8).map((line: string, index: number) => (
            <Text key={`${line}-${index}`} style={styles.log}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {result ? (
        <View style={styles.summary}>
          <Text style={styles.summaryTitle}>Analysis ready</Text>
          <Text style={styles.muted}>
            {result.agents?.length || 0} suggested agent(s),{' '}
            {Array.isArray(result.wikiPages) ? result.wikiPages.length : 0} starter wiki page(s).
          </Text>
        </View>
      ) : null}
      {!analyzing ? (
        <Button
          label={result ? 'Re-analyze' : 'Start analysis'}
          onPress={onAnalyze}
          disabled={!draft.path.trim()}
          testID="import-analyze"
        />
      ) : null}
    </View>
  );
}

function GithubStep({
  draft,
  update,
  loading,
  connecting,
  status,
  repoInfo,
  onConnect,
  onTest,
}: any) {
  return (
    <View>
      <Title
        title="Connect GitHub (optional)"
        subtitle="Link the imported repository so Agent Hub can manage PRs and repository automation."
      />
      {loading ? (
        <ActivityIndicator color={colors.emerald400} />
      ) : (
        <View style={styles.summary}>
          <Text style={styles.summaryTitle}>
            {status?.authenticated
              ? `Connected as ${status.user || 'GitHub user'}`
              : 'GitHub is not connected'}
          </Text>
          {status?.source ? <Text style={styles.muted}>Source: {status.source}</Text> : null}
        </View>
      )}
      {!status?.authenticated ? (
        <Button
          label={connecting ? 'Connecting…' : 'Sign in with GitHub'}
          onPress={onConnect}
          disabled={connecting || loading}
        />
      ) : null}
      {status?.authenticated ? (
        <>
          <Text style={styles.hint}>
            {repoInfo?.url
              ? `Detected remote: ${repoInfo.url}`
              : 'Enter the repository owner and name.'}
          </Text>
          <Field label="Owner">
            <TextInput
              style={styles.input}
              value={draft.repoOwner}
              onChangeText={(repoOwner) => update({ repoOwner, skipGitHub: false })}
              placeholder="org-or-user"
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
            />
          </Field>
          <Field label="Repository">
            <TextInput
              style={styles.input}
              value={draft.repoName}
              onChangeText={(repoName) => update({ repoName, skipGitHub: false })}
              placeholder="repo-name"
              placeholderTextColor={colors.gray600}
              autoCapitalize="none"
            />
          </Field>
          <Button
            label="Test connection"
            secondary
            onPress={onTest}
            disabled={!draft.repoOwner.trim() || !draft.repoName.trim()}
          />
        </>
      ) : null}
    </View>
  );
}

function ReviewStep({ draft, update, onIdEdited }: any) {
  const agents = draft.analysisResult?.agents || [];
  const hasSelectedAgent = agents.some(
    (_agent: any, index: number) => draft.selectedAgents[String(index)] !== false,
  );
  return (
    <View>
      <Title
        title="Review and create"
        subtitle="Confirm the project details and the analysis output before it is persisted."
      />
      <Field label="Project name">
        <TextInput
          style={styles.input}
          value={draft.name}
          onChangeText={(name) => update({ name })}
        />
      </Field>
      <Field label="Project id">
        <TextInput
          style={styles.input}
          value={draft.projectId}
          onChangeText={(projectId) => {
            onIdEdited();
            update({ projectId });
          }}
          autoCapitalize="none"
        />
      </Field>
      <Text style={styles.fieldLabel}>Accent color</Text>
      <View style={styles.colorRow}>
        {COLORS.map((color) => (
          <TouchableOpacity
            key={color}
            onPress={() => update({ color })}
            style={[
              styles.color,
              { backgroundColor: color },
              draft.color === color && styles.colorSelected,
            ]}
          />
        ))}
      </View>
      {agents.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Agent team</Text>
          {agents.map((agent: any, index: number) => (
            <Choice
              key={agent.id || index}
              label={agent.name || agent.id || `Agent ${index + 1}`}
              selected={draft.selectedAgents[String(index)] !== false}
              onPress={() =>
                update({
                  selectedAgents: {
                    ...draft.selectedAgents,
                    [String(index)]: draft.selectedAgents[String(index)] === false,
                  },
                })
              }
            />
          ))}
          {!hasSelectedAgent ? (
            <Text style={styles.error}>Select at least one agent before creating the project.</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.error}>Analysis returned no agents. Go back and retry analysis.</Text>
      )}
      <Text style={styles.sectionLabel}>Context files</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {CONTEXT_FILES.map((file) => (
          <TouchableOpacity
            key={file}
            onPress={() => update({ activeContextFile: file })}
            style={[styles.fileTab, draft.activeContextFile === file && styles.fileTabActive]}
          >
            <Text style={styles.fileTabText}>{file}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <TextInput
        style={[styles.input, styles.multiline]}
        multiline
        value={draft.contextFiles[draft.activeContextFile] || ''}
        onChangeText={(content) =>
          update({ contextFiles: { ...draft.contextFiles, [draft.activeContextFile]: content } })
        }
        placeholder={`Suggested ${draft.activeContextFile} content`}
        placeholderTextColor={colors.gray600}
      />
      <Text style={styles.sectionLabel}>Starter wiki pages</Text>
      {draft.wikiPages.map((page: any, index: number) => (
        <View key={`${page.title}-${index}`} style={styles.wikiCard}>
          <TextInput
            style={styles.input}
            value={page.title}
            onChangeText={(title) =>
              update({
                wikiPages: draft.wikiPages.map((current: any, i: number) =>
                  i === index ? { ...current, title } : current,
                ),
              })
            }
          />
          <TextInput
            style={[styles.input, styles.multiline]}
            multiline
            value={page.content}
            onChangeText={(content) =>
              update({
                wikiPages: draft.wikiPages.map((current: any, i: number) =>
                  i === index ? { ...current, content } : current,
                ),
              })
            }
          />
        </View>
      ))}
      {draft.detectedPreview && !draft.previewDecision ? (
        <View style={styles.preview}>
          <Text style={styles.summaryTitle}>Detected preview defaults</Text>
          <Text style={styles.muted}>
            {(draft.detectedPreview.stack as string) || 'Web'} ·{' '}
            {(draft.detectedPreview.startScript as string) || 'npm run dev'}
          </Text>
          <View style={styles.inlineButtons}>
            <Button
              label="Use defaults"
              onPress={() =>
                update({
                  previewDecision: {
                    enabled: true,
                    startScript: draft.detectedPreview?.startScript as string,
                    port: draft.detectedPreview?.port as number,
                    captureRoutes: draft.detectedPreview?.captureRoutes as string[],
                    idleTTL: draft.detectedPreview?.idleTTL as number,
                  },
                })
              }
            />
            <Button
              label="Skip preview"
              secondary
              onPress={() => update({ previewDecision: { enabled: false } })}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Title({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}
function Choice({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      testID={testID}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <Text style={styles.choiceText}>{label}</Text>
      <Text style={styles.check}>{selected ? '✓' : ''}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    gap: 8,
  },
  backButton: { paddingVertical: 4, paddingRight: 4 },
  backText: { color: colors.gray300, fontSize: 14 },
  headerTitle: { flex: 1, color: colors.white, fontSize: 17, fontWeight: '600' },
  counter: { color: colors.gray500, fontSize: 11 },
  stepStrip: { gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  stepPill: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stepPillActive: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  stepText: { color: colors.gray400, fontSize: 11 },
  body: { padding: 16, paddingBottom: 30 },
  footer: { padding: 12, borderTopWidth: 1, borderTopColor: colors.gray800, gap: 8 },
  titleBlock: { marginBottom: 18 },
  title: { color: colors.white, fontSize: 22, fontWeight: '700', marginBottom: 6 },
  subtitle: { color: colors.gray400, fontSize: 13, lineHeight: 19 },
  segment: { flexDirection: 'row', gap: 6, marginBottom: 18 },
  segmentButton: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 11,
  },
  segmentSelected: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  segmentText: { color: colors.gray200, textAlign: 'center', fontSize: 12 },
  field: { marginBottom: 14 },
  fieldLabel: { color: colors.gray300, fontSize: 12, marginBottom: 6 },
  input: {
    color: colors.white,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 10,
    fontSize: 14,
  },
  multiline: { minHeight: 110, textAlignVertical: 'top', marginTop: 10 },
  hint: { color: colors.gray500, fontSize: 11, lineHeight: 16, marginBottom: 12 },
  sectionLabel: {
    color: colors.gray300,
    fontWeight: '600',
    fontSize: 14,
    marginTop: 18,
    marginBottom: 9,
  },
  button: {
    backgroundColor: colors.emerald600,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryButton: { backgroundColor: colors.gray700 },
  buttonText: { color: colors.white, fontSize: 14, fontWeight: '600' },
  secondaryButtonText: { color: colors.gray200 },
  disabled: { opacity: 0.45 },
  error: {
    color: colors.red400,
    backgroundColor: colors.red900_50,
    borderRadius: 7,
    padding: 10,
    marginBottom: 12,
    fontSize: 12,
  },
  progress: {
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 12,
    gap: 7,
    marginTop: 12,
  },
  muted: { color: colors.gray400, fontSize: 12 },
  log: { color: colors.gray500, fontFamily: 'monospace', fontSize: 11 },
  summary: {
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  summaryTitle: { color: colors.emerald400, fontSize: 14, fontWeight: '600', marginBottom: 5 },
  choiceList: { gap: 6 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    padding: 11,
    marginBottom: 7,
  },
  choiceSelected: { borderColor: colors.emerald500, backgroundColor: colors.emerald900_40 },
  choiceText: { color: colors.gray200, fontSize: 13 },
  check: { color: colors.emerald400, fontWeight: '700', width: 18, textAlign: 'center' },
  colorRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  color: { width: 28, height: 28, borderRadius: 14 },
  colorSelected: { borderWidth: 3, borderColor: colors.white },
  fileTab: {
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 7,
    marginRight: 6,
  },
  fileTabActive: { backgroundColor: colors.indigo700 },
  fileTabText: { color: colors.gray300, fontSize: 11 },
  wikiCard: { gap: 4, marginBottom: 10 },
  preview: {
    backgroundColor: colors.sky500_15,
    borderColor: colors.sky400,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
  },
  inlineButtons: { gap: 8, marginTop: 10 },
});
