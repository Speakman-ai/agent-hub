import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { CronSection } from './SettingsPage';
import { api } from '../utils/api';

/**
 * UI parity for non-Claude cron engines (Codex / Cursor / Gemini).
 *
 * The cron backend has supported a per-row `engine` column since
 * card `70b5ac8c`, but the UI was still hardcoded to `claude-code`'s
 * model allowlist — every cron silently fell back to Claude even when
 * the operator's project was running on Codex / Cursor / Gemini.
 *
 * These tests pin the new behaviour:
 *   1. The engine dropdown renders every configured engine from
 *      `engineValidModels` (so a future backend addition appears
 *      automatically without a client redeploy).
 *   2. Switching engine clears the stale model value so we never
 *      POST a Claude id under a Cursor engine (and vice-versa).
 *   3. Editing an existing codex-cli cron round-trips through PUT —
 *      the engine + model values come back through `api.updateCron`
 *      verbatim, and the row's `Engine: codex-cli` summary updates.
 */

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getCrons: vi.fn(),
    getCronLogs: vi.fn(),
    getModelConfig: vi.fn(),
    createCron: vi.fn(),
    updateCron: vi.fn(),
    deleteCron: vi.fn(),
    runCron: vi.fn(),
  },
}));

const MULTI_ENGINE_MODEL_CONFIG = {
  defaultModel: 'claude-opus-4-8',
  engineDefaultModels: {
    'claude-code': 'claude-opus-4-8',
    'cursor-agent': 'cursor-default',
    'gemini-cli': 'gemini-2.5-pro',
    'codex-cli': 'gpt-5-codex',
  },
  engineValidModels: {
    'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-5'],
    'cursor-agent': ['cursor-default', 'cursor-fast'],
    'gemini-cli': ['gemini-2.5-pro', 'gemini-2.5-flash'],
    'codex-cli': ['gpt-5-codex', 'gpt-5'],
  },
} as Record<string, any>;

const PROJECTS_FIXTURE = [
  {
    id: 'proj-a',
    name: 'Project A',
    cwd: '/tmp/proj-a',
    color: '#888',
    agents: [{ id: 'agent-a', engine: 'claude-code', name: 'A' }],
  },
];

describe('CronSection — engine picker', () => {
  beforeEach(() => {
    (api.getCrons as any).mockResolvedValue([]);
    (api.getCronLogs as any).mockResolvedValue([]);
    (api.getModelConfig as any).mockResolvedValue(MULTI_ENGINE_MODEL_CONFIG);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an Engine dropdown sourced from engineValidModels keys', async () => {
    const { findByTestId } = render(<CronSection projects={PROJECTS_FIXTURE} />);
    // The "+ New Cron" button is the first button rendered by the
    // section header — easier to grab by text than by selector chain.
    const newButton = await waitFor(() => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x: any) => (x as any).textContent?.trim() === '+ New Cron',
      );
      if (!b) throw new Error('+ New Cron button not mounted yet');
      return b;
    });
    fireEvent.click(newButton as any);

    const engineSelect = await findByTestId('cron-engine-select');
    const options = Array.from(engineSelect.querySelectorAll('option')).map(
      (o: any) => (o as any).value,
    );
    // Blank ("default") leads, then every configured engine.
    expect(options[0]).toBe('');
    expect(options!).toEqual(
      expect.arrayContaining(['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli']),
    );
  });

  it('switching engine resets the model to the empty (= engine default) option', async () => {
    const { findByTestId } = render(<CronSection projects={PROJECTS_FIXTURE} />);
    const newBtn = await waitFor(() => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x: any) => (x as any).textContent?.trim() === '+ New Cron',
      );
      if (!b) throw new Error('+ New Cron button not mounted yet');
      return b;
    });
    fireEvent.click(newBtn as any);

    const engineSelect = await findByTestId('cron-engine-select');
    const modelSelect = await findByTestId('cron-model-select');

    // Pick a non-default Claude model first.
    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-4-5' } } as any);
    expect((modelSelect as any).value).toBe('claude-sonnet-4-5');

    // Flip to codex-cli — the model dropdown re-sources from the codex
    // allowlist (so `claude-sonnet-4-5` is no longer a valid option) and
    // the selected value resets to the empty "Default" entry.
    fireEvent.change(engineSelect, { target: { value: 'codex-cli' } } as any);
    expect((engineSelect as any).value).toBe('codex-cli');

    const refetchedModel = await findByTestId('cron-model-select');
    expect((refetchedModel as any).value).toBe('');
    const modelOptions = Array.from(refetchedModel.querySelectorAll('option')).map(
      (o: any) => (o as any).value,
    );
    expect(modelOptions!).toEqual(expect.arrayContaining(['', 'gpt-5-codex', 'gpt-5']));
    expect(modelOptions!).not.toContain('claude-sonnet-4-5');
  });

  it('round-trips engine=codex-cli + a codex model through PUT /api/crons/:id', async () => {
    const existingCron = {
      id: 42,
      name: 'Nightly codex report',
      schedule: '0 3 * * *',
      prompt: 'Audit the codebase.',
      cwd: '/tmp/proj-a',
      project_id: 'proj-a',
      enabled: 1,
      timeout_ms: null,
      notify_on_run: 0,
      model: 'gpt-5-codex',
      engine: 'codex-cli',
      skill_principal_agent_id: null,
      last_run: null,
      next_run_at: null,
    };
    (api.getCrons as any).mockResolvedValueOnce([existingCron]);
    (api.updateCron as any).mockImplementation(async (_id: any, payload: any) => ({
      ...existingCron,
      ...payload,
    }));

    const { findByTestId, findByText } = render(<CronSection projects={PROJECTS_FIXTURE} />);

    // The render summarises the row with "Engine: codex-cli" so the
    // operator can see the engine without opening the edit form.
    await findByText(/Engine: codex-cli/);

    // Open the edit form — the Edit button is icon-only with title="Edit".
    const editBtn = await waitFor(() => {
      const b = document.querySelector('button[title="Edit"]');
      if (!b) throw new Error('Edit button not mounted yet');
      return b;
    });
    fireEvent.click(editBtn as any);

    const engineSelect = await findByTestId('cron-engine-select-edit');
    expect((engineSelect as any).value).toBe('codex-cli');

    const modelSelect = await findByTestId('cron-model-select-edit');
    expect((modelSelect as any).value).toBe('gpt-5-codex');

    // Bump to gpt-5 and save.
    fireEvent.change(modelSelect, { target: { value: 'gpt-5' } } as any);
    const saveBtn = await waitFor(() => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x: any) => (x as any).textContent?.trim() === 'Save',
      );
      if (!b) throw new Error('Save button not mounted yet');
      return b;
    });
    await act(async () => {
      fireEvent.click(saveBtn as any);
    });

    await waitFor(() => {
      expect(api.updateCron).toHaveBeenCalledTimes(1);
    });
    const [id, payload] = (api.updateCron as any).mock.calls[0];
    expect(id!).toBe(42);
    expect(payload.engine).toBe('codex-cli');
    expect(payload.model).toBe('gpt-5');
    // The helper-text scratchpad must NOT leak into the PUT — the server's
    // present-key tristate would treat it as an intentional clear.
    expect(payload!).not.toHaveProperty('skill_principal_agent_id');
  });
});
