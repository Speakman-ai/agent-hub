import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PrEnvironmentsPanel from './PrEnvironmentsPanel';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getProjectPrEnvironments: vi.fn(),
    updateProjectPrEnvironmentLimits: vi.fn(),
    stopNativePrPreview: vi.fn(),
  },
}));

const LIMITS = { maxConcurrent: 5, idleTtlMinutes: 60, maxLifetimeDays: 14 };
const BOUNDS = {
  maxConcurrent: { min: 1, max: 100 },
  idleTtlMinutes: { min: 5, max: 10080 },
  maxLifetimeDays: { min: 1, max: 365 },
};
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function response(over: Record<string, unknown> = {}) {
  return {
    limits: LIMITS,
    overrides: {},
    defaults: LIMITS,
    bounds: BOUNDS,
    environments: [
      {
        id: 'e1',
        prNumber: 12,
        status: 'ready',
        headBranch: 'feat/x',
        url: 'https://pr-12--p.preview.example',
        createdAt: ago(3 * 86_400_000),
        lastHitAt: ago(10 * 60_000),
      },
      {
        id: 'e2',
        prNumber: 7,
        status: 'stopped',
        stopReason: 'idle',
        createdAt: ago(5 * 3_600_000),
        lastHitAt: null,
      },
    ],
    ...over,
  };
}

describe('PrEnvironmentsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getProjectPrEnvironments as any).mockResolvedValue(response());
  });

  it('lists every env with status, age, last hit, and Stop only where something runs', async () => {
    render(<PrEnvironmentsPanel projectId="p" />);
    const ready = await screen.findByTestId('pr-env-row-12');
    expect(ready.textContent).toContain('ready');
    expect(ready.textContent).toContain('age 3d');
    expect(ready.textContent).toContain('last hit 10m');
    const asleep = screen.getByTestId('pr-env-row-7');
    expect(asleep.textContent).toContain('asleep');
    expect(asleep.textContent).toContain('last hit never');
    expect(screen.getByTestId('pr-env-stop-12')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-env-stop-7')).toBeNull();
  });

  it('Stop stops that PR’s environment and reloads', async () => {
    (api.stopNativePrPreview as any).mockResolvedValue({ ok: true });
    render(<PrEnvironmentsPanel projectId="p" />);
    fireEvent.click(await screen.findByTestId('pr-env-stop-12'));
    await waitFor(() => expect(api.stopNativePrPreview).toHaveBeenCalledWith('p', 12));
    await waitFor(() => expect(api.getProjectPrEnvironments).toHaveBeenCalledTimes(2));
  });

  it('saves only changed limits, and an emptied override resets to the default', async () => {
    (api.getProjectPrEnvironments as any).mockResolvedValue(
      response({ limits: { ...LIMITS, idleTtlMinutes: 30 }, overrides: { idleTtlMinutes: 30 } }),
    );
    (api.updateProjectPrEnvironmentLimits as any).mockResolvedValue(response());
    render(<PrEnvironmentsPanel projectId="p" />);
    const cap = await screen.findByTestId('pr-env-limit-maxConcurrent');
    fireEvent.change(cap, { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('pr-env-limit-idleTtlMinutes'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pr-env-limits-save'));
    await waitFor(() =>
      expect(api.updateProjectPrEnvironmentLimits).toHaveBeenCalledWith('p', {
        maxConcurrent: 2,
        idleTtlMinutes: null,
      }),
    );
  });
});

describe('PrEnvironmentsPanel project switch', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const projectData = (prNumber: number, maxConcurrent: number) =>
    response({
      limits: { ...LIMITS, maxConcurrent },
      environments: [{ id: `e${prNumber}`, prNumber, status: 'ready', createdAt: ago(60_000) }],
    });

  beforeEach(() => vi.clearAllMocks());

  it('a late response for the previous project never fills the new one', async () => {
    const a = deferred<unknown>();
    (api.getProjectPrEnvironments as any).mockImplementation((id: string) =>
      id === 'A' ? a.promise : Promise.resolve(projectData(2, 3)),
    );
    const { rerender } = render(<PrEnvironmentsPanel projectId="A" />);
    rerender(<PrEnvironmentsPanel projectId="B" />);
    await screen.findByTestId('pr-env-row-2');
    a.resolve(projectData(1, 9));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('pr-env-row-1')).toBeNull();
    expect((screen.getByTestId('pr-env-limit-maxConcurrent') as HTMLInputElement).value).toBe('3');

    (api.stopNativePrPreview as any).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByTestId('pr-env-stop-2'));
    await waitFor(() => expect(api.stopNativePrPreview).toHaveBeenCalledWith('B', 2));
  });

  it('switching clears the previous project at once, and a late save response is dropped', async () => {
    const save = deferred<unknown>();
    (api.getProjectPrEnvironments as any).mockImplementation((id: string) =>
      id === 'A' ? Promise.resolve(projectData(1, 5)) : new Promise(() => {}),
    );
    (api.updateProjectPrEnvironmentLimits as any).mockReturnValue(save.promise);
    const { rerender } = render(<PrEnvironmentsPanel projectId="A" />);
    fireEvent.change(await screen.findByTestId('pr-env-limit-maxConcurrent'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByTestId('pr-env-limits-save'));
    rerender(<PrEnvironmentsPanel projectId="B" />);
    // B has not loaded: nothing of A's is shown or actionable.
    expect(screen.queryByTestId('pr-env-row-1')).toBeNull();
    expect(screen.queryByTestId('pr-env-limits-save')).toBeNull();
    save.resolve(projectData(1, 2));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('pr-env-row-1')).toBeNull();
    expect(api.updateProjectPrEnvironmentLimits).toHaveBeenCalledWith('A', { maxConcurrent: 2 });
  });
});

describe('PrEnvironmentsPanel refresh racing a save', () => {
  beforeEach(() => vi.clearAllMocks());

  // A fake server: GET returns whatever is stored when the GET arrives; a PUT
  // stores its limits only when it completes (the test controls when).
  function fakeServer() {
    const server = { maxConcurrent: LIMITS.maxConcurrent, finishPut: null as null | (() => void) };
    const body = () => response({ limits: { ...LIMITS, maxConcurrent: server.maxConcurrent } });
    (api.getProjectPrEnvironments as any).mockImplementation(async () => body());
    (api.updateProjectPrEnvironmentLimits as any).mockImplementation(
      (_id: string, patch: { maxConcurrent?: number }) =>
        new Promise((resolve) => {
          server.finishPut = () => {
            if (patch.maxConcurrent != null) server.maxConcurrent = patch.maxConcurrent;
            resolve({ ...body(), overrides: { maxConcurrent: server.maxConcurrent } });
          };
        }),
    );
    return server;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('Save then Refresh: the refresh is sent after the save completes and shows the saved limits', async () => {
    const server = fakeServer();
    render(<PrEnvironmentsPanel projectId="p" />);
    fireEvent.change(await screen.findByTestId('pr-env-limit-maxConcurrent'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByTestId('pr-env-limits-save'));
    await waitFor(() => expect(server.finishPut).not.toBeNull());
    fireEvent.click(screen.getByText('Refresh'));
    await tick();
    // Sent now, this GET would return the pre-save limits; it must wait.
    expect(api.getProjectPrEnvironments).toHaveBeenCalledTimes(1);
    server.finishPut!();
    await waitFor(() => expect(api.getProjectPrEnvironments).toHaveBeenCalledTimes(2));
    await tick();
    expect((screen.getByTestId('pr-env-limit-maxConcurrent') as HTMLInputElement).value).toBe('2');

    // The next edit is diffed against the saved baseline.
    fireEvent.change(screen.getByTestId('pr-env-limit-idleTtlMinutes'), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByTestId('pr-env-limits-save'));
    await waitFor(() =>
      expect(api.updateProjectPrEnvironmentLimits).toHaveBeenLastCalledWith('p', {
        idleTtlMinutes: 45,
      }),
    );
  });

  it('Refresh then Save: the save waits for the refresh and its result is what stays', async () => {
    let resolveSlowGet!: (v: unknown) => void;
    (api.getProjectPrEnvironments as any)
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise((r) => (resolveSlowGet = r)));
    (api.updateProjectPrEnvironmentLimits as any).mockResolvedValue(
      response({ limits: { ...LIMITS, maxConcurrent: 2 }, overrides: { maxConcurrent: 2 } }),
    );
    render(<PrEnvironmentsPanel projectId="p" />);
    const cap = (await screen.findByTestId('pr-env-limit-maxConcurrent')) as HTMLInputElement;
    fireEvent.click(screen.getByText('Refresh'));
    fireEvent.change(cap, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('pr-env-limits-save'));
    await tick();
    expect(api.updateProjectPrEnvironmentLimits).not.toHaveBeenCalled();
    resolveSlowGet(response());
    await waitFor(() => expect(api.updateProjectPrEnvironmentLimits).toHaveBeenCalled());
    await tick();
    expect((screen.getByTestId('pr-env-limit-maxConcurrent') as HTMLInputElement).value).toBe('2');
  });
});
