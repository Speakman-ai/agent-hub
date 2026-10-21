import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  Linking: { openURL: vi.fn(() => Promise.resolve()) },
  Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('./AppIcon', () => ({ default: nativeHost('AppIcon') }));

const { renderTimelineSystemMessage } = await import('./FinalizeTimelineBlocks');
const { FINALIZE_TIMELINE_KINDS } = await import('@shared/utils/finalizeTimeline');

function systemMessage(metadata: Record<string, unknown>, content = '') {
  return {
    id: 1,
    role: 'system',
    content,
    metadata: JSON.stringify(metadata),
    created_at: '2026-10-16T20:00:00Z',
  };
}

function render(element: any) {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function allText(renderer: any): string {
  return renderer.root
    .findAll((n: any) => n.type === 'Text')
    .flatMap((n: any) => n.children)
    .filter((c: any) => typeof c === 'string')
    .join(' ');
}

function byTestId(renderer: any, id: string) {
  return renderer.root.findAll((n: any) => n.props?.testID === id && typeof n.type === 'string');
}

// The server-built markdown body. Before the fix mobile printed this verbatim.
const SUMMARY_MARKDOWN =
  '### Review\n- Round 2: changes requested\n  - `server/a.ts` L95-97: **[6/10]** Gate\n### Manual testing\n- [ ] Create a reminder';

describe('renderTimelineSystemMessage', () => {
  it('renders a run summary as a structured card, not the raw markdown body', () => {
    const msg = systemMessage(
      {
        kind: 'finalize_run_summary',
        runId: 'r1',
        summary: 'Adds calendar sync.',
        commits: ['feat: sync'],
        finalVerdict: 'approved',
        totalFindings: 1,
        reviewRounds: [
          {
            round: 2,
            verdict: 'changes_requested',
            findings: [{ filePath: 'server/a.ts', lineStart: 95, lineEnd: 97, body: 'Gate it.' }],
          },
          { round: 3, verdict: 'approved', findings: [] },
        ],
        manualTesting: ['Create a reminder'],
      },
      SUMMARY_MARKDOWN,
    );
    const r = render(renderTimelineSystemMessage(msg));
    expect(byTestId(r, 'finalize-run-summary-block')).toHaveLength(1);
    const text = allText(r);
    expect(text).toContain('Finalize summary');
    expect(text).toContain('Review approved');
    expect(text).toContain('Gate it.');
    expect(text).toContain('L95-97');
    expect(byTestId(r, 'finalize-summary-manual-step')).toHaveLength(1);
    expect(text).not.toContain('###');
    expect(text).not.toContain('**[6/10]**');
  });

  it('groups review-round findings by file with a verdict pill', () => {
    const msg = systemMessage({
      kind: 'finalize_review_round',
      round: 2,
      verdict: 'changes_requested',
      threads: [
        { file_path: 'a.ts', line_start: 3, body: 'one' },
        { file_path: 'a.ts', line_start: 9, line_end: 12, body: 'two' },
        { file_path: 'b.ts', body: 'three' },
      ],
    });
    const r = render(renderTimelineSystemMessage(msg));
    expect(byTestId(r, 'finalize-review-file-group')).toHaveLength(2);
    expect(byTestId(r, 'finalize-review-thread')).toHaveLength(3);
    const text = allText(r);
    expect(text).toContain('Review · round 2');
    expect(text).toContain('Changes requested');
    expect(text).toContain('L9-12');
    expect(text).toContain('file-level');
  });

  it('renders checks rounds through the CI step card', () => {
    const msg = systemMessage({
      kind: 'finalize_checks_round',
      round: 1,
      steps: [
        { index: 0, name: 'lint', state: 'passed' },
        { index: 1, name: 'test', state: 'failed', exitCode: 1 },
      ],
    });
    const r = render(renderTimelineSystemMessage(msg));
    expect(byTestId(r, 'finalize-checks-card')).toHaveLength(1);
    expect(allText(r)).toContain('exit');
  });

  it('explains a terminal failure reason in plain English', () => {
    const msg = systemMessage({
      kind: 'finalize_run_terminal',
      status: 'failed',
      failureReason: 'fix_no_progress',
    });
    const r = render(renderTimelineSystemMessage(msg));
    expect(allText(r)).toContain('Failed (fix_no_progress)');
    expect(byTestId(r, 'finalize-terminal-explanation')).toHaveLength(1);
  });

  it('opens a hub-hosted PR in-app from the terminal block', () => {
    const onOpenPrDetail = vi.fn();
    const msg = systemMessage({
      kind: 'finalize_run_terminal',
      status: 'pushed',
      prUrl: '/projects/agent-hub/pulls/42',
    });
    const r = render(renderTimelineSystemMessage(msg, { hosted: true, onOpenPrDetail }));
    expect(allText(r)).toContain('Pushed to Agent Hub');
    const [link] = byTestId(r, 'finalize-terminal-pr-link');
    act(() => link.props.onPress());
    expect(onOpenPrDetail).toHaveBeenCalledWith('agent-hub', 42);
  });

  it('renders the disputed review notice and terminal status', () => {
    const notice = render(
      renderTimelineSystemMessage(
        systemMessage({ kind: 'finalize_review_disputed' }, 'The agent and the reviewer disagree.'),
      ),
    );
    expect(allText(notice)).toContain('Review disputed: needs your decision');
    expect(allText(notice)).toContain('The agent and the reviewer disagree.');
    const terminal = render(
      renderTimelineSystemMessage(
        systemMessage({
          kind: 'finalize_run_terminal',
          runId: 'r1',
          status: 'disputed',
          failureReason: 'review_disputed',
        }),
      ),
    );
    expect(allText(terminal)).toContain('Review disputed: needs your decision');
  });

  it('frames review notices and fix dispatches', () => {
    const notice = render(
      renderTimelineSystemMessage(
        systemMessage({ kind: 'finalize_review_stalled' }, 'Reviewer out of quota.'),
      ),
    );
    expect(allText(notice)).toContain('Finalize paused');
    const fix = render(
      renderTimelineSystemMessage(
        systemMessage({
          kind: 'finalize_fix_dispatch',
          failedStepName: 'test',
          reviewerVerdict: 'changes_requested',
          reviewerThreadCount: 2,
        }),
      ),
    );
    expect(allText(fix)).toContain('CI: test failed · Review: 2 findings');
  });

  it('renders the no-CI-config notice with its round', () => {
    const msg = systemMessage(
      { kind: 'finalize_ci_absent', runId: 'r1', round: 2 },
      'No CI config for this project.',
    );
    const r = render(renderTimelineSystemMessage(msg));
    expect(byTestId(r, 'finalize-ci-absent-block')).toHaveLength(1);
    const text = allText(r);
    expect(text).toContain('No checks · round 2');
    expect(text).toContain('No CI config for this project.');
  });

  it('renders the turn change summary card', () => {
    const msg = systemMessage({
      kind: 'turn_change_summary',
      summary: 'Fixed it.',
      manualTesting: ['Open the app', 'Tap the card'],
    });
    const r = render(renderTimelineSystemMessage(msg));
    expect(byTestId(r, 'turn-change-summary-block')).toHaveLength(1);
    expect(byTestId(r, 'turn-change-summary-manual-step')).toHaveLength(2);
  });

  it('renders the PR-failed card', () => {
    const msg = systemMessage({ kind: 'pr_failed', code: 'push_failed', error: 'rejected' });
    const r = render(renderTimelineSystemMessage(msg));
    expect(byTestId(r, 'system-pr-failed-block')).toHaveLength(1);
    expect(allText(r)).toContain('rejected');
  });

  it('routes every Finalize timeline kind to a block', () => {
    for (const kind of FINALIZE_TIMELINE_KINDS) {
      const routed = renderTimelineSystemMessage(systemMessage({ kind }));
      if (kind === 'finalize_step_output') expect(routed).toBe(null);
      else expect(routed, kind).toBeTruthy();
    }
  });

  it('hides step output and defers unknown system messages to the caller', () => {
    expect(renderTimelineSystemMessage(systemMessage({ kind: 'finalize_step_output' }))).toBe(null);
    expect(renderTimelineSystemMessage(systemMessage({ kind: 'pr_created' }))).toBeUndefined();
    expect(
      renderTimelineSystemMessage({ role: 'system', content: 'x', metadata: null }),
    ).toBeUndefined();
  });
});
