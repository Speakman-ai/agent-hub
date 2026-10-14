import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatTriggersSection, { describeTriggerFilter } from './ChatTriggersSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    chatTriggers: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    hubChat: { channels: vi.fn() },
    getEpics: vi.fn(),
  },
}));

const list = vi.mocked(api.chatTriggers.list);
const create = vi.mocked(api.chatTriggers.create);
const update = vi.mocked(api.chatTriggers.update);
const channels = vi.mocked(api.hubChat.channels);
const getEpics = vi.mocked(api.getEpics);

const trigger = {
  id: 't1',
  event: 'card_moved',
  filter: { columns: ['Done'] },
  channelId: 'c1',
  channel: { id: 'c1', name: 'web-activity', kind: 'trigger', isPrivate: false, archived: false },
  enabled: true,
  canManage: true,
};

describe('ChatTriggersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channels.mockResolvedValue({
      channels: [
        { id: 'c1', name: 'web-activity', kind: 'trigger' },
        { id: 'dm', name: '', kind: 'dm' },
      ],
    } as any);
    getEpics.mockResolvedValue([] as any);
  });

  it('offers the default activity channel for the first trigger', async () => {
    list.mockResolvedValue({ triggers: [], defaultChannelName: 'web-activity' } as any);
    create.mockResolvedValue({ trigger } as any);
    render(<ChatTriggersSection projectId="web" />);

    const name = await screen.findByLabelText('New channel name');
    await waitFor(() => expect(name).toHaveValue('web-activity'));
    expect(screen.getByLabelText('Channel')).toHaveValue('__new__');
    // DMs are not destinations.
    expect(screen.queryByRole('option', { name: '#group' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'card_moved' } });
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: 'Review, Done' } });
    fireEvent.click(screen.getByRole('button', { name: /Add trigger/ }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('web', {
        event: 'card_moved',
        filter: { columns: ['Review', 'Done'] },
        newChannel: { name: 'web-activity' },
      }),
    );
  });

  it('lists triggers and toggles one off', async () => {
    list.mockResolvedValue({ triggers: [trigger], defaultChannelName: 'web-activity' } as any);
    update.mockResolvedValue({ trigger: { ...trigger, enabled: false } } as any);
    render(<ChatTriggersSection projectId="web" />);

    const row = await screen.findByTestId('chat-trigger');
    expect(row).toHaveTextContent('Card moved');
    expect(row).toHaveTextContent('#web-activity');
    expect(row).toHaveTextContent('column: Done');
    // Later triggers default to the channel already in use.
    expect(screen.getByLabelText('Channel')).toHaveValue('c1');

    fireEvent.click(screen.getByRole('button', { name: 'Disable trigger' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('web', 't1', { enabled: false }));
    expect(await screen.findByRole('button', { name: 'Enable trigger' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('ChatTriggersSection project switches', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const webTrigger = {
    ...trigger,
    id: 'tw',
    channel: { ...trigger.channel, name: 'web-activity' },
  };
  const apiTrigger = {
    ...trigger,
    id: 'ta',
    channelId: 'c2',
    channel: { ...trigger.channel, id: 'c2', name: 'api-activity' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    channels.mockResolvedValue({ channels: [] } as any);
    getEpics.mockResolvedValue([] as any);
    list.mockImplementation(((pid: string) =>
      Promise.resolve(
        pid === 'web'
          ? { triggers: [webTrigger], defaultChannelName: 'web-activity' }
          : { triggers: [apiTrigger], defaultChannelName: 'api-activity' },
      )) as any);
  });

  it('a create that finishes after a project switch leaves the new project alone', async () => {
    const pending = deferred<unknown>();
    create.mockReturnValue(pending.promise as any);
    const { rerender } = render(<ChatTriggersSection projectId="web" />);
    expect(await screen.findByTestId('chat-trigger')).toHaveTextContent('#web-activity');

    fireEvent.click(screen.getByRole('button', { name: /Add trigger/ }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('web', expect.anything()));

    rerender(<ChatTriggersSection projectId="api" />);
    expect(await screen.findByTestId('chat-trigger')).toHaveTextContent('#api-activity');
    const listCalls = list.mock.calls.length;

    await act(async () => {
      pending.resolve({ trigger: webTrigger });
      await pending.promise;
    });

    // No reload of the old project, and the screen still shows the new one.
    expect(list.mock.calls.length).toBe(listCalls);
    expect(screen.getByTestId('chat-trigger')).toHaveTextContent('#api-activity');
    expect(screen.getByLabelText('New channel name')).toHaveValue('api-activity');
    expect(screen.getByRole('button', { name: /Add trigger/ })).not.toBeDisabled();
  });

  it('drops filter selections from the previous project before the next create', async () => {
    getEpics.mockImplementation(((pid: string) =>
      Promise.resolve(
        pid === 'web'
          ? [{ id: 'epic-web', name: 'Web epic' }]
          : [{ id: 'epic-api', name: 'Api epic' }],
      )) as any);
    create.mockResolvedValue({ trigger: apiTrigger } as any);
    const agentsA = [{ id: 'dev-web', name: 'Web dev' }];
    const agentsB = [{ id: 'dev-api', name: 'Api dev' }];
    const { rerender } = render(<ChatTriggersSection projectId="web" agents={agentsA} />);
    await screen.findByTestId('chat-trigger');

    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'card_moved' } });
    await screen.findByRole('option', { name: 'Web epic' });
    fireEvent.change(screen.getByLabelText('Epic'), { target: { value: 'epic-web' } });
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: 'Done' } });
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'web-only' } });

    rerender(<ChatTriggersSection projectId="api" agents={agentsB} />);
    expect(await screen.findByTestId('chat-trigger')).toHaveTextContent('#api-activity');
    await screen.findByRole('option', { name: 'Api epic' });
    expect(screen.getByLabelText('Epic')).toHaveValue('');
    expect(screen.getByLabelText('Columns')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: /Add trigger/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('api', {
      event: 'card_moved',
      filter: {},
      newChannel: { name: 'api-activity' },
    });
  });

  it('never submits an agent that is not in the current project', async () => {
    create.mockResolvedValue({ trigger: apiTrigger } as any);
    const { rerender } = render(
      <ChatTriggersSection projectId="web" agents={[{ id: 'dev-web', name: 'Web dev' }]} />,
    );
    await screen.findByTestId('chat-trigger');
    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'session_completed' } });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'dev-web' } });
    rerender(<ChatTriggersSection projectId="api" agents={[{ id: 'dev-api', name: 'Api dev' }]} />);
    expect(await screen.findByTestId('chat-trigger')).toHaveTextContent('#api-activity');
    expect(screen.getByLabelText('Agent')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /Add trigger/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toEqual({
      event: 'session_completed',
      filter: {},
      newChannel: { name: 'api-activity' },
    });
  });

  it('an old project load that lands late does not replace the new one', async () => {
    const slowWeb = deferred<unknown>();
    list.mockImplementation(((pid: string) =>
      pid === 'web'
        ? slowWeb.promise
        : Promise.resolve({ triggers: [apiTrigger], defaultChannelName: 'api-activity' })) as any);
    const { rerender } = render(<ChatTriggersSection projectId="web" />);
    rerender(<ChatTriggersSection projectId="api" />);
    expect(await screen.findByTestId('chat-trigger')).toHaveTextContent('#api-activity');
    await act(async () => {
      slowWeb.resolve({ triggers: [webTrigger], defaultChannelName: 'web-activity' });
      await slowWeb.promise;
    });
    expect(screen.getByTestId('chat-trigger')).toHaveTextContent('#api-activity');
  });

  it('a toggle that finishes after a project switch does not touch the new list', async () => {
    const pending = deferred<unknown>();
    update.mockReturnValue(pending.promise as any);
    const { rerender } = render(<ChatTriggersSection projectId="web" />);
    await screen.findByTestId('chat-trigger');
    fireEvent.click(screen.getByRole('button', { name: 'Disable trigger' }));
    rerender(<ChatTriggersSection projectId="api" />);
    expect(await screen.findByTestId('chat-trigger')).toHaveTextContent('#api-activity');
    await act(async () => {
      pending.resolve({ trigger: { ...webTrigger, enabled: false } });
      await pending.promise;
    });
    expect(screen.getByRole('button', { name: 'Disable trigger' })).not.toBeDisabled();
  });
});

describe('describeTriggerFilter', () => {
  it('is null for an empty filter and names epics and agents', () => {
    expect(describeTriggerFilter({})).toBeNull();
    expect(
      describeTriggerFilter(
        { epicId: 'e1', agentIds: ['dev'], outcome: 'fail' },
        new Map([['e1', 'Chat']]),
        new Map([['dev', 'Dev']]),
      ),
    ).toBe('epic: Chat · only fail · agents: Dev');
  });
});
