import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OpenProjectWizard, { NEW_PROJECT_WIZARD_DRAFT_KEY } from './OpenProjectWizard';

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

function ok(body: any) {
  return { ok: true, status: 200, json: async () => body };
}

function seedWizardAtReviewStep() {
  sessionStorage.setItem(
    NEW_PROJECT_WIZARD_DRAFT_KEY,
    JSON.stringify({
      v: 1,
      step: 4,
      sourceMode: 'local',
      path: '/tmp/wiki-project',
      name: 'Wiki Project',
      projectId: 'wiki-project',
      color: '#10B981',
      nameManuallyEdited: false,
      idManuallyEdited: false,
      cloneUrl: '',
      cloneTarget: '',
      skipGitHub: true,
      repoOwner: '',
      repoName: '',
      selectedAgents: { 0: true },
      contextFiles: { 'SOUL.md': '# Soul' },
      activeTab: 'SOUL.md',
      wikiPages: [
        {
          title: 'Architecture',
          category: 'architecture',
          content: '# Architecture\n\nInitial content.',
        },
      ],
      activeWikiIndex: 0,
      analysisResult: {
        agents: [
          {
            id: 'wiki-project-dev',
            name: 'Wiki Project Dev',
            role: 'dev',
            engine: 'claude-code',
            systemPrompt: 'You own Wiki Project.',
          },
        ],
        commands: { install: 'npm ci', build: null, test: 'npm test', lint: null },
      },
      ghStatus: null,
      repoInfo: null,
      testResult: null,
      progressText: '',
      progressLog: [],
      cloneLog: [],
    }),
  );
}

describe('OpenProjectWizard wiki intake review', () => {
  let fetchMock: any;

  beforeEach(() => {
    seedWizardAtReviewStep();
    fetchMock = vi.fn().mockResolvedValue(ok({ id: 'wiki-project' }));
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  it('lets users edit generated wiki pages before sending the onboard payload', async () => {
    render(<OpenProjectWizard onClose={() => {}} onProjectCreated={() => {}} />);

    fireEvent.change(await screen.findByPlaceholderText('Wiki page title'), {
      target: { value: 'System Map' },
    });
    fireEvent.change(screen.getByDisplayValue('Architecture'), {
      target: { value: 'conventions' },
    });
    fireEvent.change(screen.getByPlaceholderText('Markdown content for this wiki page...'), {
      target: { value: '# System Map\n\nUse `src/App.tsx` for routing.' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/onboard');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.wikiPages).toEqual([
      {
        title: 'System Map',
        category: 'conventions',
        content: '# System Map\n\nUse `src/App.tsx` for routing.',
      },
    ]);
  });
});
