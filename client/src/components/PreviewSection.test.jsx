import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import PreviewSection, {
  buildPatchPayload,
  formFromProject,
  shallowEqualForm,
  PREVIEW_MODES,
} from './PreviewSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    updateProject: vi.fn(),
    detectProjectPreview: vi.fn(),
    testProjectPreview: vi.fn(),
    startPreviewWizard: vi.fn(),
  },
}));

const projectWithPreview = {
  id: 'proj-1',
  name: 'Demo',
  cwd: '/tmp/demo',
  prEnv: {
    enabled: false,
    healthPath: '/healthz',
    preview: {
      enabled: true,
      startScript: 'pnpm dev',
      captureRoutes: ['/', '/about'],
      idleTTL: 900,
    },
  },
};

const projectWithCompose = {
  id: 'proj-compose',
  name: 'Compose Demo',
  cwd: '/tmp/compose-demo',
  prEnv: {
    enabled: false,
    healthPath: '/healthz',
    preview: {
      enabled: true,
      compose: {
        file: 'docker-compose.yml',
        entryService: 'frontend',
        entryPort: 3001,
        envFile: '.env.preview',
      },
      idleTTL: 900,
      captureRoutes: ['/', '/about'],
    },
  },
};

const newProject = {
  id: 'proj-new',
  name: 'Brand new',
  cwd: '/tmp/new',
  // No prEnv block at all — the "new project" path that should land
  // on Compose mode by default.
};

describe('PreviewSection — pure helpers', () => {
  it('formFromProject hydrates a script-mode project from prEnv.preview.startScript', () => {
    expect(formFromProject(projectWithPreview)).toEqual({
      mode: PREVIEW_MODES.SCRIPT,
      enabled: true,
      startScript: 'pnpm dev',
      composeFile: 'docker-compose.yml',
      composeEntryService: '',
      composeEntryPort: 3000,
      composeEnvFile: '',
      composeServices: [],
      healthPath: '/healthz',
      idleTTL: 900,
      captureRoutes: ['/', '/about'],
    });
  });

  it('formFromProject hydrates a compose-mode project from prEnv.preview.compose', () => {
    expect(formFromProject(projectWithCompose)).toEqual({
      mode: PREVIEW_MODES.COMPOSE,
      enabled: true,
      startScript: 'npm run dev',
      composeFile: 'docker-compose.yml',
      composeEntryService: 'frontend',
      composeEntryPort: 3001,
      composeEnvFile: '.env.preview',
      composeServices: [],
      healthPath: '/healthz',
      idleTTL: 900,
      captureRoutes: ['/', '/about'],
    });
  });

  it('formFromProject defaults a brand-new project (no preview block) to Compose mode', () => {
    const f = formFromProject(newProject);
    expect(f.mode).toBe(PREVIEW_MODES.COMPOSE);
    expect(f.enabled).toBe(false);
    expect(f.composeFile).toBe('docker-compose.yml');
  });

  it('formFromProject falls back to defaults when project is null', () => {
    const f = formFromProject(null);
    expect(f.mode).toBe(PREVIEW_MODES.COMPOSE);
    expect(f.startScript).toBe('npm run dev');
    expect(f.healthPath).toBe('/');
    expect(f.idleTTL).toBe(600);
    expect(f.captureRoutes).toEqual(['/']);
  });

  it('buildPatchPayload emits the compose shape in Compose mode and drops startScript', () => {
    const form = {
      mode: PREVIEW_MODES.COMPOSE,
      enabled: true,
      startScript: 'should-be-dropped',
      composeFile: 'docker-compose.yml',
      composeEntryService: 'frontend',
      composeEntryPort: 3001,
      composeEnvFile: '.env.preview',
      composeServices: [],
      healthPath: '/health',
      idleTTL: 300,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, { prEnv: { enabled: false } });
    expect(payload.prEnv.preview).toEqual({
      enabled: true,
      compose: {
        entryService: 'frontend',
        entryPort: 3001,
        file: 'docker-compose.yml',
        envFile: '.env.preview',
      },
      idleTTL: 300,
      captureRoutes: ['/'],
    });
    // The startScript field must NOT leak through in compose mode —
    // the server's validatePrEnvPreview rejects compose+startScript
    // as mutually exclusive.
    expect(payload.prEnv.preview.startScript).toBeUndefined();
    expect(payload.prEnv.healthPath).toBe('/health');
  });

  it('buildPatchPayload emits the script shape in Script mode and drops compose', () => {
    const form = {
      mode: PREVIEW_MODES.SCRIPT,
      enabled: true,
      startScript: 'pnpm dev',
      composeFile: 'docker-compose.yml',
      composeEntryService: 'frontend',
      composeEntryPort: 3001,
      composeEnvFile: '.env.preview',
      composeServices: [],
      healthPath: '/',
      idleTTL: 600,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, { prEnv: { enabled: false } });
    expect(payload.prEnv.preview).toEqual({
      enabled: true,
      startScript: 'pnpm dev',
      idleTTL: 600,
      captureRoutes: ['/'],
    });
    expect(payload.prEnv.preview.compose).toBeUndefined();
  });

  it('buildPatchPayload omits an empty envFile when none is set', () => {
    const form = {
      mode: PREVIEW_MODES.COMPOSE,
      enabled: true,
      startScript: 'npm run dev',
      composeFile: 'docker-compose.yml',
      composeEntryService: 'web',
      composeEntryPort: 8080,
      composeEnvFile: '   ', // whitespace-only must be stripped
      composeServices: [],
      healthPath: '/',
      idleTTL: 600,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, {});
    expect(payload.prEnv.preview.compose.envFile).toBeUndefined();
  });

  it('buildPatchPayload preserves parent prEnv fields when toggling preview', () => {
    const project = {
      prEnv: {
        enabled: true,
        startScript: 'npm start',
        internalPort: 3000,
      },
    };
    const form = {
      mode: PREVIEW_MODES.SCRIPT,
      enabled: true,
      startScript: 'npm run dev',
      composeFile: 'docker-compose.yml',
      composeEntryService: '',
      composeEntryPort: 3000,
      composeEnvFile: '',
      composeServices: [],
      healthPath: '/health',
      idleTTL: 300,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, project);
    expect(payload.prEnv).toMatchObject({
      enabled: true,
      startScript: 'npm start',
      internalPort: 3000,
      healthPath: '/health',
      preview: {
        enabled: true,
        startScript: 'npm run dev',
        idleTTL: 300,
        captureRoutes: ['/'],
      },
    });
  });

  it('buildPatchPayload omits preview-only fields when disabled', () => {
    const form = {
      mode: PREVIEW_MODES.SCRIPT,
      enabled: false,
      startScript: 'npm run dev',
      composeFile: 'docker-compose.yml',
      composeEntryService: '',
      composeEntryPort: 3000,
      composeEnvFile: '',
      composeServices: [],
      healthPath: '/',
      idleTTL: 600,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, { prEnv: { enabled: false } });
    expect(payload.prEnv.preview).toEqual({ enabled: false });
    expect(payload.prEnv.healthPath).toBe('/');
  });

  it('shallowEqualForm detects mode flips', () => {
    const a = formFromProject(projectWithPreview);
    const b = { ...a, mode: PREVIEW_MODES.COMPOSE };
    expect(shallowEqualForm(a, b)).toBe(false);
  });

  it('shallowEqualForm detects compose-field edits', () => {
    const a = formFromProject(projectWithCompose);
    const b = { ...a, composeEntryService: 'backend' };
    expect(shallowEqualForm(a, b)).toBe(false);
  });

  it('shallowEqualForm detects route additions', () => {
    const a = { ...formFromProject(projectWithPreview) };
    const b = { ...a, captureRoutes: [...a.captureRoutes, '/contact'] };
    expect(shallowEqualForm(a, b)).toBe(false);
  });

  it('round-trip: formFromProject → buildPatchPayload preserves compose shape', () => {
    const initial = formFromProject(projectWithCompose);
    const payload = buildPatchPayload(initial, projectWithCompose);
    expect(payload.prEnv.preview.compose).toEqual({
      file: 'docker-compose.yml',
      entryService: 'frontend',
      entryPort: 3001,
      envFile: '.env.preview',
    });
    // Re-hydrate from the patched server response (we simulate the
    // server preserving what we sent) and confirm the form matches.
    const persisted = {
      ...projectWithCompose,
      prEnv: {
        ...projectWithCompose.prEnv,
        preview: payload.prEnv.preview,
      },
    };
    const rehydrated = formFromProject(persisted);
    expect(rehydrated.mode).toBe(PREVIEW_MODES.COMPOSE);
    expect(rehydrated.composeEntryService).toBe('frontend');
    expect(rehydrated.composeEntryPort).toBe(3001);
  });
});

describe('PreviewSection — render & save', () => {
  beforeEach(() => {
    api.updateProject.mockResolvedValue(projectWithPreview);
    api.detectProjectPreview.mockResolvedValue({ detected: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an empty state when no projects exist', () => {
    const { getByText } = render(<PreviewSection projects={[]} />);
    expect(getByText(/No projects yet/i)).toBeTruthy();
  });

  it('renders the script field for a script-mode project', () => {
    const { getByTestId, queryByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    expect(getByTestId('preview-start-script').value).toBe('pnpm dev');
    expect(getByTestId('preview-health-path').value).toBe('/healthz');
    expect(getByTestId('preview-idle-ttl').value).toBe('900');
    // Compose fields must NOT be rendered in script mode.
    expect(queryByTestId('preview-compose-file')).toBeNull();
    expect(queryByTestId('preview-compose-entry-service')).toBeNull();
  });

  it('renders the compose fields for a compose-mode project', () => {
    const { getByTestId, queryByTestId } = render(
      <PreviewSection projects={[projectWithCompose]} />,
    );
    expect(getByTestId('preview-compose-file').value).toBe('docker-compose.yml');
    expect(getByTestId('preview-compose-entry-service').value).toBe('frontend');
    expect(getByTestId('preview-compose-entry-port').value).toBe('3001');
    expect(getByTestId('preview-compose-env-file').value).toBe('.env.preview');
    // Script field is hidden in compose mode.
    expect(queryByTestId('preview-start-script')).toBeNull();
  });

  it('mode toggle swaps which fields are visible (compose ↔ script)', () => {
    api.updateProject.mockResolvedValue(projectWithCompose);
    const { getByTestId, queryByTestId } = render(
      <PreviewSection projects={[projectWithCompose]} />,
    );
    // Compose fields visible
    expect(getByTestId('preview-compose-file')).toBeTruthy();
    expect(queryByTestId('preview-start-script')).toBeNull();
    // Flip to Script
    fireEvent.click(getByTestId('preview-mode-script'));
    expect(getByTestId('preview-start-script')).toBeTruthy();
    expect(queryByTestId('preview-compose-file')).toBeNull();
    // Flip back to Compose
    fireEvent.click(getByTestId('preview-mode-compose'));
    expect(getByTestId('preview-compose-file')).toBeTruthy();
    expect(queryByTestId('preview-start-script')).toBeNull();
  });

  it('save button is disabled until the form changes', () => {
    const { getByTestId } = render(<PreviewSection projects={[projectWithPreview]} />);
    expect(getByTestId('preview-save-button').disabled).toBe(true);
    fireEvent.change(getByTestId('preview-health-path'), { target: { value: '/ping' } });
    expect(getByTestId('preview-save-button').disabled).toBe(false);
  });

  it('save calls api.updateProject with merged payload', async () => {
    const onProjectsChange = vi.fn();
    const { getByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} onProjectsChange={onProjectsChange} />,
    );
    fireEvent.change(getByTestId('preview-health-path'), { target: { value: '/ping' } });
    fireEvent.click(getByTestId('preview-save-button'));
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledTimes(1);
    });
    const [calledId, calledPayload] = api.updateProject.mock.calls[0];
    expect(calledId).toBe('proj-1');
    expect(calledPayload.prEnv.healthPath).toBe('/ping');
    expect(calledPayload.prEnv.preview.enabled).toBe(true);
    await waitFor(() => expect(onProjectsChange).toHaveBeenCalled());
  });

  it('saving in Compose mode posts the compose-shape payload', async () => {
    api.updateProject.mockResolvedValueOnce(projectWithCompose);
    const { getByTestId } = render(<PreviewSection projects={[projectWithCompose]} />);
    fireEvent.change(getByTestId('preview-compose-entry-service'), {
      target: { value: 'backend' },
    });
    fireEvent.click(getByTestId('preview-save-button'));
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledTimes(1);
    });
    const [, payload] = api.updateProject.mock.calls[0];
    expect(payload.prEnv.preview.compose).toEqual({
      file: 'docker-compose.yml',
      entryService: 'backend',
      entryPort: 3001,
      envFile: '.env.preview',
    });
    expect(payload.prEnv.preview.startScript).toBeUndefined();
  });

  it('surfaces a 400 error inline', async () => {
    api.updateProject.mockRejectedValueOnce(new Error('400: prEnv.healthPath must start with `/`'));
    const { getByTestId, findByText } = render(<PreviewSection projects={[projectWithPreview]} />);
    fireEvent.change(getByTestId('preview-health-path'), { target: { value: 'no-slash' } });
    fireEvent.click(getByTestId('preview-save-button'));
    expect(await findByText(/healthPath must start/)).toBeTruthy();
  });

  it('Re-detect button shows accept/dismiss when the server returns a stack', async () => {
    api.detectProjectPreview.mockResolvedValueOnce({
      detected: {
        stack: 'vite',
        startScript: 'npm run dev',
        port: 5173,
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-detect-button'));
    const suggestion = await findByTestId('preview-suggestion');
    expect(suggestion.textContent).toMatch(/vite/);
    fireEvent.click(getByTestId('preview-suggestion-accept'));
    expect(getByTestId('preview-start-script').value).toBe('npm run dev');
  });

  it('Re-detect compose suggestion populates compose fields and switches mode', async () => {
    api.detectProjectPreview.mockResolvedValueOnce({
      detected: {
        stack: 'compose',
        compose: {
          file: 'docker-compose.yml',
          entryService: 'web',
          entryPort: 8080,
          services: ['web', 'api', 'redis'],
        },
        captureRoutes: ['/'],
        idleTTL: 600,
      },
    });
    // Start from a script-mode project; accepting the compose suggestion
    // should flip the form to compose mode and populate fields.
    const { getByTestId, findByTestId, queryByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-detect-button'));
    const suggestion = await findByTestId('preview-suggestion-compose');
    expect(suggestion.textContent).toMatch(/compose/);
    expect(suggestion.textContent).toMatch(/web/);
    fireEvent.click(getByTestId('preview-suggestion-accept'));
    // After accept, compose fields are visible and populated; script
    // field is hidden.
    expect(getByTestId('preview-compose-file').value).toBe('docker-compose.yml');
    // The detected services pre-populate the select dropdown.
    expect(getByTestId('preview-compose-entry-service-select').value).toBe('web');
    expect(getByTestId('preview-compose-entry-port').value).toBe('8080');
    expect(queryByTestId('preview-start-script')).toBeNull();
  });

  it('Re-detect shows empty-state when the server returns null', async () => {
    api.detectProjectPreview.mockResolvedValueOnce({ detected: null });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-detect-button'));
    expect(await findByTestId('preview-suggestion-empty')).toBeTruthy();
  });

  it('Test button is disabled while form is dirty and re-enabled after save', async () => {
    const { getByTestId } = render(<PreviewSection projects={[projectWithPreview]} />);
    // Clean state, preview enabled → Test button is enabled
    expect(getByTestId('preview-test-button').disabled).toBe(false);
    // Make dirty → Test button disabled
    fireEvent.change(getByTestId('preview-health-path'), { target: { value: '/ping' } });
    expect(getByTestId('preview-test-button').disabled).toBe(true);
    // Save → Test button re-enabled
    fireEvent.click(getByTestId('preview-save-button'));
    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(getByTestId('preview-test-button').disabled).toBe(false);
    });
  });

  it('Test button is enabled in compose mode (uses same /preview/test endpoint)', () => {
    const { getByTestId } = render(<PreviewSection projects={[projectWithCompose]} />);
    expect(getByTestId('preview-test-button').disabled).toBe(false);
  });

  it('Test button is disabled when preview is not enabled', () => {
    const disabled = {
      ...projectWithPreview,
      prEnv: {
        ...projectWithPreview.prEnv,
        preview: { ...projectWithPreview.prEnv.preview, enabled: false },
      },
    };
    const { getByTestId } = render(<PreviewSection projects={[disabled]} />);
    expect(getByTestId('preview-test-button').disabled).toBe(true);
  });

  it('Test preview success renders Ready status + screenshot + View live link', async () => {
    api.testProjectPreview.mockResolvedValueOnce({
      ok: true,
      ports: { allocated: 4200 },
      durationMs: 1200,
      screenshotUrl: '/uploads/preview-tests/abc.png',
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-test-button'));
    // Starting indicator appears immediately
    expect(getByTestId('preview-test-status-starting')).toBeTruthy();
    // Eventually flips to Ready with screenshot + live link
    const ready = await findByTestId('preview-test-status-ready');
    expect(ready.textContent).toMatch(/Ready/);
    expect(getByTestId('preview-test-screenshot').getAttribute('src')).toBe(
      '/uploads/preview-tests/abc.png',
    );
    expect(getByTestId('preview-test-live-link').getAttribute('href')).toBe(
      'http://localhost:4200/',
    );
  });

  it('Test preview failure renders the server error inline', async () => {
    api.testProjectPreview.mockResolvedValueOnce({
      ok: false,
      ports: { allocated: 4201 },
      durationMs: 121000,
      error: 'health check timed out after 120000ms (no response on /healthz).',
      logTail: [],
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-test-button'));
    const failed = await findByTestId('preview-test-status-failed');
    expect(failed.textContent).toMatch(/Failed/);
    expect(getByTestId('preview-test-error').textContent).toMatch(/timed out/);
  });

  it('Test preview failure renders the captured boot log when present', async () => {
    api.testProjectPreview.mockResolvedValueOnce({
      ok: false,
      ports: { allocated: 4202 },
      durationMs: 121000,
      error: 'health check timed out after 120000ms (no response on /).',
      logTail: [
        'vite v5.0.0 dev server starting',
        'Error: listen EADDRINUSE: address already in use :::4202',
      ],
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-test-button'));
    await findByTestId('preview-test-status-failed');
    const log = getByTestId('preview-test-log');
    expect(log.textContent).toMatch(/Console \(2 lines\)/);
    const content = getByTestId('preview-test-log-content');
    expect(content.textContent).toContain('vite v5.0.0 dev server starting');
    expect(content.textContent).toContain('EADDRINUSE');
  });

  it('Test preview success surfaces the captured boot log alongside the screenshot', async () => {
    api.testProjectPreview.mockResolvedValueOnce({
      ok: true,
      ports: { allocated: 4203 },
      durationMs: 1500,
      screenshotUrl: '/uploads/preview-tests/ok.png',
      logTail: ['vite v5.0.0 dev server running', '  ➜  Local:   http://localhost:4203/'],
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-test-button'));
    await findByTestId('preview-test-status-ready');
    const content = getByTestId('preview-test-log-content');
    expect(content.textContent).toContain('vite v5.0.0 dev server running');
    expect(content.textContent).toContain('http://localhost:4203/');
  });

  it('Test panel can be dismissed via the X button', async () => {
    api.testProjectPreview.mockResolvedValueOnce({
      ok: false,
      ports: { allocated: null },
      durationMs: 5,
      error: 'spawn ENOENT',
    });
    const { getByTestId, findByTestId, queryByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-test-button'));
    await findByTestId('preview-test-status-failed');
    fireEvent.click(getByTestId('preview-test-dismiss'));
    await waitFor(() => {
      expect(queryByTestId('preview-test-panel')).toBeNull();
    });
  });

  it('renders the AI Setup button and opens the session on click', async () => {
    api.startPreviewWizard.mockResolvedValueOnce({
      sessionId: 'sess-abc',
      agentId: 'agent-xyz',
    });
    const onOpenSession = vi.fn();
    const { getByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} onOpenSession={onOpenSession} />,
    );
    const button = getByTestId('preview-ai-setup-button');
    expect(button.textContent).toMatch(/AI Setup/);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => {
      expect(api.startPreviewWizard).toHaveBeenCalledWith('proj-1');
    });
    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith({
        sessionId: 'sess-abc',
        agentId: 'agent-xyz',
      });
    });
  });

  it('AI Setup button surfaces an inline error when the server rejects', async () => {
    api.startPreviewWizard.mockRejectedValueOnce(new Error('403: Forbidden'));
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-ai-setup-button'));
    const err = await findByTestId('preview-ai-setup-error');
    expect(err.textContent).toMatch(/Forbidden/);
  });

  it('AI Setup surfaces an error when the parent does not supply onOpenSession', async () => {
    // The previous shape silently stranded the user if the parent
    // (SettingsPage) forgot to thread `onOpenSession` through: the
    // server had already spawned a wizard session, but neither the
    // spinner nor the error banner cleared. The fix turns that
    // missing-handler branch into a surface-able error.
    api.startPreviewWizard.mockResolvedValueOnce({
      sessionId: 'sess-orphan',
      agentId: 'agent-xyz',
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} /* no onOpenSession */ />,
    );
    fireEvent.click(getByTestId('preview-ai-setup-button'));
    const err = await findByTestId('preview-ai-setup-error');
    expect(err.textContent).toMatch(/sess-orphan/);
  });

  it('refetches projects when the agenthub:preview_wizard_complete DOM event fires', async () => {
    const onProjectsChange = vi.fn();
    render(<PreviewSection projects={[projectWithPreview]} onProjectsChange={onProjectsChange} />);
    // Simulate the WS-to-DOM bridge in App.jsx dispatching the event
    // for our project id.
    window.dispatchEvent(
      new CustomEvent('agenthub:preview_wizard_complete', {
        detail: { projectId: 'proj-1' },
      }),
    );
    await waitFor(() => {
      expect(onProjectsChange).toHaveBeenCalled();
    });
  });

  it('ignores agenthub:preview_wizard_complete for a different project id', async () => {
    const onProjectsChange = vi.fn();
    render(<PreviewSection projects={[projectWithPreview]} onProjectsChange={onProjectsChange} />);
    window.dispatchEvent(
      new CustomEvent('agenthub:preview_wizard_complete', {
        detail: { projectId: 'some-other-project' },
      }),
    );
    // Give React a tick to settle. We expect NO refetch.
    await new Promise((r) => setTimeout(r, 20));
    expect(onProjectsChange).not.toHaveBeenCalled();
  });

  it('registers an unsaved-changes guard with the parent', async () => {
    const calls = [];
    const registerGuard = (fn) => calls.push(fn);
    const { getByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} registerGuard={registerGuard} />,
    );
    // Initial registration runs once on mount.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const guard = calls[0];
    expect(typeof guard).toBe('function');
    // Clean (no edits) → guard returns true (allow).
    expect(guard()).toBe(true);
    // Make the form dirty and stub confirm to deny.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(getByTestId('preview-health-path'), { target: { value: '/x' } });
    expect(guard()).toBe(false);
    confirmSpy.mockReturnValue(true);
    expect(guard()).toBe(true);
    confirmSpy.mockRestore();
  });
});
