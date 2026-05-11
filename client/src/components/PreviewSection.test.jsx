import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import PreviewSection, {
  buildPatchPayload,
  formFromProject,
  shallowEqualForm,
} from './PreviewSection.jsx';
import { api } from '../utils/api.js';

vi.mock('../utils/api.js', () => ({
  api: {
    updateProject: vi.fn(),
    detectProjectPreview: vi.fn(),
    testProjectPreview: vi.fn(),
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

describe('PreviewSection — pure helpers', () => {
  it('formFromProject hydrates from project.prEnv.preview', () => {
    expect(formFromProject(projectWithPreview)).toEqual({
      enabled: true,
      startScript: 'pnpm dev',
      healthPath: '/healthz',
      idleTTL: 900,
      captureRoutes: ['/', '/about'],
    });
  });

  it('formFromProject falls back to defaults when prEnv is empty', () => {
    expect(formFromProject({ id: 'p', name: 'p' })).toEqual({
      enabled: false,
      startScript: 'npm run dev',
      healthPath: '/',
      idleTTL: 600,
      captureRoutes: ['/'],
    });
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
      enabled: true,
      startScript: 'npm run dev',
      healthPath: '/health',
      idleTTL: 300,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, project);
    expect(payload).toEqual({
      prEnv: {
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
      },
    });
  });

  it('buildPatchPayload omits preview-only fields when disabled', () => {
    const form = {
      enabled: false,
      startScript: 'npm run dev',
      healthPath: '/',
      idleTTL: 600,
      captureRoutes: ['/'],
    };
    const payload = buildPatchPayload(form, { prEnv: { enabled: false } });
    expect(payload.prEnv.preview).toEqual({ enabled: false });
    expect(payload.prEnv.healthPath).toBe('/');
  });

  it('shallowEqualForm detects route additions', () => {
    const a = { ...formFromProject(projectWithPreview) };
    const b = { ...a, captureRoutes: [...a.captureRoutes, '/contact'] };
    expect(shallowEqualForm(a, b)).toBe(false);
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

  it('renders form fields hydrated from the project', () => {
    const { getByTestId } = render(<PreviewSection projects={[projectWithPreview]} />);
    expect(getByTestId('preview-start-script').value).toBe('pnpm dev');
    expect(getByTestId('preview-health-path').value).toBe('/healthz');
    expect(getByTestId('preview-idle-ttl').value).toBe('900');
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
      durationMs: 31000,
      error: 'health check timed out after 30000ms (no response on /healthz).',
    });
    const { getByTestId, findByTestId } = render(
      <PreviewSection projects={[projectWithPreview]} />,
    );
    fireEvent.click(getByTestId('preview-test-button'));
    const failed = await findByTestId('preview-test-status-failed');
    expect(failed.textContent).toMatch(/Failed/);
    expect(getByTestId('preview-test-error').textContent).toMatch(/timed out/);
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
