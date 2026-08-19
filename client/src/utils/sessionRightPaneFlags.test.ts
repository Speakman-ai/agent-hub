import { describe, it, expect } from 'vitest';
import { resolveSessionRightPaneFlags } from './sessionRightPaneFlags';

const idle = {
  terminalRequested: false,
  diffRequested: false,
  artifactsRequested: false,
};

function flags(overrides: Partial<Parameters<typeof resolveSessionRightPaneFlags>[0]> = {}) {
  return resolveSessionRightPaneFlags({
    previewEligible: false,
    previewKind: null,
    ...idle,
    ...overrides,
  });
}

function shown(result: ReturnType<typeof resolveSessionRightPaneFlags>) {
  return [
    result.showSessionPreviewPane && 'preview',
    result.showSessionTerminalPane && 'terminal',
    result.showSessionDiffPane && 'diff',
    result.showSessionArtifactsPane && 'artifacts',
  ].filter(Boolean);
}

describe('resolveSessionRightPaneFlags', () => {
  it('shows nothing when no pane is requested and preview is closed', () => {
    const result = flags();
    expect(shown(result)).toEqual([]);
    expect(result.previewReady).toBe(false);
    expect(result.footerTab).toBe('boot');
  });

  it('Actions → Terminal with a ready preview keeps the preview pane and sets footerTab', () => {
    const result = flags({
      previewEligible: true,
      previewKind: 'preview',
      terminalRequested: true,
    });
    expect(result.previewReady).toBe(true);
    expect(result.showSessionPreviewPane).toBe(true);
    expect(result.showSessionTerminalPane).toBe(false);
    expect(result.footerTab).toBe('terminal');
    expect(shown(result)).toEqual(['preview']);
  });

  it('ready preview without a Terminal request stays on the Boot log footer tab', () => {
    const result = flags({
      previewEligible: true,
      previewKind: 'preview',
    });
    expect(result.showSessionPreviewPane).toBe(true);
    expect(result.showSessionTerminalPane).toBe(false);
    expect(result.footerTab).toBe('boot');
  });

  it.each(['preview_starting', 'preview_failed', 'preview_unavailable'] as const)(
    'Actions → Terminal with a %s preview yields the slot to the full-size pane',
    (previewKind) => {
      const result = flags({
        previewEligible: true,
        previewKind,
        terminalRequested: true,
      });
      expect(result.previewReady).toBe(false);
      expect(result.showSessionPreviewPane).toBe(false);
      expect(result.showSessionTerminalPane).toBe(true);
      expect(shown(result)).toEqual(['terminal']);
    },
  );

  it('closing preview only empties the column when the terminal flag is also cleared', () => {
    // handlePreviewClose must flip terminalRequested off; otherwise X on a
    // ready preview with the Terminal footer tab selected expands the
    // full-size pane into the vacated slot.
    expect(
      shown(
        flags({
          previewEligible: false,
          previewKind: 'preview',
          terminalRequested: true,
        }),
      ),
    ).toEqual(['terminal']);
    expect(
      shown(
        flags({
          previewEligible: false,
          previewKind: 'preview',
          terminalRequested: false,
        }),
      ),
    ).toEqual([]);
  });

  it('closed preview + Terminal request yields the full-size pane', () => {
    const result = flags({
      previewEligible: false,
      previewKind: 'preview',
      terminalRequested: true,
    });
    expect(result.previewReady).toBe(false);
    expect(result.showSessionPreviewPane).toBe(false);
    expect(result.showSessionTerminalPane).toBe(true);
    expect(shown(result)).toEqual(['terminal']);
  });

  it('starting preview without a Terminal request keeps the preview pane (boot log)', () => {
    const result = flags({
      previewEligible: true,
      previewKind: 'preview_starting',
    });
    expect(result.showSessionPreviewPane).toBe(true);
    expect(result.showSessionTerminalPane).toBe(false);
    expect(shown(result)).toEqual(['preview']);
  });

  it('Changes wins the slot over a ready preview (and hides the full-size terminal)', () => {
    const result = flags({
      previewEligible: true,
      previewKind: 'preview',
      terminalRequested: true,
      diffRequested: true,
    });
    expect(result.showSessionDiffPane).toBe(true);
    expect(result.showSessionPreviewPane).toBe(false);
    expect(result.showSessionTerminalPane).toBe(false);
    expect(shown(result)).toEqual(['diff']);
  });

  it('full-size Terminal wins over Changes while preview is not ready', () => {
    const result = flags({
      previewEligible: true,
      previewKind: 'preview_starting',
      terminalRequested: true,
      diffRequested: true,
    });
    expect(shown(result)).toEqual(['terminal']);
  });

  it('Changes wins over Artifacts when both are flagged', () => {
    const result = flags({
      diffRequested: true,
      artifactsRequested: true,
    });
    expect(shown(result)).toEqual(['diff']);
  });

  it('never mounts more than one of the four right-hand panes', () => {
    const kinds = [null, 'preview', 'preview_starting', 'preview_failed', 'preview_unavailable'];
    const bools = [false, true];
    for (const previewEligible of bools) {
      for (const previewKind of kinds) {
        for (const terminalRequested of bools) {
          for (const diffRequested of bools) {
            for (const artifactsRequested of bools) {
              const result = flags({
                previewEligible,
                previewKind,
                terminalRequested,
                diffRequested,
                artifactsRequested,
              });
              expect(shown(result).length).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });
});
