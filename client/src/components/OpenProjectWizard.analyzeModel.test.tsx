import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import OpenProjectWizard, { NEW_PROJECT_WIZARD_DRAFT_KEY } from './OpenProjectWizard';

(vi as any).mock('../utils/connection.js', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer test-jwt' }),
  getConnectionConfig: () => ({ mode: 'local' }),
}));

function ok(body: any) {
  return { ok: true, status: 200, json: async () => body };
}

describe('OpenProjectWizard analysis model selection', () => {
  let fetchMock: any;

  beforeEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    fetchMock = vi.fn().mockResolvedValue(ok({ analyzeId: 'analyze-123' }));
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    sessionStorage.removeItem(NEW_PROJECT_WIZARD_DRAFT_KEY);
    vi.restoreAllMocks();
  });

  function renderWizard() {
    render(
      <OpenProjectWizard
        onClose={() => {}}
        onProjectCreated={() => {}}
        modelConfig={{
          engineDefaultModels: {
            'claude-code': 'claude-opus-4-8',
            'codex-cli': 'gpt-5.5',
          },
          engineValidModels: {
            'claude-code': ['claude-opus-4-8'],
            'codex-cli': ['gpt-5.5', 'gpt-5.4'],
          },
        }}
      />,
    );
  }

  it('sends the selected engine and model when analyzing a local import', async () => {
    renderWizard();

    fireEvent.change(screen.getByPlaceholderText('/path/to/your/project'), {
      target: { value: '/tmp/example-project' },
    });
    fireEvent.change(screen.getByLabelText('Analysis Engine'), {
      target: { value: 'codex-cli' },
    });
    fireEvent.change(screen.getByLabelText('Analysis Model'), {
      target: { value: 'gpt-5.4' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Analyze Project/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/analyze');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      cwd: '/tmp/example-project',
      engine: 'codex-cli',
      model: 'gpt-5.4',
    });
  });

  it('sends the selected engine and model when analyzing a cloned GitHub import', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ cloneId: 'clone-123' }))
      .mockResolvedValueOnce(ok({ analyzeId: 'analyze-123' }));

    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /Clone from GitHub/i }));
    fireEvent.change(
      screen.getByPlaceholderText('https://github.com/org/repo or git@github.com:org/repo.git'),
      {
        target: { value: 'https://github.com/example/repo.git' },
      },
    );
    fireEvent.change(screen.getByLabelText('Analysis Engine'), {
      target: { value: 'codex-cli' },
    });
    fireEvent.change(screen.getByLabelText('Analysis Model'), {
      target: { value: 'gpt-5.4' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Clone Repository/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/clone');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('clone-ws', {
          detail: { type: 'clone-complete', cloneId: 'clone-123', path: '/tmp/cloned-repo' },
        }),
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: /Analyze Project/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/analyze');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      cwd: '/tmp/cloned-repo',
      engine: 'codex-cli',
      model: 'gpt-5.4',
    });
  });
});
