import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const act = TestRenderer.act as (cb: () => unknown) => Promise<void>;
const create = TestRenderer.create as (element: any) => void;

const apiMock = vi.hoisted(() => ({
  updateEpic: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { useEpicAutosave } = await import('./useEpicAutosave');

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('useEpicAutosave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    apiMock.updateEpic.mockResolvedValue({ id: 'epic-1', name: 'Renamed epic' });
  });

  it('debounces edits and persists the latest existing-epic form without a submit action', async () => {
    let autosave: any;
    const onSaved = vi.fn();
    const initialForm = {
      name: 'Original epic',
      description: '',
      color: '#6366F1',
      labels: '',
      assigned_user_id: '',
      pr_base_branch: '',
      autonomous: 0,
      autonomous_interval: 5,
      autonomous_max_concurrent: 1,
      autonomous_model: '',
      autonomous_send_it: 0,
    };

    function Harness() {
      autosave = useEpicAutosave({
        projectId: 'project-1',
        epic: { id: 'epic-1' },
        form: initialForm,
        onSaved,
      });
      return null;
    }

    await act(async () => {
      create(<Harness />);
      await flushMicrotasks();
    });
    await act(async () => {
      autosave.schedule({ ...initialForm, name: 'First draft' });
      autosave.schedule({ ...initialForm, name: 'Renamed epic' });
      await vi.runAllTimersAsync();
      await flushMicrotasks();
    });

    expect(apiMock.updateEpic).toHaveBeenCalledTimes(1);
    expect(apiMock.updateEpic).toHaveBeenCalledWith(
      'project-1',
      'epic-1',
      expect.objectContaining({ name: 'Renamed epic' }),
    );
    expect(onSaved).toHaveBeenCalledWith({ id: 'epic-1', name: 'Renamed epic' });
  });

  it('preserves the stored name when the field is temporarily blank so other fields still save on flush', async () => {
    let autosave: any;
    const onSaved = vi.fn();
    const initialForm = {
      name: 'Original epic',
      description: '',
      color: '#6366F1',
      labels: '',
      assigned_user_id: '',
      pr_base_branch: '',
      autonomous: 0,
      autonomous_interval: 5,
      autonomous_max_concurrent: 1,
      autonomous_model: '',
      autonomous_send_it: 0,
    };

    function Harness() {
      autosave = useEpicAutosave({
        projectId: 'project-1',
        epic: { id: 'epic-1', name: 'Original epic' },
        form: initialForm,
        onSaved,
      });
      return null;
    }

    await act(async () => {
      create(<Harness />);
      await flushMicrotasks();
    });

    // Clear the name and change another field, then close the editor (flush).
    await act(async () => {
      autosave.schedule({ ...initialForm, name: '', color: '#22C55E' });
      autosave.flush();
      await vi.runAllTimersAsync();
      await flushMicrotasks();
    });

    expect(apiMock.updateEpic).toHaveBeenCalledTimes(1);
    expect(apiMock.updateEpic).toHaveBeenCalledWith(
      'project-1',
      'epic-1',
      expect.objectContaining({ name: 'Original epic', color: '#22C55E' }),
    );
  });

  it('flushes a pending edit on unmount so navigating away within the debounce window does not lose it', async () => {
    let autosave: any;
    let renderer: any;
    const onSaved = vi.fn();
    const baseForm = {
      name: 'Original epic',
      description: '',
      color: '#6366F1',
      labels: '',
      assigned_user_id: '',
      pr_base_branch: '',
      autonomous: 0,
      autonomous_interval: 5,
      autonomous_max_concurrent: 1,
      autonomous_model: '',
      autonomous_send_it: 0,
    };

    function Harness() {
      autosave = useEpicAutosave({
        projectId: 'project-1',
        epic: { id: 'epic-1', name: 'Original epic' },
        form: baseForm,
        onSaved,
      });
      return null;
    }

    await act(async () => {
      renderer = create(<Harness />);
      await flushMicrotasks();
    });
    // Edit a field, then unmount before the 500ms debounce timer fires.
    await act(async () => {
      autosave.schedule({ ...baseForm, color: '#22C55E' });
    });
    await act(async () => {
      renderer.unmount();
      await flushMicrotasks();
    });

    expect(apiMock.updateEpic).toHaveBeenCalledTimes(1);
    expect(apiMock.updateEpic).toHaveBeenCalledWith(
      'project-1',
      'epic-1',
      expect.objectContaining({ name: 'Original epic', color: '#22C55E' }),
    );
  });

  it('flushes the outgoing epic when the active epic changes within the debounce window', async () => {
    let autosave: any;
    let renderer: any;
    const onSaved = vi.fn();
    const formOne = {
      name: 'Epic One',
      description: '',
      color: '#6366F1',
      labels: '',
      assigned_user_id: '',
      pr_base_branch: '',
      autonomous: 0,
      autonomous_interval: 5,
      autonomous_max_concurrent: 1,
      autonomous_model: '',
      autonomous_send_it: 0,
    };
    const formTwo = { ...formOne, name: 'Epic Two' };

    function Harness({ epic, form }: any) {
      autosave = useEpicAutosave({ projectId: 'project-1', epic, form, onSaved });
      return null;
    }

    await act(async () => {
      renderer = create(<Harness epic={{ id: 'epic-1', name: 'Epic One' }} form={formOne} />);
      await flushMicrotasks();
    });
    // Edit epic-1, then switch to epic-2 before the debounce timer fires.
    await act(async () => {
      autosave.schedule({ ...formOne, color: '#22C55E' });
    });
    await act(async () => {
      renderer.update(<Harness epic={{ id: 'epic-2', name: 'Epic Two' }} form={formTwo} />);
      await flushMicrotasks();
    });

    // The outgoing edit is persisted against epic-1, not lost or misattributed.
    expect(apiMock.updateEpic).toHaveBeenCalledTimes(1);
    expect(apiMock.updateEpic).toHaveBeenCalledWith(
      'project-1',
      'epic-1',
      expect.objectContaining({ name: 'Epic One', color: '#22C55E' }),
    );
  });
});
