import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getServerAgentSettings = vi.fn();
const putServerAgentSettings = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    getServerAgentSettings: (...args: unknown[]) => getServerAgentSettings(...args),
    putServerAgentSettings: (...args: unknown[]) => putServerAgentSettings(...args),
  },
}));

const auth = vi.hoisted(() => ({
  user: { id: 'user-a' } as { id: string } | null,
  token: 'token-1',
}));
vi.mock('../utils/auth', () => ({
  getAuthRecord: () => (auth.user ? { user: auth.user, token: auth.token } : null),
}));
vi.mock('../utils/connection', () => ({ getServerBase: () => 'http://hub.test' }));

import { act } from '@testing-library/react';
import { ServerAgentPage, ServerAgentSettingsPage } from './ServerAgentPage';
import { resetServerAgentSettingsForTests } from '../utils/serverAgentSettings';

const settings = (over: Record<string, string> = {}) => ({
  name: '',
  instructions: '',
  defaultName: 'Server Agent',
  effectiveName: 'Server Agent',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 'user-a' };
  auth.token = 'token-1';
  resetServerAgentSettingsForTests();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ServerAgentPage', () => {
  it('shows the default name, the transcript, and opens settings', async () => {
    getServerAgentSettings.mockResolvedValue(settings());
    const onOpenSettings = vi.fn();
    render(
      <ServerAgentPage onOpenSettings={onOpenSettings}>
        <div data-testid="transcript" />
      </ServerAgentPage>,
    );
    expect(screen.getByTestId('transcript')).toBeInTheDocument();
    expect(screen.getByTestId('server-agent-name')).toHaveTextContent('Server Agent');
    fireEvent.click(screen.getByTestId('server-agent-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('uses the custom name once loaded', async () => {
    getServerAgentSettings.mockResolvedValue(settings({ name: 'Jarvis' }));
    render(
      <ServerAgentPage onOpenSettings={() => undefined}>
        <div />
      </ServerAgentPage>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('server-agent-name')).toHaveTextContent('Jarvis'),
    );
  });
});

describe('ServerAgentSettingsPage', () => {
  it('saves name and instructions and renames the agent everywhere', async () => {
    getServerAgentSettings.mockResolvedValue(settings({ instructions: 'Be brief.' }));
    putServerAgentSettings.mockImplementation(async (body: Record<string, string>) =>
      settings({ ...body, effectiveName: body.name || 'Server Agent' }),
    );
    render(
      <>
        <ServerAgentSettingsPage onBack={() => undefined} />
        <ServerAgentPage onOpenSettings={() => undefined}>
          <div />
        </ServerAgentPage>
      </>,
    );
    const nameInput = screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    const textarea = screen.getByTestId(
      'server-agent-settings-instructions',
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('Be brief.'));
    const save = screen.getByTestId('server-agent-settings-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(nameInput, { target: { value: 'Jarvis' } });
    fireEvent.change(textarea, { target: { value: 'Be brief. Use tables.' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(putServerAgentSettings).toHaveBeenCalledWith({
        name: 'Jarvis',
        instructions: 'Be brief. Use tables.',
      }),
    );
    expect(await screen.findByTestId('server-agent-settings-status')).toHaveTextContent('Saved');
    expect(screen.getByTestId('server-agent-name')).toHaveTextContent('Jarvis');
  });

  it('reports a failed save and goes back', async () => {
    getServerAgentSettings.mockResolvedValue(settings());
    putServerAgentSettings.mockRejectedValue(new Error('name must be at most 60 characters'));
    const onBack = vi.fn();
    render(<ServerAgentSettingsPage onBack={onBack} />);
    const nameInput = screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    await waitFor(() => expect(nameInput.disabled).toBe(false));
    fireEvent.change(nameInput, { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('server-agent-settings-save'));
    expect(await screen.findByTestId('server-agent-settings-status')).toHaveTextContent(
      'name must be at most 60 characters',
    );
    fireEvent.click(screen.getByTestId('server-agent-settings-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('ServerAgentSettingsPage across an account switch', () => {
  it("drops A's draft and a late A response, and saves only B's values for B", async () => {
    const forA = deferred<ReturnType<typeof settings>>();
    const forB = deferred<ReturnType<typeof settings>>();
    getServerAgentSettings.mockReturnValueOnce(forA.promise).mockReturnValueOnce(forB.promise);
    putServerAgentSettings.mockImplementation(async (body: Record<string, string>) =>
      settings(body),
    );

    const { rerender } = render(<ServerAgentSettingsPage onBack={() => undefined} />);
    const nameInput = () => screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    const textarea = () =>
      screen.getByTestId('server-agent-settings-instructions') as HTMLTextAreaElement;

    // A's request is still pending when the user signs in as B.
    auth.user = { id: 'user-b' };
    rerender(<ServerAgentSettingsPage onBack={() => undefined} />);
    await waitFor(() => expect(getServerAgentSettings).toHaveBeenCalledTimes(2));

    await act(async () => forA.resolve(settings({ name: 'A-agent', instructions: 'A secret' })));
    expect(nameInput().value).toBe('');
    expect(textarea().value).toBe('');
    expect(nameInput().disabled).toBe(true);

    await act(async () => forB.resolve(settings({ name: 'B-agent', instructions: 'B notes' })));
    await waitFor(() => expect(textarea().value).toBe('B notes'));
    expect(nameInput().value).toBe('B-agent');

    fireEvent.change(nameInput(), { target: { value: 'B2' } });
    fireEvent.click(screen.getByTestId('server-agent-settings-save'));
    await waitFor(() =>
      expect(putServerAgentSettings).toHaveBeenCalledWith({ name: 'B2', instructions: 'B notes' }),
    );
  });

  it("discards an edited draft from A when the account changes, so it can't be saved into B", async () => {
    getServerAgentSettings
      .mockResolvedValueOnce(settings({ name: 'A-agent', instructions: 'A secret' }))
      .mockResolvedValueOnce(settings({ name: '', instructions: '' }));
    const { rerender } = render(<ServerAgentSettingsPage onBack={() => undefined} />);
    const nameInput = () => screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    const textarea = () =>
      screen.getByTestId('server-agent-settings-instructions') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea().value).toBe('A secret'));
    fireEvent.change(nameInput(), { target: { value: 'A edited' } });

    auth.user = { id: 'user-b' };
    rerender(<ServerAgentSettingsPage onBack={() => undefined} />);
    await waitFor(() => expect(getServerAgentSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(nameInput().disabled).toBe(false));
    expect(nameInput().value).toBe('');
    expect(textarea().value).toBe('');
    expect((screen.getByTestId('server-agent-settings-save') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(putServerAgentSettings).not.toHaveBeenCalled();
  });

  it("ignores A's save that completes after switching to B", async () => {
    const savingA = deferred<ReturnType<typeof settings>>();
    getServerAgentSettings
      .mockResolvedValueOnce(settings({ name: 'A-agent', instructions: 'A secret' }))
      .mockResolvedValueOnce(settings({ name: 'B-agent', instructions: 'B notes' }));
    putServerAgentSettings
      .mockReturnValueOnce(savingA.promise)
      .mockImplementation(async (body: Record<string, string>) => settings(body));
    const { rerender } = render(<ServerAgentSettingsPage onBack={() => undefined} />);
    const nameInput = () => screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    const textarea = () =>
      screen.getByTestId('server-agent-settings-instructions') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea().value).toBe('A secret'));
    fireEvent.change(nameInput(), { target: { value: 'A2' } });
    fireEvent.click(screen.getByTestId('server-agent-settings-save'));
    await waitFor(() => expect(putServerAgentSettings).toHaveBeenCalledTimes(1));

    auth.user = { id: 'user-b' };
    rerender(<ServerAgentSettingsPage onBack={() => undefined} />);
    await waitFor(() => expect(textarea().value).toBe('B notes'));

    await act(async () => savingA.resolve(settings({ name: 'A2', instructions: 'A secret' })));
    expect(nameInput().value).toBe('B-agent');
    expect(textarea().value).toBe('B notes');
    expect(screen.queryByTestId('server-agent-settings-status')).toBeNull();

    fireEvent.change(nameInput(), { target: { value: 'B2' } });
    fireEvent.click(screen.getByTestId('server-agent-settings-save'));
    await waitFor(() => expect(putServerAgentSettings).toHaveBeenCalledTimes(2));
    expect(putServerAgentSettings).toHaveBeenLastCalledWith({
      name: 'B2',
      instructions: 'B notes',
    });
  });
});

describe('ServerAgentSettingsPage while a save is pending', () => {
  it('keeps edits typed after clicking Save', async () => {
    const saving = deferred<ReturnType<typeof settings>>();
    getServerAgentSettings.mockResolvedValue(settings({ name: 'A', instructions: 'one' }));
    putServerAgentSettings.mockReturnValueOnce(saving.promise);
    render(<ServerAgentSettingsPage onBack={() => undefined} />);
    const nameInput = () => screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    const textarea = () =>
      screen.getByTestId('server-agent-settings-instructions') as HTMLTextAreaElement;
    const saveButton = () => screen.getByTestId('server-agent-settings-save') as HTMLButtonElement;
    await waitFor(() => expect(textarea().value).toBe('one'));

    fireEvent.change(nameInput(), { target: { value: 'Jarvis' } });
    fireEvent.click(saveButton());
    expect(putServerAgentSettings).toHaveBeenCalledWith({ name: 'Jarvis', instructions: 'one' });
    expect(saveButton().disabled).toBe(true);

    // Typed while the request is out.
    fireEvent.change(nameInput(), { target: { value: 'Friday' } });
    fireEvent.change(textarea(), { target: { value: 'two' } });

    await act(async () => saving.resolve(settings({ name: 'Jarvis', instructions: 'one' })));
    expect(nameInput().value).toBe('Friday');
    expect(textarea().value).toBe('two');
    expect(screen.getByTestId('server-agent-settings-status')).toHaveTextContent('Saved');
    // The newer edits are still unsaved, so Save is available for them.
    expect(saveButton().disabled).toBe(false);
  });
});

describe('ServerAgentSettingsPage when loading fails', () => {
  it('shows the error with Retry, and loads the form when the retry succeeds', async () => {
    getServerAgentSettings
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce(settings({ name: 'Jarvis', instructions: 'Be brief.' }));
    render(<ServerAgentSettingsPage onBack={() => undefined} />);
    const nameInput = () => screen.getByTestId('server-agent-settings-name') as HTMLInputElement;

    expect(await screen.findByTestId('server-agent-settings-load-error')).toHaveTextContent(
      'Network down',
    );
    expect(nameInput().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('server-agent-settings-retry'));
    await waitFor(() => expect(nameInput().value).toBe('Jarvis'));
    expect(nameInput().disabled).toBe(false);
    expect(screen.queryByTestId('server-agent-settings-load-error')).toBeNull();
    expect(getServerAgentSettings).toHaveBeenCalledTimes(2);
  });
});

describe('ServerAgentSettingsPage across sign-out and sign-in as the same user', () => {
  it('drops a save from the earlier session even though nothing rendered while signed out', async () => {
    const firstSave = deferred<ReturnType<typeof settings>>();
    getServerAgentSettings
      .mockResolvedValueOnce(settings({ name: 'A', instructions: 'one' }))
      .mockResolvedValueOnce(settings({ name: 'A', instructions: 'reloaded' }));
    putServerAgentSettings
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementation(async (body: Record<string, string>) => settings(body));

    const first = render(<ServerAgentSettingsPage onBack={() => undefined} />);
    const nameInput = () => screen.getByTestId('server-agent-settings-name') as HTMLInputElement;
    const textarea = () =>
      screen.getByTestId('server-agent-settings-instructions') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea().value).toBe('one'));
    fireEvent.change(nameInput(), { target: { value: 'Old name' } });
    fireEvent.click(screen.getByTestId('server-agent-settings-save'));
    expect(putServerAgentSettings).toHaveBeenCalledTimes(1);

    // Signed out: the app shows the login screen, so nothing here renders.
    first.unmount();
    // The same user signs back in with a new session.
    auth.token = 'token-2';
    render(
      <>
        <ServerAgentSettingsPage onBack={() => undefined} />
        <ServerAgentPage onOpenSettings={() => undefined}>
          <div />
        </ServerAgentPage>
      </>,
    );
    // The earlier session's cache is not reused.
    await waitFor(() => expect(textarea().value).toBe('reloaded'));
    expect(getServerAgentSettings).toHaveBeenCalledTimes(2);
    fireEvent.change(nameInput(), { target: { value: 'New name' } });
    fireEvent.click(screen.getByTestId('server-agent-settings-save'));
    await waitFor(() =>
      expect(screen.getByTestId('server-agent-name')).toHaveTextContent('New name'),
    );

    await act(async () => firstSave.resolve(settings({ name: 'Old name', instructions: 'one' })));
    expect(screen.getByTestId('server-agent-name')).toHaveTextContent('New name');
    expect(nameInput().value).toBe('New name');
  });
});
