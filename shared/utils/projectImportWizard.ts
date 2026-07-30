export const IMPORT_STEP_IDS = ['source', 'analyze', 'github', 'review'] as const;

export type ImportStepId = (typeof IMPORT_STEP_IDS)[number];
export type ImportSourceMode = 'local' | 'clone';

export const IMPORT_WIKI_CATEGORIES = [
  'architecture',
  'conventions',
  'test-patterns',
  'troubleshooting',
  'onboarding',
  'api-docs',
  'general',
] as const;

export type ImportWikiCategory = (typeof IMPORT_WIKI_CATEGORIES)[number];

export type ImportWizardDraft = {
  step: number;
  sourceMode: ImportSourceMode;
  path: string;
  name: string;
  projectId: string;
  color: string;
  cloneUrl: string;
  cloneTarget: string;
  skipGitHub: boolean;
  repoOwner: string;
  repoName: string;
  selectedAgents: Record<string, boolean>;
  contextFiles: Record<string, string>;
  activeContextFile: string;
  wikiPages: ImportWikiPage[];
  activeWikiIndex: number;
  analysisResult: ImportAnalysisResult | null;
  analysisEngine: string;
  analysisModel: string;
  previewDecision: ImportPreviewDecision | null;
  detectedPreview?: Record<string, unknown> | null;
};

export type ImportWikiPage = {
  title: string;
  category: ImportWikiCategory;
  content: string;
};

export type ImportAnalysisResult = {
  agents?: Array<Record<string, unknown>>;
  suggestedAgents?: Array<Record<string, unknown>>;
  contextFiles?: Record<string, string>;
  wikiPages?: unknown;
  commands?: Record<string, string | null> | null;
  [key: string]: unknown;
};

export type ImportPreviewDecision = {
  enabled: boolean;
  startScript?: string;
  port?: number | null;
  captureRoutes?: string[];
  idleTTL?: number | string;
};

export type ImportOperationIds = {
  cloneId?: string | null;
  analyzeId?: string | null;
};

export type ImportEvent = ImportOperationIds & {
  type?: string;
  importEventId?: number;
  [key: string]: unknown;
};

export type CloneSource = {
  url: string;
  target: string;
};

/** True when a clone response still belongs to the active request and source. */
export function cloneRequestMatches(
  requestGeneration: number,
  currentGeneration: number,
  requestSource: CloneSource,
  currentSource: CloneSource | null,
): boolean {
  return (
    requestGeneration === currentGeneration &&
    currentSource !== null &&
    !cloneSourceChanged(requestSource, currentSource)
  );
}

/** True when an import event belongs to the currently-started operation. */
export function importEventMatchesOperation(
  event: ImportEvent,
  operation: ImportOperationIds,
): boolean {
  return Boolean(
    (event.cloneId && event.cloneId === operation.cloneId) ||
    (event.analyzeId && event.analyzeId === operation.analyzeId),
  );
}

/** Keep enough history to replay events received before a start response settles. */
export function appendImportEvent<T>(events: T[], event: T, max = 50): T[] {
  const limit = Math.max(1, Math.floor(max));
  return [...events.slice(-(limit - 1)), event];
}

export function cloneSourceChanged(completed: CloneSource, current: CloneSource): boolean {
  return completed.url !== current.url || completed.target !== current.target;
}

/** Clear source-derived state before switching between local and clone modes. */
export function resetImportSourceDraft(
  draft: ImportWizardDraft,
  sourceMode: ImportSourceMode,
): ImportWizardDraft {
  return {
    ...draft,
    sourceMode,
    path: '',
    detectedPreview: null,
    previewDecision: null,
    analysisResult: null,
    selectedAgents: {},
    contextFiles: {},
    wikiPages: [],
  };
}

export function deriveProjectNameFromPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path.split(/[\\/]/).filter(Boolean).pop() || '';
}

export function deriveProjectNameFromCloneUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const withoutGit = url.trim().replace(/\.git(?:[?#].*)?$/, '');
  return (
    withoutGit
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/, '') || ''
  );
}

export function deriveProjectId(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeImportWikiPages(pages: unknown): ImportWikiPage[] {
  if (!Array.isArray(pages)) return [];
  return pages
    .map((page): ImportWikiPage | null => {
      if (!page || typeof page !== 'object') return null;
      const value = page as Record<string, unknown>;
      const title = typeof value.title === 'string' ? value.title.trim() : '';
      if (!title) return null;
      const category = IMPORT_WIKI_CATEGORIES.includes(value.category as ImportWikiCategory)
        ? (value.category as ImportWikiCategory)
        : 'onboarding';
      return {
        title,
        category,
        content: typeof value.content === 'string' ? value.content : '',
      };
    })
    .filter((page): page is ImportWikiPage => page !== null);
}

export function normalizeImportAnalysisResult(result: unknown): ImportAnalysisResult {
  const value = result && typeof result === 'object' ? (result as ImportAnalysisResult) : {};
  const agents = Array.isArray(value.agents)
    ? value.agents
    : Array.isArray(value.suggestedAgents)
      ? value.suggestedAgents
      : [];
  return {
    ...value,
    agents,
    wikiPages: normalizeImportWikiPages(value.wikiPages),
  };
}

export function initialImportDraft(): ImportWizardDraft {
  return {
    step: 0,
    sourceMode: 'local',
    path: '',
    name: '',
    projectId: '',
    color: '#6366F1',
    cloneUrl: '',
    cloneTarget: '',
    skipGitHub: false,
    repoOwner: '',
    repoName: '',
    selectedAgents: {},
    contextFiles: {},
    activeContextFile: 'SOUL.md',
    wikiPages: [],
    activeWikiIndex: 0,
    analysisResult: null,
    analysisEngine: '',
    analysisModel: '',
    previewDecision: null,
  };
}

export function currentImportStep(draft: Pick<ImportWizardDraft, 'step'>): ImportStepId {
  return IMPORT_STEP_IDS[draft.step] || IMPORT_STEP_IDS[0];
}

export function canContinueImport(draft: ImportWizardDraft): boolean {
  switch (currentImportStep(draft)) {
    case 'source':
      return draft.sourceMode === 'clone'
        ? draft.cloneUrl.trim().length > 0
        : draft.path.trim().length > 0;
    case 'analyze':
      return draft.analysisResult !== null;
    case 'github':
      return (
        draft.skipGitHub || (draft.repoOwner.trim().length > 0 && draft.repoName.trim().length > 0)
      );
    case 'review': {
      const agents = draft.analysisResult?.agents;
      const hasSelectedAgent =
        Array.isArray(agents) &&
        agents.some((_agent, index) => draft.selectedAgents[String(index)] !== false);
      const previewDecisionRequired =
        draft.detectedPreview !== null &&
        draft.detectedPreview !== undefined &&
        draft.previewDecision === null;
      return (
        draft.projectId.trim().length > 0 &&
        draft.name.trim().length > 0 &&
        hasSelectedAgent &&
        !previewDecisionRequired
      );
    }
    default:
      return false;
  }
}

export function advanceImportStep(draft: ImportWizardDraft): ImportWizardDraft {
  return draft.step >= IMPORT_STEP_IDS.length - 1 ? draft : { ...draft, step: draft.step + 1 };
}

export function goBackImportStep(draft: ImportWizardDraft): ImportWizardDraft {
  return draft.step <= 0 ? draft : { ...draft, step: draft.step - 1 };
}

export function buildImportOnboardPayload(draft: ImportWizardDraft): Record<string, unknown> {
  const agents = (draft.analysisResult?.agents || []).filter(
    (_agent, index) => draft.selectedAgents[String(index)] !== false,
  );
  const payload: Record<string, unknown> = {
    project: {
      id: draft.projectId.trim(),
      name: draft.name.trim(),
      cwd: draft.path.trim(),
      color: draft.color,
      ...(draft.skipGitHub || !draft.repoOwner.trim() || !draft.repoName.trim()
        ? {}
        : { githubRepo: { owner: draft.repoOwner.trim(), repo: draft.repoName.trim() } }),
    },
    agents,
    contextFiles: draft.contextFiles,
    commands: draft.analysisResult?.commands || null,
    wikiPages: normalizeImportWikiPages(draft.wikiPages),
  };
  return payload;
}

export function buildImportPreviewPatch(
  decision: ImportPreviewDecision | null,
): Record<string, unknown> | null {
  if (!decision) return null;
  // A skipped preview is expressed as the absence of a dev-server block:
  // the config carries no on/off switch, so omitting it is what leaves the
  // project without a preview.
  if (!decision.enabled) return { prEnv: { enabled: false } };
  const devServer: Record<string, unknown> = {};
  if (decision.startScript?.trim()) devServer.startCommand = decision.startScript.trim();
  if (
    typeof decision.port === 'number' &&
    Number.isInteger(decision.port) &&
    decision.port >= 1 &&
    decision.port <= 65535
  ) {
    devServer.portMap = [{ internalPort: decision.port, label: 'web', primary: true }];
  }
  if (Array.isArray(decision.captureRoutes) && decision.captureRoutes.length > 0) {
    devServer.captureRoutes = decision.captureRoutes.map((route) => route.trim()).filter(Boolean);
  }
  if (decision.idleTTL !== '' && decision.idleTTL != null) {
    const ttl = Number(decision.idleTTL);
    if (Number.isInteger(ttl) && ttl > 0) devServer.idleTTL = Math.min(86400, Math.max(60, ttl));
  }
  return { prEnv: { enabled: false, devServer } };
}
