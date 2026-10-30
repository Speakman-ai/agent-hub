import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const listQaEnvironments = vi.fn();
const createQaEnvironment = vi.fn();
const updateQaEnvironment = vi.fn();
const deleteQaEnvironment = vi.fn();
const setQaEnvironmentDefault = vi.fn();
const getQaSettings = vi.fn();
const updateQaSettings = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    listQaEnvironments: (...a: unknown[]) => listQaEnvironments(...a),
    createQaEnvironment: (...a: unknown[]) => createQaEnvironment(...a),
    updateQaEnvironment: (...a: unknown[]) => updateQaEnvironment(...a),
    deleteQaEnvironment: (...a: unknown[]) => deleteQaEnvironment(...a),
    setQaEnvironmentDefault: (...a: unknown[]) => setQaEnvironmentDefault(...a),
    getQaSettings: (...a: unknown[]) => getQaSettings(...a),
    updateQaSettings: (...a: unknown[]) => updateQaSettings(...a),
  },
}));

import QaEnvironmentsSettings from './QaEnvironmentsSettings';

const savedEnv = {
  id: 'env-1',
  projectId: 'proj',
  name: 'Staging',
  baseUrl: 'https://staging.example.com',
  notes: '',
  position: 0,
  createdAt: '',
  updatedAt: '',
  accounts: [
    {
      id: 'acc_1',
      label: 'Admin',
      username: 'a@x.com',
      password: '••••••••',
      hasPassword: true,
      notes: '',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getQaSettings.mockResolvedValue({ settings: { projectId: 'proj', autoQaDelayMinutes: 0 } });
});

describe('QaEnvironmentsSettings', () => {
  it('creates an environment with a test account', async () => {
    listQaEnvironments.mockResolvedValue({ environments: [] });
    createQaEnvironment.mockImplementation(async () => ({ environment: savedEnv }));
    render(<QaEnvironmentsSettings projectId="proj" onBack={() => undefined} />);
    await screen.findByTestId('qa-env-empty');
    fireEvent.click(screen.getByTestId('qa-env-add'));
    fireEvent.change(screen.getByPlaceholderText('Staging'), { target: { value: 'Staging' } });
    fireEvent.change(screen.getByLabelText('Account 1 label'), { target: { value: 'Admin' } });
    fireEvent.change(screen.getByLabelText('Account 1 username'), {
      target: { value: 'a@x.com' },
    });
    fireEvent.change(screen.getByLabelText('Account 1 password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('qa-env-save'));
    await waitFor(() => expect(createQaEnvironment).toHaveBeenCalled());
    expect(createQaEnvironment.mock.calls[0][1]).toEqual({
      name: 'Staging',
      baseUrl: '',
      notes: '',
      accounts: [{ label: 'Admin', username: 'a@x.com', password: 'pw', notes: '' }],
    });
  });

  it('keeps a saved password when editing other fields', async () => {
    listQaEnvironments.mockResolvedValue({ environments: [savedEnv] });
    updateQaEnvironment.mockResolvedValue({ environment: savedEnv });
    render(<QaEnvironmentsSettings projectId="proj" onBack={() => undefined} />);
    const notes = await screen.findByPlaceholderText(/Build or version/);
    fireEvent.change(notes, { target: { value: 'v2.5' } });
    fireEvent.click(screen.getByTestId('qa-env-save'));
    await waitFor(() => expect(updateQaEnvironment).toHaveBeenCalled());
    const [, id, input] = updateQaEnvironment.mock.calls[0];
    expect(id).toBe('env-1');
    expect(input.notes).toBe('v2.5');
    expect(input.accounts[0]).not.toHaveProperty('password');
  });

  it('locks edits while a save is in flight so none are dropped', async () => {
    listQaEnvironments.mockResolvedValue({ environments: [savedEnv] });
    let resolve!: (v: unknown) => void;
    updateQaEnvironment.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<QaEnvironmentsSettings projectId="proj" onBack={() => undefined} />);
    const notes = (await screen.findByPlaceholderText(/Build or version/)) as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: 'v2.5' } });
    fireEvent.click(screen.getByTestId('qa-env-save'));
    await waitFor(() => expect(updateQaEnvironment).toHaveBeenCalled());
    expect(notes.closest('fieldset')?.disabled).toBe(true);
    fireEvent.change(notes, { target: { value: 'typed during save' } });
    expect(notes.value).toBe('v2.5');
    resolve({ environment: { ...savedEnv, notes: 'v2.5' } });
    await waitFor(() => expect(notes.closest('fieldset')?.disabled).toBe(false));
    expect(notes.value).toBe('v2.5');
  });

  it('marks an environment as the default and unmarks the others', async () => {
    listQaEnvironments.mockResolvedValue({
      environments: [
        { ...savedEnv, isDefault: true },
        { ...savedEnv, id: 'env-2', name: 'Prod', isDefault: false },
      ],
    });
    setQaEnvironmentDefault.mockResolvedValue({ environment: savedEnv });
    render(<QaEnvironmentsSettings projectId="proj" onBack={() => undefined} />);
    const boxes = (await screen.findAllByTestId('qa-env-default')) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    fireEvent.click(boxes[1]);
    await waitFor(() =>
      expect(setQaEnvironmentDefault).toHaveBeenCalledWith('proj', 'env-2', true),
    );
    await waitFor(() =>
      expect(
        (screen.getAllByTestId('qa-env-default') as HTMLInputElement[]).map((b) => b.checked),
      ).toEqual([false, true]),
    );
  });

  it('saves the default delay for automated QA', async () => {
    listQaEnvironments.mockResolvedValue({ environments: [] });
    updateQaSettings.mockResolvedValue({ settings: { projectId: 'proj', autoQaDelayMinutes: 20 } });
    render(<QaEnvironmentsSettings projectId="proj" onBack={() => undefined} />);
    const input = (await screen.findByLabelText(
      'Default delay for automated QA',
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('0'));
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('qa-auto-delay-save'));
    expect(await screen.findByText(/whole minutes/)).toBeTruthy();
    expect(updateQaSettings).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('qa-auto-delay-save'));
    await waitFor(() =>
      expect(updateQaSettings).toHaveBeenCalledWith('proj', { autoQaDelayMinutes: 20 }),
    );
  });
});
