import { describe, expect, it } from 'vitest';
import {
  advanceImportStep,
  appendImportEvent,
  buildImportOnboardPayload,
  buildImportPreviewPatch,
  canContinueImport,
  cloneSourceChanged,
  cloneRequestMatches,
  deriveProjectId,
  deriveProjectNameFromCloneUrl,
  deriveProjectNameFromPath,
  initialImportDraft,
  importEventMatchesOperation,
  normalizeImportAnalysisResult,
  normalizeImportWikiPages,
  resetImportSourceDraft,
} from './projectImportWizard';

describe('projectImportWizard', () => {
  it('derives stable names and ids for local and cloned sources', () => {
    expect(deriveProjectNameFromPath('/workspaces/agent-hub/')).toBe('agent-hub');
    expect(deriveProjectNameFromPath('C:\\work\\agent-hub')).toBe('agent-hub');
    expect(deriveProjectNameFromCloneUrl('https://github.com/acme/tool.git')).toBe('tool');
    expect(deriveProjectId('My Project!')).toBe('my-project');
  });

  it('normalizes analysis output and accepts the legacy suggestedAgents field', () => {
    expect(
      normalizeImportAnalysisResult({
        suggestedAgents: [{ id: 'dev' }],
        wikiPages: [{ title: '  Setup  ', category: 'not-real', content: 42 }],
      }),
    ).toMatchObject({
      agents: [{ id: 'dev' }],
      wikiPages: [{ title: 'Setup', category: 'onboarding', content: '' }],
    });
    expect(normalizeImportWikiPages([null, { title: '' }, { title: 'Guide' }])).toEqual([
      { title: 'Guide', category: 'onboarding', content: '' },
    ]);
  });

  it('builds the reviewed onboard payload and preview patch', () => {
    let draft = initialImportDraft();
    draft = {
      ...draft,
      path: '/tmp/tool',
      name: 'Tool',
      projectId: 'tool',
      analysisResult: { agents: [{ id: 'one' }, { id: 'two' }], commands: { test: 'npm test' } },
      selectedAgents: { '0': true, '1': false },
      contextFiles: { 'AGENTS.md': 'rules' },
      repoOwner: 'acme',
      repoName: 'tool',
      wikiPages: [{ title: 'Guide', category: 'onboarding', content: 'hello' }],
    };
    expect(buildImportOnboardPayload(draft)).toEqual({
      project: {
        id: 'tool',
        name: 'Tool',
        cwd: '/tmp/tool',
        color: '#6366F1',
        githubRepo: { owner: 'acme', repo: 'tool' },
      },
      agents: [{ id: 'one' }],
      contextFiles: { 'AGENTS.md': 'rules' },
      commands: { test: 'npm test' },
      wikiPages: [{ title: 'Guide', category: 'onboarding', content: 'hello' }],
    });
    expect(
      buildImportPreviewPatch({ enabled: true, startScript: ' npm run dev ', idleTTL: 1 }),
    ).toEqual({
      prEnv: {
        enabled: false,
        preview: { enabled: true, startScript: 'npm run dev', idleTTL: 60 },
      },
    });
    expect(advanceImportStep(draft).step).toBe(1);
  });

  it('requires an analyzed and selected agent before project creation', () => {
    const reviewDraft = {
      ...initialImportDraft(),
      step: 3,
      name: 'Tool',
      projectId: 'tool',
    };
    expect(canContinueImport(reviewDraft)).toBe(false);
    expect(canContinueImport({ ...reviewDraft, analysisResult: { agents: [] } })).toBe(false);
    expect(
      canContinueImport({
        ...reviewDraft,
        analysisResult: { agents: [{ id: 'one' }] },
        selectedAgents: { '0': false },
      }),
    ).toBe(false);
    expect(
      canContinueImport({
        ...reviewDraft,
        analysisResult: { agents: [{ id: 'one' }] },
        selectedAgents: { '0': true },
      }),
    ).toBe(true);
    expect(
      canContinueImport({
        ...reviewDraft,
        analysisResult: { agents: [{ id: 'one' }] },
        selectedAgents: { '0': true },
        detectedPreview: { stack: 'vite' },
      }),
    ).toBe(false);
    expect(
      canContinueImport({
        ...reviewDraft,
        analysisResult: { agents: [{ id: 'one' }] },
        selectedAgents: { '0': true },
        detectedPreview: { stack: 'vite' },
        previewDecision: { enabled: false },
      }),
    ).toBe(true);
  });

  it('replays early operation events and invalidates stale clone sources', () => {
    const complete = { type: 'analyze-complete', analyzeId: 'a-1' };
    const buffered = appendImportEvent([], complete, 2);
    expect(importEventMatchesOperation(buffered[0], { analyzeId: 'a-1' })).toBe(true);
    expect(importEventMatchesOperation(buffered[0], { analyzeId: 'a-2' })).toBe(false);
    expect(appendImportEvent([1, 2], 3, 2)).toEqual([2, 3]);
    expect(
      cloneSourceChanged(
        { url: 'https://github.com/acme/tool.git', target: '~/projects' },
        { url: 'https://github.com/acme/other.git', target: '~/projects' },
      ),
    ).toBe(true);
    expect(
      cloneSourceChanged(
        { url: 'https://github.com/acme/tool.git', target: '~/projects' },
        { url: 'https://github.com/acme/tool.git', target: '~/projects' },
      ),
    ).toBe(false);
    const source = { url: 'https://github.com/acme/tool.git', target: '~/projects' };
    expect(cloneRequestMatches(2, 2, source, source)).toBe(true);
    expect(cloneRequestMatches(2, 3, source, source)).toBe(false);
    expect(
      cloneRequestMatches(2, 2, source, {
        url: 'https://github.com/acme/other.git',
        target: '~/projects',
      }),
    ).toBe(false);
  });

  it('clears source-derived state when switching import modes', () => {
    const draft = {
      ...initialImportDraft(),
      sourceMode: 'clone' as const,
      path: '/tmp/cloned-tool',
      detectedPreview: { stack: 'vite' },
      previewDecision: { enabled: true },
      analysisResult: { agents: [{ id: 'one' }] },
      selectedAgents: { '0': true },
      contextFiles: { 'AGENTS.md': 'rules' },
      wikiPages: [{ title: 'Guide', category: 'onboarding' as const, content: 'hello' }],
    };
    expect(resetImportSourceDraft(draft, 'local')).toMatchObject({
      sourceMode: 'local',
      path: '',
      detectedPreview: null,
      previewDecision: null,
      analysisResult: null,
      selectedAgents: {},
      contextFiles: {},
      wikiPages: [],
    });
  });
});
