import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AutopilotSettingsSection from './AutopilotSettingsSection';
import { api } from '../utils/api';

(vi as any).mock('../utils/api.js', () => ({
  api: {
    getAutopilot: vi.fn(),
    putAutopilotConfig: vi.fn(),
    startAutopilot: vi.fn(),
    pauseAutopilot: vi.fn(),
    resumeAutopilot: vi.fn(),
    stopAutopilot: vi.fn(),
    disableAutopilot: vi.fn(),
  },
}));

// Default to Admin so the setup form + controls render. Overridden per-test
// where the read-only path matters.
(vi as any).mock('../utils/auth', () => ({
  hasRole: vi.fn(() => true),
  isLocalBundledDeployment: vi.fn(() => false),
}));

const LIMITS = {
  cycleMode: 'continuous' as const,
  maxCycles: null,
  maxWallTimeMs: 4 * 60 * 60 * 1000,
  maxStageTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerStage: 2,
  maxCostUsd: null,
};

function readyConfig(overrides: any = {}) {
  return {
    projectId: 'p1',
    enabled: true,
    disabling: false,
    briefId: 'b1',
    brief: 'Build a todo app.',
    briefRevision: 1,
    target: {
      targetId: 'local',
      origin: 'http://127.0.0.1:8080',
      readinessProbeUrl: 'http://127.0.0.1:8080/health',
    },
    limits: LIMITS,
    credentialOwnerUserId: 'user-1',
    updatedAt: '2026-09-15T00:00:00.000Z',
    updatedBy: 'user-1',
    ...overrides,
  };
}

function run(overrides: any = {}) {
  return {
    id: 'run-1',
    projectId: 'p1',
    controlState: 'running',
    stage: 'implementing',
    cycleNumber: 1,
    pauseReason: null,
    failureReason: null,
    lastVerifiedSha: null,
    lastDeploymentId: null,
    targetId: 'local',
    limits: LIMITS,
    usage: { wallTimeMs: 0, costUsd: null, costAvailable: false },
    startedBy: 'user-1',
    startedAt: '2026-09-15T00:00:00.000Z',
    stoppedAt: null,
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

function state(overrides: any = {}) {
  return {
    config: readyConfig(),
    activeRun: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).confirm = vi.fn(() => true);
  (api.getAutopilot as any).mockResolvedValue(state());
  (api.putAutopilotConfig as any).mockResolvedValue(readyConfig({ enabled: true }));
  (api.stopAutopilot as any).mockResolvedValue({ run: run({ controlState: 'stopping' }) });
});

describe('AutopilotSettingsSection', () => {
  it('renders the readiness checklist from the loaded state', async () => {
    render(<AutopilotSettingsSection projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('autopilot-readiness')).toBeTruthy());
    // All requirements met for a complete config.
    expect(screen.getByTestId('autopilot-readiness-brief')).toBeTruthy();
    expect(screen.getByTestId('autopilot-readiness-owner')).toBeTruthy();
  });

  it('saves setup without changing project enablement', async () => {
    const showToast = vi.fn();
    render(<AutopilotSettingsSection projectId="p1" showToast={showToast} />);
    const enable = await screen.findByTestId('autopilot-save-config');
    fireEvent.click(enable);
    await waitFor(() => expect(api.putAutopilotConfig).toHaveBeenCalled());
    const body = (api.putAutopilotConfig as any).mock.calls[0][1];
    expect(body).not.toHaveProperty('enabled');
    expect(body.target.targetId).toBe('local');
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/saved/i), 'success'),
    );
  });

  it('gates the host isolation adapter behind an "are you sure" acknowledgment', async () => {
    render(<AutopilotSettingsSection projectId="p1" />);
    const select = (await screen.findByTestId('autopilot-isolation-adapter')) as HTMLSelectElement;
    // Default adapter is auto; no host warning is shown.
    expect(select.value).toBe('auto');
    expect(screen.queryByTestId('autopilot-host-warning')).toBeNull();

    // Selecting host reveals the warning + confirmation checkbox.
    fireEvent.change(select, { target: { value: 'host' } });
    expect(screen.getByTestId('autopilot-host-warning')).toBeTruthy();
    const ack = screen.getByTestId('autopilot-host-ack') as HTMLInputElement;
    expect(ack.checked).toBe(false);

    fireEvent.click(ack);
    fireEvent.click(screen.getByTestId('autopilot-save-config'));
    await waitFor(() => expect(api.putAutopilotConfig).toHaveBeenCalled());
    const body = (api.putAutopilotConfig as any).mock.calls[0][1];
    expect(body.isolationAdapter).toBe('host');
    expect(body.hostAdapterAck).toBe(true);
  });

  it('never sends a host acknowledgment for a non-host adapter', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({ config: readyConfig({ isolationAdapter: 'host', hostAdapterAck: true }) }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    const select = (await screen.findByTestId('autopilot-isolation-adapter')) as HTMLSelectElement;
    // Switch away from host — the stale acknowledgment must not be persisted.
    fireEvent.change(select, { target: { value: 'sysbox' } });
    expect(screen.queryByTestId('autopilot-host-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('autopilot-save-config'));
    await waitFor(() => expect(api.putAutopilotConfig).toHaveBeenCalled());
    const body = (api.putAutopilotConfig as any).mock.calls[0][1];
    expect(body.isolationAdapter).toBe('sysbox');
    expect(body.hostAdapterAck).toBe(false);
  });

  it('sends the loaded config revision as expectedRevision (optimistic concurrency)', async () => {
    (api.getAutopilot as any).mockResolvedValue(state({ config: readyConfig({ revision: 7 }) }));
    render(<AutopilotSettingsSection projectId="p1" />);
    const enable = await screen.findByTestId('autopilot-save-config');
    fireEvent.click(enable);
    await waitFor(() => expect(api.putAutopilotConfig).toHaveBeenCalled());
    expect((api.putAutopilotConfig as any).mock.calls[0][1].expectedRevision).toBe(7);
  });

  it('pins the concurrency revision to the edited form, not a background load', async () => {
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({ config: readyConfig({ revision: 1, brief: 'server v1' }) }),
    );
    (api.putAutopilotConfig as any).mockResolvedValue(readyConfig({ revision: 3 }));
    render(<AutopilotSettingsSection projectId="p1" />);
    const brief = () => screen.getByTestId('autopilot-brief') as HTMLTextAreaElement;
    await waitFor(() => expect(brief().value).toBe('server v1'));

    // Operator edits (form is now dirty, based on revision 1).
    fireEvent.change(brief(), { target: { value: 'my edit' } });

    // Another client advances the config to revision 2; a reconnect refetch
    // brings that in. The dirty form must keep the edit AND its base revision.
    (api.getAutopilot as any).mockResolvedValue(
      state({ config: readyConfig({ revision: 2, brief: 'server v2' }) }),
    );
    window.dispatchEvent(new Event('agenthub:ws_reconnected'));
    await waitFor(() => expect(api.getAutopilot).toHaveBeenCalledTimes(2));
    expect(brief().value).toBe('my edit');

    // Save must submit the form's base revision (1), NOT the newly loaded 2 —
    // otherwise it would silently overwrite the other client's change.
    fireEvent.click(screen.getByTestId('autopilot-save-config'));
    await waitFor(() => expect(api.putAutopilotConfig).toHaveBeenCalled());
    const body = (api.putAutopilotConfig as any).mock.calls[0][1];
    expect(body.expectedRevision).toBe(1);
    expect(body.brief).toBe('my edit');
  });

  it('does not advance the base revision when the form is reloaded mid-save', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({ config: readyConfig({ revision: 1, brief: 'A' }) }),
    );
    const resolvers: ((v: any) => void)[] = [];
    (api.putAutopilotConfig as any).mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        }),
    );

    render(<AutopilotSettingsSection projectId="p1" />);
    const brief = () => screen.getByTestId('autopilot-brief') as HTMLTextAreaElement;
    const save = () => screen.getByTestId('autopilot-save-config');
    await waitFor(() => expect(brief().value).toBe('A'));

    // Edit to B and submit (deferred) at base revision 1.
    fireEvent.change(brief(), { target: { value: 'B' } });
    fireEvent.click(save());
    expect((api.putAutopilotConfig as any).mock.calls[0][1].expectedRevision).toBe(1);
    expect((api.putAutopilotConfig as any).mock.calls[0][1].brief).toBe('B');

    // Refresh while the PUT is pending — the form reloads server content (A) at
    // revision 1, re-pinning the base to that reloaded lineage.
    fireEvent.click(screen.getByTestId('autopilot-refresh'));
    await waitFor(() => expect(brief().value).toBe('A'));
    // Edit another field on the reloaded form.
    fireEvent.change(screen.getByTestId('autopilot-target-id'), { target: { value: 'local2' } });

    // The B save succeeds at revision 2 — but must NOT advance the base, because
    // the form no longer holds what that save persisted.
    resolvers[0](readyConfig({ revision: 2, brief: 'B' }));
    await waitFor(() => expect(save()).not.toBeDisabled());

    // The next save carries the reloaded form's base (1), not 2 — so it can't
    // silently overwrite B.
    fireEvent.click(save());
    await waitFor(() => expect((api.putAutopilotConfig as any).mock.calls.length).toBe(2));
    expect((api.putAutopilotConfig as any).mock.calls[1][1].expectedRevision).toBe(1);
  });

  it('ignores an out-of-order lifecycle response that would regress a newer one', async () => {
    // Initial load succeeds (running); every later GET fails, so nothing but
    // the applied mutation snapshots drives the run state.
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: { run: run({ controlState: 'running' }), cycle: null, stateVersion: 1 },
        stateVersion: 1,
      }),
    );
    (api.getAutopilot as any).mockRejectedValue(new Error('reconcile GET fails'));
    let resolvePause: (v: any) => void = () => {};
    let resolveStop: (v: any) => void = () => {};
    (api.pauseAutopilot as any).mockReturnValue(
      new Promise((r) => {
        resolvePause = r;
      }),
    );
    (api.stopAutopilot as any).mockReturnValue(
      new Promise((r) => {
        resolveStop = r;
      }),
    );

    render(<AutopilotSettingsSection projectId="p1" />);
    // Pause is issued first, then Stop (Stop supersedes it).
    fireEvent.click(await screen.findByTestId('autopilot-pause'));
    fireEvent.click(screen.getByTestId('autopilot-stop'));

    // Stop returns first → run shows Stopping (higher server version).
    resolveStop({ run: run({ controlState: 'stopping' }), cycle: null, stateVersion: 6 });
    await waitFor(() =>
      expect(screen.getByTestId('autopilot-run-state').textContent).toContain('Stopping'),
    );

    // The earlier Pause returns afterwards with an older server version; the
    // failed reconcile GET can't correct it — so it must be ignored.
    resolvePause({ run: run({ controlState: 'paused' }), cycle: null, stateVersion: 5 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByTestId('autopilot-run-state').textContent).toContain('Stopping');
    expect(screen.getByTestId('autopilot-run-state').textContent).not.toContain('Paused');
  });

  it('discards a mutation response that a newer successful GET has superseded', async () => {
    // Mount with a running run; a Pause is issued and delayed.
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: { run: run({ controlState: 'running' }), cycle: null, stateVersion: 1 },
        stateVersion: 1,
      }),
    );
    let resolvePause: (v: any) => void = () => {};
    (api.pauseAutopilot as any).mockReturnValue(
      new Promise((r) => {
        resolvePause = r;
      }),
    );

    render(<AutopilotSettingsSection projectId="p1" />);
    fireEvent.click(await screen.findByTestId('autopilot-pause'));

    // Another operator stops the run; a reconnect GET loads the newer state
    // (no active run) at a higher server version. Then all later GETs fail.
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({ config: readyConfig({ enabled: true }), activeRun: null, stateVersion: 3 }),
    );
    (api.getAutopilot as any).mockRejectedValue(new Error('reconcile GET fails'));
    window.dispatchEvent(new Event('agenthub:ws_reconnected'));
    await waitFor(() => expect(screen.queryByTestId('autopilot-run')).toBeNull());

    // The delayed (older-version) Pause response arrives; the newer GET already
    // superseded it, and the failed reconcile can't correct a regression — so
    // it must be discarded, leaving "no active run".
    resolvePause({ run: run({ controlState: 'paused' }), cycle: null, stateVersion: 2 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId('autopilot-run')).toBeNull();
  });

  it('applies a successful Start even if a stale pre-Start GET completed first', async () => {
    // Mount with no active run at version 1.
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({ config: readyConfig({ enabled: true }), activeRun: null, stateVersion: 1 }),
    );
    let resolveStart: (v: any) => void = () => {};
    (api.startAutopilot as any).mockReturnValue(
      new Promise((r) => {
        resolveStart = r;
      }),
    );

    render(<AutopilotSettingsSection projectId="p1" />);
    fireEvent.click(await screen.findByTestId('autopilot-start'));

    // A reconnect GET returns the pre-Start state (still no run, version 1) and
    // completes before Start resolves; later GETs fail.
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({ config: readyConfig({ enabled: true }), activeRun: null, stateVersion: 1 }),
    );
    (api.getAutopilot as any).mockRejectedValue(new Error('reconcile GET fails'));
    window.dispatchEvent(new Event('agenthub:ws_reconnected'));
    await waitFor(() => expect(api.getAutopilot).toHaveBeenCalledTimes(2));

    // The Start response carries a newer server version — it must be applied
    // despite the stale GET, and survive the failed reconcile.
    resolveStart({ run: run({ controlState: 'running' }), cycle: null, stateVersion: 5 });
    await waitFor(() =>
      expect(screen.getByTestId('autopilot-run-state').textContent).toContain('Running'),
    );
    expect(screen.getByTestId('autopilot-stop')).toBeTruthy();
  });

  it('rejects an invalid cost cap instead of clearing the saved cap', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        config: readyConfig({ enabled: true, limits: { ...LIMITS, maxCostUsd: 5 } }),
      }),
    );
    const showToast = vi.fn();
    render(<AutopilotSettingsSection projectId="p1" showToast={showToast} />);
    const cap = () => screen.getByTestId('autopilot-cost-cap') as HTMLInputElement;
    await waitFor(() => expect(cap().value).toBe('5'));

    // Enter an invalid cap and save — the write must be blocked, not sent as a
    // null that would remove the existing $5 cap.
    fireEvent.change(cap(), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('autopilot-save-config'));

    expect(api.putAutopilotConfig).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/cost cap/i), 'error');

    // A valid positive cap saves and is sent through.
    fireEvent.change(cap(), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('autopilot-save-config'));
    await waitFor(() => expect(api.putAutopilotConfig).toHaveBeenCalled());
    expect((api.putAutopilotConfig as any).mock.calls[0][1].limits.maxCostUsd).toBe(10);
  });

  it('rejects an invalid wall-time budget instead of silently defaulting', async () => {
    (api.getAutopilot as any).mockResolvedValue(state({ config: readyConfig({ enabled: true }) }));
    const showToast = vi.fn();
    render(<AutopilotSettingsSection projectId="p1" showToast={showToast} />);
    const wall = () => screen.getByTestId('autopilot-wall-time') as HTMLInputElement;
    await waitFor(() => expect(wall().value).toBe('4'));

    fireEvent.change(wall(), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('autopilot-save-config'));

    expect(api.putAutopilotConfig).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/wall-time/i), 'error');
  });

  it('offers Stop for a running run and calls stopAutopilot', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({ activeRun: { run: run({ controlState: 'running' }), cycle: null } }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    const stop = await screen.findByTestId('autopilot-stop');
    expect(stop.textContent).toContain('Stop');
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(api.stopAutopilot).toHaveBeenCalledWith('p1'));
  });

  it('shows "Stopping…" and disables Stop while cancellation settles', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({ activeRun: { run: run({ controlState: 'stopping' }), cycle: null } }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    const stop = await screen.findByTestId('autopilot-stop');
    expect(stop.textContent).toContain('Stopping');
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('autopilot-stopping')).toBeTruthy();
  });

  it('refetches server-authoritative state on websocket reconnect', async () => {
    render(<AutopilotSettingsSection projectId="p1" />);
    await waitFor(() => expect(api.getAutopilot).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event('agenthub:ws_reconnected'));
    await waitFor(() => expect(api.getAutopilot).toHaveBeenCalledTimes(2));
  });

  it('surfaces the deployed URL, verified revision and failure reason for a run', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        activeRun: {
          run: run({
            controlState: 'failed',
            stage: 'verifying',
            failureReason: 'verification failed',
            lastVerifiedSha: 'abcdef1234567890',
          }),
          cycle: {
            cycleNumber: 1,
            selectedImprovement: 'Faster list',
            verification: { ok: false },
            documentation: null,
            outcome: 'failed',
            status: 'failed',
            testedCommitSha: 'abcdef1234567890',
            deploymentId: 'dep-1',
          },
        },
      }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('autopilot-run')).toBeTruthy());
    expect(screen.getByTestId('autopilot-deployed-url').getAttribute('href')).toBe(
      'http://127.0.0.1:8080',
    );
    expect(screen.getByTestId('autopilot-failure-reason').textContent).toContain(
      'verification failed',
    );
    expect(screen.getByTestId('autopilot-run').textContent).toContain('abcdef1234');
  });

  it('renders verification evidence and documentation content, including failure evidence', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: {
          run: run({ controlState: 'failed', stage: 'verifying' }),
          cycle: {
            cycleNumber: 1,
            selectedImprovement: 'Speed up list',
            verification: {
              judgement: { ok: false, reason: 'baseline_regression', detail: 'home journey broke' },
              evidence: {
                origin: 'http://127.0.0.1:8080',
                observedSha: 'abcdef1234567890',
                healthCheck: { url: 'http://127.0.0.1:8080/health', ok: true },
                criteria: [
                  {
                    criterionId: 'home',
                    passed: false,
                    kind: 'browser',
                    observed: 'blank page',
                    tracePath: '/tmp/home.zip',
                  },
                ],
              },
            },
            documentation: {
              expectedBenefit: 'faster first paint',
              actualChange: 'memoized rows',
              outcome: 'failed',
              nextAction: 'retry with a smaller change',
              decisions: [{ key: 'arch', decision: 'memoize' }],
              links: { deploymentOrigin: 'http://127.0.0.1:8080', testedCommitSha: 'abc123' },
              evidence: [{ kind: 'screenshot', path: '/tmp/a.png' }],
              journalSlug: 'autopilot-journal',
              wikiSlugs: [],
            },
            outcome: 'failed',
            status: 'failed',
            testedCommitSha: 'abc123',
            deploymentId: 'dep-1',
          },
        },
      }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('autopilot-evidence')).toBeTruthy());
    expect(screen.getByTestId('autopilot-evidence-verdict').textContent).toMatch(/failed/i);
    expect(screen.getByTestId('autopilot-evidence-failure').textContent).toContain(
      'home journey broke',
    );
    expect(screen.getByTestId('autopilot-evidence').textContent).toContain('/tmp/home.zip');
    const docs = screen.getByTestId('autopilot-documentation');
    expect(docs.textContent).toContain('faster first paint');
    expect(docs.textContent).toContain('memoized rows');
    expect(screen.getByTestId('autopilot-doc-links').textContent).toContain('127.0.0.1:8080');
  });

  it('renders a live activity feed and labels leftover failed evidence as last evaluation', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: {
          run: run({ controlState: 'running', stage: 'implementing' }),
          cycle: {
            cycleNumber: 1,
            selectedImprovement: null,
            verification: {
              judgement: { ok: false, reason: 'missing_evidence', detail: 'no Hub capture' },
            },
            documentation: null,
            outcome: null,
            status: 'active',
            testedCommitSha: 'abc',
            deploymentId: 'dep-1',
          },
          events: [
            {
              id: 'e-resume',
              type: 'resumed',
              createdAt: '2026-09-16T18:30:26.000Z',
              seq: 56,
            },
            {
              id: 'e-impl',
              type: 'operation_started',
              payload: { kind: 'implement' },
              createdAt: '2026-09-16T18:30:28.000Z',
              seq: 57,
              operationId: 'op-1',
            },
          ],
          operations: [
            {
              id: 'op-1',
              kind: 'implement',
              status: 'in_flight',
              sessionId: 'dd09bb4b-aaaa-bbbb-cccc-ddddeeee0001',
              createdAt: '2026-09-16T18:30:28.000Z',
              updatedAt: '2026-09-16T18:30:28.000Z',
            },
          ],
        },
      }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    await waitFor(() => expect(screen.getByTestId('autopilot-activity')).toBeTruthy());
    expect(screen.getByTestId('autopilot-current-work').textContent).toMatch(
      /implement in flight/i,
    );
    expect(screen.getByTestId('autopilot-activity-log').textContent).toMatch(/Started implement/);
    expect(screen.getByTestId('autopilot-evidence').textContent).toMatch(/Last evaluation/i);
    expect(screen.getByTestId('autopilot-evidence-stale').textContent).toMatch(/implementing/i);
  });

  it('resumes a paused run and applies the running snapshot', async () => {
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: {
          run: run({ controlState: 'paused', stage: null }),
          cycle: null,
          stateVersion: 1,
        },
        stateVersion: 1,
      }),
    );
    // The reconciling GET after Resume fails, so only the mutation snapshot drives state.
    (api.getAutopilot as any).mockRejectedValue(new Error('reconcile GET fails'));
    (api.resumeAutopilot as any).mockResolvedValue({
      run: run({ controlState: 'running' }),
      cycle: null,
      stateVersion: 5,
    });
    render(<AutopilotSettingsSection projectId="p1" />);
    const resume = await screen.findByTestId('autopilot-resume');
    expect(screen.queryByTestId('autopilot-pause')).toBeNull();
    fireEvent.click(resume);
    await waitFor(() => expect(api.resumeAutopilot).toHaveBeenCalledWith('p1'));
    await waitFor(() =>
      expect(screen.getByTestId('autopilot-run-state').textContent).toContain('Running'),
    );
  });

  it('keeps enablement controls in Project Configuration', async () => {
    render(<AutopilotSettingsSection projectId="p1" />);
    await screen.findByTestId('autopilot-setup');
    expect(screen.queryByTestId('autopilot-disable')).toBeNull();
    expect(screen.queryByTestId('autopilot-enable-toggle')).toBeNull();
  });

  it('surfaces an error toast when a run-control action fails', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: { run: run({ controlState: 'running' }), cycle: null },
      }),
    );
    (api.pauseAutopilot as any).mockRejectedValue(new Error('pause rejected by server'));
    const showToast = vi.fn();
    render(<AutopilotSettingsSection projectId="p1" showToast={showToast} />);
    fireEvent.click(await screen.findByTestId('autopilot-pause'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/pause rejected by server/i),
        'error',
      ),
    );
  });

  it('marks a run-control action busy while it is pending', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: { run: run({ controlState: 'running' }), cycle: null },
      }),
    );
    // Pause never resolves, so it stays in flight for the whole test.
    (api.pauseAutopilot as any).mockReturnValue(new Promise(() => {}));
    render(<AutopilotSettingsSection projectId="p1" />);
    const pause = await screen.findByTestId('autopilot-pause');
    fireEvent.click(pause);
    // A second Pause while the first is pending must be refused.
    fireEvent.click(pause);
    expect(api.pauseAutopilot).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((pause as HTMLButtonElement).disabled).toBe(true));
  });

  it('surfaces the evaluator-score and code-only-rollback limits in the run view', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({ activeRun: { run: run({ controlState: 'running' }), cycle: null } }),
    );
    render(<AutopilotSettingsSection projectId="p1" />);
    const caveats = await screen.findByTestId('autopilot-run-caveats');
    expect(caveats.textContent).toMatch(/do not prove product value/i);
    expect(caveats.textContent).toMatch(/monotonic improvement/i);
    expect(caveats.textContent).toMatch(/code rollback is not a database rollback/i);
    expect(caveats.textContent).toContain('docs/guides/experimental-autopilot.md');
  });

  it('discards a stale project response after switching projects', async () => {
    let resolveA: (v: any) => void = () => {};
    const aPromise = new Promise((r) => {
      resolveA = r;
    });
    (api.getAutopilot as any).mockImplementation((pid: string) =>
      pid === 'projA'
        ? aPromise
        : Promise.resolve(
            state({ config: readyConfig({ projectId: 'projB', brief: 'brief for B' }) }),
          ),
    );

    const { rerender } = render(<AutopilotSettingsSection projectId="projA" />);
    // Switch to B before A's slow response arrives.
    rerender(<AutopilotSettingsSection projectId="projB" />);
    await waitFor(() =>
      expect((screen.getByTestId('autopilot-brief') as HTMLTextAreaElement).value).toBe(
        'brief for B',
      ),
    );

    // A resolves late — it must not overwrite B's loaded config.
    resolveA(state({ config: readyConfig({ projectId: 'projA', brief: 'brief for A' }) }));
    await Promise.resolve();
    await Promise.resolve();
    expect((screen.getByTestId('autopilot-brief') as HTMLTextAreaElement).value).toBe(
      'brief for B',
    );
  });

  it('discards a deferred mutation completion after switching projects', async () => {
    // Each project's GET resolves immediately with its own brief.
    (api.getAutopilot as any).mockImplementation((pid: string) =>
      Promise.resolve(state({ config: readyConfig({ projectId: pid, brief: `brief ${pid}` }) })),
    );
    // The enable mutation on project A is deferred until we release it.
    let resolvePut: (v: any) => void = () => {};
    (api.putAutopilotConfig as any).mockReturnValue(
      new Promise((r) => {
        resolvePut = r;
      }),
    );

    const { rerender } = render(<AutopilotSettingsSection projectId="projA" />);
    await waitFor(() =>
      expect((screen.getByTestId('autopilot-brief') as HTMLTextAreaElement).value).toBe(
        'brief projA',
      ),
    );
    // Start the enable mutation on A, then switch to B before it resolves.
    fireEvent.click(screen.getByTestId('autopilot-save-config'));
    rerender(<AutopilotSettingsSection projectId="projB" />);
    await waitFor(() =>
      expect((screen.getByTestId('autopilot-brief') as HTMLTextAreaElement).value).toBe(
        'brief projB',
      ),
    );

    const getCallsBefore = (api.getAutopilot as any).mock.calls.length;
    // A's mutation finishes now — its completion must NOT reload A or overwrite B.
    resolvePut(readyConfig({ projectId: 'projA', enabled: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect((screen.getByTestId('autopilot-brief') as HTMLTextAreaElement).value).toBe(
      'brief projB',
    );
    // No extra reload was triggered by the stale mutation completion.
    const projAReloads = (api.getAutopilot as any).mock.calls
      .slice(getCallsBefore)
      .filter((c: any[]) => c[0] === 'projA');
    expect(projAReloads).toHaveLength(0);
  });

  it('does not erase edits typed while a save is in flight', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({ config: readyConfig({ brief: 'saved brief' }) }),
    );
    let resolvePut: (v: any) => void = () => {};
    (api.putAutopilotConfig as any).mockReturnValue(
      new Promise((r) => {
        resolvePut = r;
      }),
    );

    render(<AutopilotSettingsSection projectId="p1" />);
    const brief = () => screen.getByTestId('autopilot-brief') as HTMLTextAreaElement;
    await waitFor(() => expect(brief().value).toBe('saved brief'));

    // Edit, submit the save, then keep typing while the PUT is pending.
    fireEvent.change(brief(), { target: { value: 'work in progress' } });
    fireEvent.click(screen.getByTestId('autopilot-save-config'));
    fireEvent.change(brief(), { target: { value: 'work in progress + more' } });

    // The reconciling GET returns the older saved config.
    (api.getAutopilot as any).mockResolvedValue(
      state({ config: readyConfig({ brief: 'saved brief' }) }),
    );
    resolvePut(readyConfig({ brief: 'work in progress' }));
    await Promise.resolve();
    await Promise.resolve();

    // The text typed during the PUT must survive.
    await waitFor(() => expect(brief().value).toBe('work in progress + more'));
  });

  it('serializes repeated Save — no overlapping config PUTs', async () => {
    (api.getAutopilot as any).mockResolvedValue(state({ config: readyConfig({ enabled: true }) }));
    // PUT never resolves, so the first request stays in flight.
    (api.putAutopilotConfig as any).mockReturnValue(new Promise(() => {}));

    render(<AutopilotSettingsSection projectId="p1" />);
    const save = await screen.findByTestId('autopilot-save-config');
    fireEvent.click(save);
    // A second submit while the first is pending must be refused.
    fireEvent.click(save);

    expect(api.putAutopilotConfig).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
  });

  it('hides setup and controls for disabled project deep links', async () => {
    (api.getAutopilot as any).mockResolvedValue(state({ config: readyConfig({ enabled: false }) }));
    render(<AutopilotSettingsSection projectId="p1" />);
    await screen.findByTestId('autopilot-disabled');
    expect(screen.queryByTestId('autopilot-setup')).toBeNull();
    expect(screen.queryByTestId('autopilot-controls')).toBeNull();
    expect(screen.queryByTestId('autopilot-enable-toggle')).toBeNull();
    expect(api.putAutopilotConfig).not.toHaveBeenCalled();
  });

  it('a stale Save from a prior visit cannot release the current Save slot (A→B→A)', async () => {
    (api.getAutopilot as any).mockImplementation((pid: string) =>
      Promise.resolve(
        state({ config: readyConfig({ projectId: pid, enabled: true, brief: `brief ${pid}` }) }),
      ),
    );
    const resolvers: ((v: any) => void)[] = [];
    (api.putAutopilotConfig as any).mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r);
        }),
    );

    const brief = () => screen.getByTestId('autopilot-brief') as HTMLTextAreaElement;
    const save = () => screen.getByTestId('autopilot-save-config');
    const { rerender } = render(<AutopilotSettingsSection projectId="projA" />);
    await waitFor(() => expect(brief().value).toBe('brief projA'));

    // Save #1 on A (deferred).
    fireEvent.click(save());
    await waitFor(() => expect(save()).toBeDisabled());

    // A → B → A while Save #1 is still pending.
    rerender(<AutopilotSettingsSection projectId="projB" />);
    await waitFor(() => expect(brief().value).toBe('brief projB'));
    rerender(<AutopilotSettingsSection projectId="projA" />);
    await waitFor(() => expect(brief().value).toBe('brief projA'));

    // Save #2 on A (same 'enable' key as Save #1), also deferred.
    fireEvent.click(save());
    await waitFor(() => expect(save()).toBeDisabled());
    expect(api.putAutopilotConfig).toHaveBeenCalledTimes(2);

    // The ORIGINAL Save #1 resolves — it must neither reload nor free Save #2's
    // slot; Save stays disabled and no new request is issued.
    resolvers[0](readyConfig({ projectId: 'projA', enabled: true, brief: 'stale' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(save()).toBeDisabled();
    expect(api.putAutopilotConfig).toHaveBeenCalledTimes(2);

    // Save #2 resolves — now the slot is released normally.
    resolvers[1](readyConfig({ projectId: 'projA', enabled: true, brief: 'brief projA' }));
    await waitFor(() => expect(save()).not.toBeDisabled());
  });

  it('keeps a pending Save owned across a Stop completion', async () => {
    (api.getAutopilot as any).mockResolvedValue(
      state({
        config: readyConfig({ enabled: true }),
        activeRun: { run: run({ controlState: 'running' }), cycle: null },
      }),
    );
    // Save's PUT never resolves — it stays in flight for the whole test.
    (api.putAutopilotConfig as any).mockReturnValue(new Promise(() => {}));
    (api.stopAutopilot as any).mockResolvedValue({ run: run({ controlState: 'stopping' }) });

    render(<AutopilotSettingsSection projectId="p1" />);
    const save = await screen.findByTestId('autopilot-save-config');
    fireEvent.click(save); // ordinary mutation now in flight
    expect(save).toBeDisabled();

    // Stop, which completes (and reconciles) while Save is still pending.
    fireEvent.click(screen.getByTestId('autopilot-stop'));
    await waitFor(() => expect(api.stopAutopilot).toHaveBeenCalledWith('p1'));

    // Save must remain owned/disabled after Stop settles — a second Save can't
    // start and race the first. Only the original PUT was ever issued.
    await waitFor(() => expect(screen.getByTestId('autopilot-save-config')).toBeDisabled());
    expect(api.putAutopilotConfig).toHaveBeenCalledTimes(1);
  });

  it('keeps the started run visible when the reconciling refresh fails', async () => {
    // Initial load: enabled + ready, no active run.
    (api.getAutopilot as any).mockResolvedValueOnce(
      state({ config: readyConfig({ enabled: true }), activeRun: null }),
    );
    // Start returns an authoritative running snapshot...
    (api.startAutopilot as any).mockResolvedValue({
      run: run({ controlState: 'running' }),
      cycle: null,
    });
    // ...but the reconciling GET after Start fails.
    (api.getAutopilot as any).mockRejectedValue(new Error('network blip'));

    render(<AutopilotSettingsSection projectId="p1" />);
    const start = await screen.findByTestId('autopilot-start');
    fireEvent.click(start);

    // The run is visible from the mutation's own response despite the failed
    // refresh — the operator can still see and stop it.
    await waitFor(() =>
      expect(screen.getByTestId('autopilot-run-state').textContent).toContain('Running'),
    );
    expect(screen.getByTestId('autopilot-stop')).toBeTruthy();
  });
});
