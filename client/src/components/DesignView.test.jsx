import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import DesignView, { clampSplitPct } from './DesignView.jsx';

// PDF export utility is side-effecty (DOM iframe + html2canvas + jsPDF). The
// component-level tests mock it to a resolved promise so they can assert
// wiring (button rendered, disabled states, click → util called) without
// touching jsdom's limited canvas/PDF support. A dedicated unit test for the
// util lives in ../utils/exportDesignPdf.test.js.
vi.mock('../utils/exportDesignPdf.js', () => ({
  exportDesignPdf: vi.fn(() => Promise.resolve()),
}));
vi.mock('../utils/api.js', () => ({
  api: {
    getModelConfig: vi.fn(() =>
      Promise.resolve({
        defaultModel: 'claude-opus-4-8',
        engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
        engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'] },
      }),
    ),
    getMyAgentModelOverrides: vi.fn(() => Promise.resolve({ agentModelOverrides: {} })),
    putMyAgentModelOverride: vi.fn((_id, body) =>
      Promise.resolve({ agentModelOverrides: { __design_studio__: body.model } }),
    ),
    deleteMyAgentModelOverride: vi.fn(() => Promise.resolve({ agentModelOverrides: {} })),
    updateDesign: vi.fn(() => Promise.resolve({})),
    forwardDesign: vi.fn(() =>
      Promise.resolve({ session: { id: 'sess-fwd', agent_id: 'agent-b', name: '[Design Fwd] X' } }),
    ),
  },
}));
import { exportDesignPdf } from '../utils/exportDesignPdf.js';
import { api } from '../utils/api.js';

/**
 * DesignView — split-pane behavior.
 *
 * The Design canvas fetches index.html as text and feeds it to the iframe
 * via `srcdoc` (to bypass the nginx-deployed `X-Frame-Options: DENY`).
 * `reloadToken` is appended to the fetch URL as a cache-buster; bumping it
 * must trigger a fresh fetch so the canvas stays in sync with agent writes
 * (server emits `design_updated`, App.jsx bumps the token).
 */
describe('DesignView', () => {
  let matchMediaListeners;

  beforeEach(() => {
    matchMediaListeners = [];
    // jsdom doesn't implement matchMedia — provide a default mock (mobile: false).
    window.matchMedia = vi.fn((query) => ({
      matches: false,
      media: query,
      addEventListener: (_event, handler) => matchMediaListeners.push(handler),
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));

    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html><head></head><body></body></html>'),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseDesign = {
    id: 'd-1',
    name: 'Sales dashboard',
    linkedProjects: [],
  };

  const baseProps = {
    design: baseDesign,
    messages: [],
    streaming: null,
    thinking: false,
    processing: false,
    reloadToken: 0,
    send: () => {},
    onBack: () => {},
    onManualReload: () => {},
    agents: [
      {
        id: 'a1',
        name: 'Lead',
        engine: 'claude-code',
        projectId: 'p1',
        projectName: 'Hub',
        color: '#3b82f6',
        active: true,
      },
    ],
  };

  it('renders the design name in the header', () => {
    render(<DesignView {...baseProps} />);
    expect(screen.getByText('Sales dashboard')).toBeInTheDocument();
  });

  it('shows engine and model selectors after model config loads', async () => {
    render(<DesignView {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByTestId('design-studio-engine')).toBeInTheDocument();
      expect(screen.getByTestId('design-studio-model')).toBeInTheDocument();
    });
  });

  it('fetches index.html with the reloadToken cache-buster and renders a sandboxed srcdoc iframe', async () => {
    const { container } = render(<DesignView {...baseProps} reloadToken={0} />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const fetchUrl = globalThis.fetch.mock.calls[0][0];
    expect(fetchUrl).toContain('/design-files/d-1/index.html');
    expect(fetchUrl).toContain('v=0');

    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).toBeTruthy();
      // Security: must be sandboxed
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    });
  });

  // Regression: `/design-files/` is NOT behind authMiddleware (which only
  // guards `/api/*`), and `cors-config.ts` sets `credentials: false`. Using
  // `credentials: 'include'` here causes the browser to reject the response
  // in remote mode (Vite client on localhost:3050 → hub on EC2) with
  // "Access-Control-Allow-Credentials must be 'true'". Keep credentials off.
  it('does not send fetch with credentials: include (would break cross-origin remote mode)', async () => {
    render(<DesignView {...baseProps} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const initArg = globalThis.fetch.mock.calls[0][1];
    // Either no init object at all, or an init without credentials set.
    if (initArg) {
      expect(initArg.credentials).not.toBe('include');
    }
  });

  it('re-fetches index.html when reloadToken increments', async () => {
    const { rerender } = render(<DesignView {...baseProps} reloadToken={0} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    expect(globalThis.fetch.mock.calls[0][0]).toContain('v=0');

    rerender(<DesignView {...baseProps} reloadToken={1} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    expect(globalThis.fetch.mock.calls[1][0]).toContain('v=1');
  });

  it('renders past messages in the chat pane', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'Make a hero', created_at: new Date().toISOString() },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Done — index.html updated.',
        created_at: new Date().toISOString(),
      },
    ];
    render(<DesignView {...baseProps} messages={messages} />);
    expect(screen.getByText('Make a hero')).toBeInTheDocument();
    expect(screen.getByText('Done — index.html updated.')).toBeInTheDocument();
  });

  it('sends a design_chat WS message when the user submits the composer', () => {
    const send = vi.fn();
    render(<DesignView {...baseProps} send={send} />);
    const textbox = screen.getByPlaceholderText(/describe what to build/i);
    fireEvent.change(textbox, { target: { value: 'purple gradient hero' } });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: false });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'design_chat',
      designId: 'd-1',
      content: 'purple gradient hero',
    });
  });

  it('shows a Cancel button that emits design_cancel while processing', () => {
    const send = vi.fn();
    render(<DesignView {...baseProps} send={send} processing={true} />);
    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);
    expect(send).toHaveBeenCalledWith({ type: 'design_cancel', designId: 'd-1' });
  });

  // The split pane between chat and canvas is adjustable — users can shrink
  // the chat panel to give the iframe more room. The resizer is a keyboard-
  // focusable separator that also supports pointer-drag and double-click-to-
  // reset. Split % is clamped to [15, 85] and persisted to localStorage.
  describe('resizable split pane', () => {
    beforeEach(() => {
      globalThis.localStorage?.removeItem('designSplitPct');
    });

    it('clampSplitPct clamps out-of-range values and falls back to 50 for NaN', () => {
      expect(clampSplitPct(50)).toBe(50);
      expect(clampSplitPct(5)).toBe(15);
      expect(clampSplitPct(99)).toBe(85);
      expect(clampSplitPct('not-a-number')).toBe(50);
    });

    it('renders a draggable resizer separator between the two panes', () => {
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      expect(resizer).toBeTruthy();
      expect(resizer.getAttribute('role')).toBe('separator');
      expect(resizer.getAttribute('aria-orientation')).toBe('vertical');
    });

    it('shrinks the chat pane when ArrowLeft is pressed on the resizer', () => {
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      // Default is 50. ArrowLeft with no shift = step 2 → 48.
      expect(resizer.getAttribute('aria-valuenow')).toBe('50');
      act(() => {
        resizer.focus();
        fireEvent.keyDown(resizer, { key: 'ArrowLeft' });
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('48');
    });

    it('Home key snaps chat pane to its minimum width and End to its maximum', () => {
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      act(() => {
        fireEvent.keyDown(resizer, { key: 'Home' });
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('15');
      act(() => {
        fireEvent.keyDown(resizer, { key: 'End' });
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('85');
    });

    it('persists the split percentage to localStorage after resizing', () => {
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      act(() => {
        fireEvent.keyDown(resizer, { key: 'ArrowRight', shiftKey: true }); // +5 → 55
      });
      expect(globalThis.localStorage.getItem('designSplitPct')).toBe('55');
    });

    it('restores the persisted split percentage on mount', () => {
      globalThis.localStorage.setItem('designSplitPct', '30');
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      expect(resizer.getAttribute('aria-valuenow')).toBe('30');
    });

    it('double-click on the resizer resets the split back to 50', () => {
      globalThis.localStorage.setItem('designSplitPct', '25');
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      expect(resizer.getAttribute('aria-valuenow')).toBe('25');
      act(() => {
        fireEvent.doubleClick(resizer);
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('50');
    });

    // The headline interaction is pointer-drag; exercise the full
    // pointerdown → window pointermove → pointerup sequence so a regression
    // in onResizerPointerDown (e.g. forgetting to attach listeners, bad
    // math, not clamping) is caught.
    it('pointer-drag updates the split percentage based on container geometry', () => {
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      const splitContainer = resizer.parentElement;
      // Stub the container's bounding rect so the pointer math is deterministic.
      vi.spyOn(splitContainer, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        width: 1000,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      act(() => {
        fireEvent.pointerDown(resizer, { clientX: 500 });
      });
      // Drag to x=300 → ~30% (minus the small 4px resizer-width compensation).
      // Window-level listeners drive the move.
      act(() => {
        window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 300 }));
      });
      const mid = parseInt(resizer.getAttribute('aria-valuenow'), 10);
      expect(mid).toBeGreaterThanOrEqual(29);
      expect(mid).toBeLessThanOrEqual(31);

      // Dragging far left should clamp to the 15% minimum, never below.
      act(() => {
        window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: -200 }));
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('15');

      // Release — subsequent moves should no longer update the split.
      act(() => {
        window.dispatchEvent(new window.PointerEvent('pointerup'));
      });
      act(() => {
        window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 900 }));
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('15');
      // After release the persistence effect should have written the final value.
      expect(globalThis.localStorage.getItem('designSplitPct')).toBe('15');
    });

    it('Enter and Space reset the split to the default of 50', () => {
      globalThis.localStorage.setItem('designSplitPct', '30');
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      expect(resizer.getAttribute('aria-valuenow')).toBe('30');
      act(() => {
        fireEvent.keyDown(resizer, { key: 'Enter' });
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('50');
      act(() => {
        fireEvent.keyDown(resizer, { key: 'ArrowLeft' }); // 48
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('48');
      act(() => {
        fireEvent.keyDown(resizer, { key: ' ' });
      });
      expect(resizer.getAttribute('aria-valuenow')).toBe('50');
    });

    it('does not apply inline flexBasis styles on mobile viewports (<768px)', () => {
      // jsdom default matchMedia returns false for all queries,
      // which simulates a narrow (mobile) viewport.
      globalThis.localStorage.setItem('designSplitPct', '70');
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      // The chat pane is the element before the resizer
      const chatPane = resizer.previousElementSibling;
      expect(chatPane.style.flexBasis).toBe('');
    });

    it('applies inline flexBasis styles on desktop viewports (≥768px)', () => {
      // Override the default mock to simulate a desktop viewport.
      window.matchMedia = vi.fn((query) => ({
        matches: query === '(min-width: 768px)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }));

      globalThis.localStorage.setItem('designSplitPct', '70');
      render(<DesignView {...baseProps} />);
      const resizer = screen.getByTestId('design-split-resizer');
      const chatPane = resizer.previousElementSibling;
      expect(chatPane.style.flexBasis).toBe('70%');
    });
  });

  describe('PDF export', () => {
    beforeEach(() => {
      exportDesignPdf.mockClear();
    });

    it('renders a Download PDF button in the header', () => {
      render(<DesignView {...baseProps} />);
      expect(screen.getByLabelText(/download design as pdf/i)).toBeInTheDocument();
    });

    it('invokes exportDesignPdf with the design id and name when clicked', async () => {
      render(<DesignView {...baseProps} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      fireEvent.click(btn);

      await waitFor(() => {
        expect(exportDesignPdf).toHaveBeenCalledTimes(1);
      });
      const call = exportDesignPdf.mock.calls[0][0];
      expect(call.designId).toBe('d-1');
      expect(call.filename).toBe('Sales dashboard');
      expect(typeof call.base).toBe('string');
    });

    it('disables the PDF button while the agent is processing', () => {
      render(<DesignView {...baseProps} processing={true} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      expect(btn).toBeDisabled();
    });

    it('disables the PDF button while the agent is streaming', () => {
      render(<DesignView {...baseProps} streaming={{ content: 'partial' }} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      expect(btn).toBeDisabled();
    });

    it('does not call exportDesignPdf when clicked while disabled', () => {
      render(<DesignView {...baseProps} processing={true} />);
      const btn = screen.getByLabelText(/download design as pdf/i);
      fireEvent.click(btn);
      expect(exportDesignPdf).not.toHaveBeenCalled();
    });
  });

  describe('Forward to agent', () => {
    beforeEach(() => {
      api.forwardDesign.mockClear();
    });

    it('renders Forward control in the header', () => {
      render(<DesignView {...baseProps} />);
      expect(screen.getByTestId('design-forward-open')).toBeInTheDocument();
    });

    it('opens the modal and calls forwardDesign when an agent is chosen and submitted', async () => {
      const onDesignForwarded = vi.fn();
      render(<DesignView {...baseProps} onDesignForwarded={onDesignForwarded} />);
      fireEvent.click(screen.getByTestId('design-forward-open'));
      expect(await screen.findByTestId('forward-design-modal-backdrop')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Lead'));
      fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
      await waitFor(() => {
        expect(api.forwardDesign).toHaveBeenCalledWith(
          'd-1',
          expect.objectContaining({ targetAgentId: 'a1' }),
        );
        expect(onDesignForwarded).toHaveBeenCalled();
      });
    });
  });

  // Reviewer regression: switching the Design Studio engine must reconcile the
  // caller's per-user model override. An override pinned for the old engine is
  // invalid for the new one (the model select already shows "Default"), so it
  // must be cleared — otherwise the persisted override stays out of sync with
  // the UI and can be sent to the runtime as a mismatched engine/model pair.
  describe('per-user model override reconciliation on engine change', () => {
    const TWO_ENGINE_CONFIG = {
      defaultModel: 'claude-opus-4-8',
      engineDefaultModels: { 'claude-code': 'claude-opus-4-8', 'codex-cli': 'gpt-5.2' },
      engineValidModels: {
        'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'],
        'codex-cli': ['gpt-5.2', 'gpt-5.5'],
      },
    };

    beforeEach(() => {
      api.updateDesign.mockClear();
      api.deleteMyAgentModelOverride.mockClear();
      api.getModelConfig.mockClear();
      api.getMyAgentModelOverrides.mockClear();
    });

    it('clears an override that is incompatible with the newly selected engine', async () => {
      api.getModelConfig.mockResolvedValueOnce(TWO_ENGINE_CONFIG);
      api.getMyAgentModelOverrides.mockResolvedValueOnce({
        agentModelOverrides: { __design_studio__: 'claude-sonnet-4-6' },
      });
      api.updateDesign.mockResolvedValueOnce({ id: 'd-1', agent_engine: 'codex-cli' });
      api.deleteMyAgentModelOverride.mockResolvedValueOnce({ agentModelOverrides: {} });

      render(<DesignView {...baseProps} />);
      const engineSelect = await screen.findByTestId('design-studio-engine');
      fireEvent.change(engineSelect, { target: { value: 'codex-cli' } });

      await waitFor(() => {
        expect(api.updateDesign).toHaveBeenCalledWith('d-1', {
          agentEngine: 'codex-cli',
          agentModel: null,
        });
        expect(api.deleteMyAgentModelOverride).toHaveBeenCalledWith('__design_studio__');
      });
    });

    it('does not clear when there is no per-user model override to reconcile', async () => {
      api.getModelConfig.mockResolvedValueOnce(TWO_ENGINE_CONFIG);
      api.getMyAgentModelOverrides.mockResolvedValueOnce({ agentModelOverrides: {} });
      api.updateDesign.mockResolvedValueOnce({ id: 'd-1', agent_engine: 'codex-cli' });

      render(<DesignView {...baseProps} />);
      const engineSelect = await screen.findByTestId('design-studio-engine');
      fireEvent.change(engineSelect, { target: { value: 'codex-cli' } });

      await waitFor(() => {
        expect(api.updateDesign).toHaveBeenCalled();
      });
      expect(api.deleteMyAgentModelOverride).not.toHaveBeenCalled();
    });
  });
});
