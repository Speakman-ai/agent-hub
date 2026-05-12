import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PreviewConfirm, { buildPreviewPatch } from './PreviewConfirm.jsx';

const VITE_DETECTED = {
  stack: 'vite',
  startScript: 'npm run dev',
  port: 5173,
  captureRoutes: ['/'],
  idleTTL: 600,
};

describe('PreviewConfirm', () => {
  it('renders the detected summary with framework label and config fields', () => {
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={() => {}} />);
    expect(screen.getByTestId('preview-confirm')).toBeInTheDocument();
    // Framework label is capitalized in the heading copy.
    expect(screen.getByText(/Detected Vite project/i)).toBeInTheDocument();
    const summary = screen.getByTestId('preview-confirm-summary');
    expect(summary).toHaveTextContent('npm run dev');
    expect(summary).toHaveTextContent('5173');
    expect(summary).toHaveTextContent('/');
    expect(summary).toHaveTextContent('600');
  });

  it('handles unknown stack (no detected.stack) gracefully', () => {
    render(
      <PreviewConfirm detected={{ ...VITE_DETECTED, stack: undefined }} onConfirm={() => {}} />,
    );
    expect(screen.getByText(/Unknown stack/i)).toBeInTheDocument();
  });

  it('omits the port line when port is null', () => {
    render(<PreviewConfirm detected={{ ...VITE_DETECTED, port: null }} onConfirm={() => {}} />);
    const summary = screen.getByTestId('preview-confirm-summary');
    expect(summary).not.toHaveTextContent('port hint:');
  });

  it('"Looks good" emits accept with the detected values intact', () => {
    const onConfirm = vi.fn();
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('preview-confirm-accept'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [form, reason] = onConfirm.mock.calls[0];
    expect(reason).toBe('accept');
    expect(form).toMatchObject({
      enabled: true,
      startScript: 'npm run dev',
      port: 5173,
      idleTTL: 600,
    });
    expect(form.captureRoutes).toEqual(['/']);
  });

  it('Edit → modify → Save emits edit with the new form payload', () => {
    const onConfirm = vi.fn();
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('preview-confirm-edit'));

    // Tweak start script and idle TTL.
    fireEvent.change(screen.getByTestId('preview-confirm-startScript'), {
      target: { value: 'pnpm dev' },
    });
    fireEvent.change(screen.getByTestId('preview-confirm-idleTTL'), {
      target: { value: '900' },
    });

    // Add a new capture route via the input + Add button.
    fireEvent.change(screen.getByTestId('preview-confirm-route-input'), {
      target: { value: '/about' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    fireEvent.click(screen.getByTestId('preview-confirm-save-edits'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [form, reason] = onConfirm.mock.calls[0];
    expect(reason).toBe('edit');
    expect(form.startScript).toBe('pnpm dev');
    expect(form.idleTTL).toBe(900);
    expect(form.captureRoutes).toContain('/about');
    expect(form.enabled).toBe(true);
  });

  it('refuses to add an invalid route (no leading slash)', () => {
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={() => {}} />);
    fireEvent.click(screen.getByTestId('preview-confirm-edit'));
    fireEvent.change(screen.getByTestId('preview-confirm-route-input'), {
      target: { value: 'about' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const chips = screen.getByTestId('preview-confirm-routes');
    expect(chips).not.toHaveTextContent('about');
  });

  it('removes a capture route via its X button', () => {
    const detectedWithMultiple = {
      ...VITE_DETECTED,
      captureRoutes: ['/', '/about'],
    };
    const onConfirm = vi.fn();
    render(<PreviewConfirm detected={detectedWithMultiple} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('preview-confirm-edit'));
    fireEvent.click(screen.getByLabelText('Remove route /about'));
    fireEvent.click(screen.getByTestId('preview-confirm-save-edits'));
    const [form] = onConfirm.mock.calls[0];
    expect(form.captureRoutes).toEqual(['/']);
  });

  it('"Skip preview" calls onSkip when provided', () => {
    const onSkip = vi.fn();
    const onConfirm = vi.fn();
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={onConfirm} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('preview-confirm-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('"Skip preview" falls back to onConfirm({ enabled: false }) when onSkip absent', () => {
    const onConfirm = vi.fn();
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('preview-confirm-skip'));
    expect(onConfirm).toHaveBeenCalledWith({ enabled: false }, 'skip');
  });

  it('Cancel from edit mode reverts to the original summary view', () => {
    render(<PreviewConfirm detected={VITE_DETECTED} onConfirm={() => {}} />);
    fireEvent.click(screen.getByTestId('preview-confirm-edit'));
    fireEvent.change(screen.getByTestId('preview-confirm-startScript'), {
      target: { value: 'pnpm dev' },
    });
    fireEvent.click(screen.getByTestId('preview-confirm-cancel-edits'));
    // Summary panel is back, with original startScript.
    expect(screen.getByTestId('preview-confirm-summary')).toHaveTextContent('npm run dev');
  });
});

describe('buildPreviewPatch', () => {
  it('returns null for falsy input', () => {
    expect(buildPreviewPatch(null)).toBeNull();
    expect(buildPreviewPatch(undefined)).toBeNull();
  });

  it('emits a disabled preview block when skipped', () => {
    expect(buildPreviewPatch({ enabled: false })).toEqual({
      prEnv: { enabled: false, preview: { enabled: false } },
    });
  });

  it('emits enabled preview with the accepted form fields', () => {
    expect(
      buildPreviewPatch({
        enabled: true,
        startScript: 'npm run dev',
        captureRoutes: ['/', '/about'],
        idleTTL: 600,
      }),
    ).toEqual({
      prEnv: {
        enabled: false,
        preview: {
          enabled: true,
          startScript: 'npm run dev',
          captureRoutes: ['/', '/about'],
          idleTTL: 600,
        },
      },
    });
  });

  it('skips startScript when blank and skips idleTTL when not an integer', () => {
    expect(
      buildPreviewPatch({
        enabled: true,
        startScript: '',
        captureRoutes: ['/'],
        idleTTL: 'not-a-number',
      }),
    ).toEqual({
      prEnv: {
        enabled: false,
        preview: { enabled: true, captureRoutes: ['/'] },
      },
    });
  });

  it('omits idleTTL when the field is an empty string (cleared input)', () => {
    // Regression: an empty-string idleTTL used to be coerced to 0
    // (Number('') === 0 && Number.isInteger(0)), which the server may
    // reject or accept (instant idle-out). The guard must skip the field
    // so the server default applies.
    const patch = buildPreviewPatch({
      enabled: true,
      startScript: 'npm run dev',
      captureRoutes: ['/'],
      idleTTL: '',
    });
    expect(patch.prEnv.preview).not.toHaveProperty('idleTTL');
    expect(patch).toEqual({
      prEnv: {
        enabled: false,
        preview: { enabled: true, startScript: 'npm run dev', captureRoutes: ['/'] },
      },
    });
  });

  it('omits idleTTL when null or zero or negative', () => {
    expect(buildPreviewPatch({ enabled: true, idleTTL: null }).prEnv.preview).not.toHaveProperty(
      'idleTTL',
    );
    expect(buildPreviewPatch({ enabled: true, idleTTL: 0 }).prEnv.preview).not.toHaveProperty(
      'idleTTL',
    );
    expect(buildPreviewPatch({ enabled: true, idleTTL: -60 }).prEnv.preview).not.toHaveProperty(
      'idleTTL',
    );
  });

  it('clamps idleTTL to the input min/max range (60..86400)', () => {
    // Below min — clamps up to 60.
    expect(buildPreviewPatch({ enabled: true, idleTTL: 30 }).prEnv.preview.idleTTL).toBe(60);
    // Above max — clamps down to 86400.
    expect(buildPreviewPatch({ enabled: true, idleTTL: 999999 }).prEnv.preview.idleTTL).toBe(86400);
    // In-range — passes through.
    expect(buildPreviewPatch({ enabled: true, idleTTL: 600 }).prEnv.preview.idleTTL).toBe(600);
  });

  it('drops empty / whitespace routes from captureRoutes', () => {
    expect(
      buildPreviewPatch({
        enabled: true,
        startScript: 'npm run dev',
        captureRoutes: ['/', '', '   ', '/about'],
        idleTTL: 600,
      }),
    ).toEqual({
      prEnv: {
        enabled: false,
        preview: {
          enabled: true,
          startScript: 'npm run dev',
          captureRoutes: ['/', '/about'],
          idleTTL: 600,
        },
      },
    });
  });
});
