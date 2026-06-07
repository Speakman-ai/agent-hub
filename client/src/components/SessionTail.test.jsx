import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionTail, { eventsToBlocks } from './SessionTail.jsx';

/**
 * `eventsToBlocks` turns a raw event stream into renderable blocks. The tail
 * used to route any unrecognized type to an `unknown` block, which rendered
 * literally as "unhandled event: { ...json... }". Autonomous review sessions
 * emit `progress_step` events (Gather / Analyze / Post) that are already
 * surfaced by the out-of-tail ProgressPanel, so they must be suppressed in
 * the tail — otherwise the chat fills up with noisy "unhandled event" rows
 * (observed in Electron client v1.2.1 bug report).
 */
describe('SessionTail — browser_tool_activity UI', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('renders BrowserActivityPanel without unhandled event rows', () => {
    const events = wrap([
      {
        type: 'browser_tool_activity',
        actionId: 'a1',
        phase: 'started',
        op: 'navigate',
        label: 'Navigating to example.com…',
        startedAtMs: 1,
      },
    ]);
    render(
      <SessionTail
        message={{
          id: 'm1',
          role: 'assistant',
          engine: 'claude-code',
          model: 'opus',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={events}
        agentColor="#6366f1"
        streaming
      />,
    );
    expect(screen.getByTestId('browser-activity-panel')).toBeTruthy();
    expect(screen.getByTestId('browser-activity-live-hint')).toHaveTextContent(
      'Navigating to example.com…',
    );
    expect(screen.queryByText(/unhandled event/i)).toBeNull();
  });
});

describe('eventsToBlocks — browser_tool_activity handling', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('does not produce unknown blocks for browser_tool_activity events', () => {
    const events = wrap([
      {
        type: 'browser_tool_activity',
        actionId: 'a1',
        phase: 'started',
        op: 'navigate',
        label: 'Navigating to example.com…',
        startedAtMs: 1,
      },
      {
        type: 'browser_tool_activity',
        actionId: 'a1',
        phase: 'ended',
        op: 'navigate',
        label: 'Navigating to example.com…',
        startedAtMs: 1,
        ok: true,
        summary: 'Opened example.com',
        durationMs: 12,
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    expect(blocks).toEqual([]);
  });

  it('still renders assistant_text around browser_tool_activity events', () => {
    const events = wrap([
      { type: 'assistant_text', text: 'Opening the app.', partial: false },
      {
        type: 'browser_tool_activity',
        actionId: 'a1',
        phase: 'started',
        op: 'navigate',
        label: 'Navigating to example.com…',
        startedAtMs: 1,
      },
      {
        type: 'browser_tool_activity',
        actionId: 'a1',
        phase: 'ended',
        op: 'navigate',
        label: 'Navigating to example.com…',
        startedAtMs: 1,
        ok: true,
        summary: 'Opened example.com',
        durationMs: 12,
      },
      { type: 'assistant_text', text: 'Logged in.', partial: false },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks.map((b) => b.kind)).toEqual(['text']);
    expect(blocks[0].text).toContain('Opening the app.');
    expect(blocks[0].text).toContain('Logged in.');
  });
});

describe('eventsToBlocks — agenthub:ask recovery', () => {
  it('renders a picker for flat fenced envelope (askId + question at top level)', () => {
    const body = JSON.stringify({
      askId: 'preview-bootstrap-approval',
      header: 'Write docker-compose.yml?',
      question: 'May I create docker-compose.yml?',
      multiSelect: false,
      options: [
        { label: 'Yes', description: 'Create file' },
        { label: 'No', description: 'Skip' },
      ],
    });
    const events = [
      {
        seq: 0,
        event: {
          type: 'assistant_text',
          text: `Approve bootstrap:\n\n\`\`\`agenthub:ask\n${body}\n\`\`\`\n`,
        },
      },
    ];
    const blocks = eventsToBlocks(events);
    expect(blocks.some((b) => b.kind === 'ask_question')).toBe(true);
    expect(blocks.find((b) => b.kind === 'ask_question')?.event.askId).toBe(
      'preview-bootstrap-approval',
    );
    const textBlock = blocks.find((b) => b.kind === 'text');
    expect(textBlock?.text ?? '').not.toContain('agenthub:ask');
  });

  it('renders a picker when ask XML is only in assistant_text (no ask_user_question event)', () => {
    const payload = JSON.stringify({
      questions: [
        {
          question: 'Start script?',
          header: 'Script',
          multiSelect: false,
          options: [
            { label: 'npm run dev', description: 'vite' },
            { label: 'npm start', description: 'prod' },
          ],
        },
      ],
    });
    const events = [
      {
        seq: 0,
        event: {
          type: 'assistant_text',
          text: `Pick one:\n\n<agenthub:ask>\n${payload}\n</agenthub:ask>\n`,
        },
      },
    ];
    const blocks = eventsToBlocks(events);
    expect(blocks.some((b) => b.kind === 'ask_question')).toBe(true);
    const textBlock = blocks.find((b) => b.kind === 'text');
    expect(textBlock?.text ?? '').not.toContain('<agenthub:ask>');
  });
});

describe('eventsToBlocks — benign unknown stream events', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('suppresses historical Claude control_request unknown rows', () => {
    const events = wrap([
      {
        type: 'unknown',
        text: 'unhandled claude event: control_request',
      },
      { type: 'assistant_text', text: 'Done.', partial: false },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    expect(blocks.map((b) => b.kind)).toEqual(['text']);
  });
});

describe('SessionTail reviewer verdict suppression', () => {
  const verdictJson = JSON.stringify({
    verdict: 'approved',
    threads: [],
  });

  it('suppresses raw reviewer verdict assistant_text', () => {
    const { container } = render(
      <SessionTail
        message={{
          id: 'm-review-events',
          role: 'assistant',
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[{ seq: 0, event: { type: 'assistant_text', text: verdictJson, partial: false } }]}
        agentColor="#6366f1"
        streaming={false}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });

  it('suppresses raw reviewer verdict live fallback content', () => {
    const { container } = render(
      <SessionTail
        message={{
          id: 'm-review-streaming',
          role: 'assistant',
          content: verdictJson,
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });

  it('suppresses raw reviewer verdict stored fallback content', () => {
    const { container } = render(
      <SessionTail
        message={{
          id: 'm-review-stored',
          role: 'assistant',
          content: verdictJson,
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming={false}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });

  it('preserves reviewer prose before a structured verdict block in assistant_text', () => {
    const content = [
      'No blocking findings remain after the fix.',
      '',
      '<agenthub:review-verdict>',
      verdictJson,
      '</agenthub:review-verdict>',
    ].join('\n');

    render(
      <SessionTail
        message={{
          id: 'm-review-prose-events',
          role: 'assistant',
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[{ seq: 0, event: { type: 'assistant_text', text: content, partial: false } }]}
        agentColor="#6366f1"
        streaming={false}
      />,
    );

    expect(screen.getByText('No blocking findings remain after the fix.')).toBeInTheDocument();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText(/agenthub:review-verdict/)).not.toBeInTheDocument();
  });

  it('preserves reviewer prose before a structured verdict block in live fallback content', () => {
    const content = [
      'No blocking findings remain after the fix.',
      '',
      '<agenthub:review-verdict>',
      verdictJson,
      '</agenthub:review-verdict>',
    ].join('\n');

    render(
      <SessionTail
        message={{
          id: 'm-review-prose-streaming',
          role: 'assistant',
          content,
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming
      />,
    );

    expect(screen.getByText('No blocking findings remain after the fix.')).toBeInTheDocument();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText(/agenthub:review-verdict/)).not.toBeInTheDocument();
  });

  it('preserves reviewer prose before trailing verdict JSON in stored fallback content', () => {
    const content = ['Review complete. This is ready to ship.', '', verdictJson].join('\n');

    const { container } = render(
      <SessionTail
        message={{
          id: 'm-review-prose-stored',
          role: 'assistant',
          content,
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming={false}
      />,
    );

    expect(screen.getByText('Review complete. This is ready to ship.')).toBeInTheDocument();
    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.getAllByText('Assistant')).toHaveLength(1);
    expect(container.querySelectorAll('.rounded-bl-md')).toHaveLength(1);
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });

  it('suppresses raw approved reviewer verdicts with findings', () => {
    const content = JSON.stringify({
      verdict: 'approved',
      threads: [
        {
          file_path: 'client/src/components/ChatMessage.jsx',
          line_start: 461,
          line_end: 464,
          body: '**[2/10]** Non-blocking approval note.',
        },
      ],
    });

    const { container } = render(
      <SessionTail
        message={{
          id: 'm-review-approved-note-stored',
          role: 'assistant',
          content,
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming={false}
      />,
    );

    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(screen.queryByText('**[2/10]** Non-blocking approval note.')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
    expect(container.querySelector('.rounded-bl-md')).toBeNull();
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });

  it('suppresses raw changes-requested reviewer verdicts with findings', () => {
    const content = JSON.stringify({
      verdict: 'changes_requested',
      threads: [
        {
          file_path: 'client/src/components/ChatMessage.jsx',
          line_start: 461,
          line_end: 464,
          body: '**[4/10]** Blocking requested-change note.',
        },
      ],
    });

    const { container } = render(
      <SessionTail
        message={{
          id: 'm-review-changes-requested-note-stored',
          role: 'assistant',
          content,
          engine: 'codex-cli',
          model: 'gpt-5.5',
          created_at: '2026-01-01T00:00:00Z',
        }}
        events={[]}
        agentColor="#6366f1"
        streaming={false}
      />,
    );

    expect(screen.queryByTestId('finalize-review-round-block')).not.toBeInTheDocument();
    expect(
      screen.queryByText('**[4/10]** Blocking requested-change note.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
    expect(container.querySelector('.rounded-bl-md')).toBeNull();
    expect(screen.queryByText(/"verdict"/)).not.toBeInTheDocument();
  });
});

describe('eventsToBlocks — progress_step handling', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('does not produce "unknown" blocks for progress_step events', () => {
    const events = wrap([
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'started',
        startedAt: 1764549458504,
      },
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'completed',
        startedAt: 1764549458504,
        finishedAt: 1764549459984,
      },
      {
        type: 'progress_step',
        step: 'Analyze diff and files',
        status: 'started',
        startedAt: 1764549459990,
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks.filter((b) => b.kind === 'unknown')).toEqual([]);
    // progress_step is rendered by ProgressPanel, not the tail — so no
    // blocks at all should be produced for a stream that only contains
    // progress events.
    expect(blocks).toEqual([]);
  });

  it('still renders assistant_text and tool_use around progress_step events', () => {
    const events = wrap([
      { type: 'assistant_text', text: 'Starting review.', partial: false },
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'started',
        startedAt: 1,
      },
      {
        type: 'tool_use',
        id: 't1',
        tool: 'Bash',
        input: { command: 'gh pr view' },
      },
      { type: 'tool_result', toolUseId: 't1', output: 'ok', isError: false },
      {
        type: 'progress_step',
        step: 'Gather PR context',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
      },
      { type: 'assistant_text', text: 'Done.', partial: false },
    ]);

    const kinds = eventsToBlocks(events).map((b) => b.kind);
    expect(kinds).toEqual(['text', 'tool', 'text']);
  });
});

/**
 * `[[STEP:*]]` progress markers are extracted by the server parser, but the
 * raw markers can still slip into the rendered text via three paths:
 *
 *   1. Streaming partial deltas (the parser only extracts on finalized
 *      assistant blocks; partial chunks are persisted to `session_events`
 *      raw).
 *   2. Crashed / cancelled sessions where the finalized assistant event
 *      never arrived, so only partials survive.
 *   3. Stored messages from before the parser change.
 *
 * `eventsToBlocks` routes the assistant text through
 * `stripAssistantControlBlocks`, so adding marker-stripping to the shared
 * util closes all three paths in one place. These tests pin that contract.
 *
 * Bug: "[[STEP:*]] commands should probably be rendered as something"
 * (in-app report, Electron 1.16.0, agent-hub-reviewer).
 */
describe('eventsToBlocks — [[STEP:*]] marker stripping', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('strips inline STEP markers from finalized assistant_text', () => {
    const events = wrap([
      {
        type: 'assistant_text',
        text: 'Starting review.\n[[STEP:started:Gather PR context]]\nReading diff…',
        partial: false,
      },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text).toContain('Starting review.');
    expect(blocks[0].text).toContain('Reading diff');
    expect(blocks[0].text).not.toMatch(/\[\[STEP:/);
  });

  it('strips markers from the partial-fallback path (no finalized event)', () => {
    // Simulates a crashed / cancelled session: many partial chunks were
    // persisted with raw markers but the closing partial:false event never
    // arrived. flushText() falls back to textBuf.partials and must still
    // strip the markers before handing the text to ReactMarkdown.
    const events = wrap([
      { type: 'assistant_text', text: 'Working on it.\n', partial: true },
      { type: 'assistant_text', text: '[[STEP:started:Gather PR context]]\n', partial: true },
      { type: 'assistant_text', text: 'Reading the diff now…\n', partial: true },
      { type: 'assistant_text', text: '[[STEP:completed:Gather PR context]]\n', partial: true },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text).toContain('Working on it.');
    expect(blocks[0].text).toContain('Reading the diff now');
    expect(blocks[0].text).not.toMatch(/\[\[STEP:/);
  });

  it('still strips markers when partial + final both carry them (final wins)', () => {
    // The parser is supposed to strip markers from the finalized event, but
    // if for any reason the final still contains a marker we must still
    // remove it at render time — defense in depth.
    const events = wrap([
      { type: 'assistant_text', text: '[[STEP:started:Foo]] partial. ', partial: true },
      { type: 'assistant_text', text: 'Final body [[STEP:completed:Foo]].', partial: false },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Final body');
    expect(blocks[0].text).not.toMatch(/\[\[STEP:/);
  });
});

/**
 * In Claude Code's `--permission-mode plan` flow, Claude calls the
 * `ExitPlanMode` tool with a `plan` string. When the CLI runs
 * non-interactively (`--print`), the permission prompt has no user to
 * approve, so the tool_result comes back flagged `is_error: true` —
 * and the generic ToolCard rendered the plan proposal as a red ERROR
 * box. This made ask-mode sessions look broken to users.
 *
 * The fix routes ExitPlanMode tool_use events to a dedicated
 * `plan_proposal` block kind so the client can render the plan as
 * markdown without ERROR styling. These tests pin that routing.
 *
 * Bug: "Plan mode doesn't function properly" (user report, v1.5.0).
 */
describe('eventsToBlocks — ExitPlanMode routing', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('routes ExitPlanMode tool_use to a plan_proposal block, not a generic tool block', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'exit1',
        tool: 'ExitPlanMode',
        input: { plan: '# Refactor\n\n- Step 1\n- Step 2' },
      },
      {
        type: 'tool_result',
        toolUseId: 'exit1',
        output: 'The user has chosen to stay in plan mode.',
        isError: true,
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('plan_proposal');
    expect(blocks[0].use.input.plan).toContain('Refactor');
    // The declined tool_result is still paired with the tool_use so the card
    // can render the "awaiting review" status. It must NOT surface as a
    // standalone error block.
    expect(blocks[0].result?.isError).toBe(true);
    expect(blocks.some((b) => b.kind === 'error')).toBe(false);
    expect(blocks.some((b) => b.kind === 'tool')).toBe(false);
  });

  it('still emits plan_proposal when the tool_result has not yet arrived (streaming)', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'exit2',
        tool: 'ExitPlanMode',
        input: { plan: 'Short plan.' },
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks).toEqual([
      {
        kind: 'plan_proposal',
        use: {
          type: 'tool_use',
          id: 'exit2',
          tool: 'ExitPlanMode',
          input: { plan: 'Short plan.' },
        },
        result: undefined,
      },
    ]);
  });

  it('leaves a single Read tool_use as a generic tool block (no coalesce of one)', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 'r1',
        tool: 'Read',
        input: { file_path: '/tmp/x.txt' },
      },
    ]);

    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool');
  });
});

/**
 * "Explored 3 files" coalescer — runs of read/search tool calls collapse
 * into a single chip when there is no prose, error, or non-explore tool
 * between them. Mirrors Cursor's chat where the model gathering context
 * doesn't dominate the timeline.
 */
describe('eventsToBlocks — cursor Edit tool_use upgrade', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('uses the latest tool_use input when the same call_id is emitted twice', () => {
    const blocks = eventsToBlocks(
      wrap([
        {
          type: 'tool_use',
          id: 'e1',
          tool: 'Edit',
          input: { path: 'f.ts', strReplace: { oldText: '', newText: '' } },
        },
        {
          type: 'tool_use',
          id: 'e1',
          tool: 'Edit',
          input: { path: 'f.ts', strReplace: { oldText: 'a', newText: 'b' } },
        },
        { type: 'tool_result', toolUseId: 'e1', output: 'ok', isError: false },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool');
    expect(blocks[0].use.input.strReplace.newText).toBe('b');
  });

  // Reviewer concern (PR #1058 review item #2): dedup pre-index must NOT
  // break result pairing. Both tool_use revisions share the same call_id
  // string, and resultByToolId is keyed by that string — so the surviving
  // (latest) tool_use is still paired with its tool_result. This test
  // would fail if a future refactor changed result lookup from "use.id" to
  // "first tool_use index", or if the dedup ran as a post-filter that
  // dropped a tool_use the result was already pointed at.
  it('pairs tool_result correctly when the latest tool_use revision is kept', () => {
    const blocks = eventsToBlocks(
      wrap([
        {
          type: 'tool_use',
          id: 'edit-dup',
          tool: 'Edit',
          input: { path: 'a.ts', strReplace: {} },
        },
        // Tool result arrives BETWEEN the two tool_use revisions — this is the
        // ordering that would expose a wrong-revision pairing bug.
        { type: 'tool_result', toolUseId: 'edit-dup', output: 'edit ok', isError: false },
        {
          type: 'tool_use',
          id: 'edit-dup',
          tool: 'Edit',
          input: { path: 'a.ts', strReplace: { oldText: 'a', newText: 'b' } },
        },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool');
    // Latest revision wins for input…
    expect(blocks[0].use.input.strReplace.newText).toBe('b');
    // …and the paired result is still the same tool_result by id.
    expect(blocks[0].result?.output).toBe('edit ok');
    expect(blocks[0].result?.isError).toBe(false);
  });
});

describe('eventsToBlocks — explored coalescer', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));
  const read = (id, file) => ({ type: 'tool_use', id, tool: 'Read', input: { file_path: file } });
  const grep = (id, pattern) => ({ type: 'tool_use', id, tool: 'Grep', input: { pattern } });
  const ok = (id) => ({ type: 'tool_result', toolUseId: id, output: 'ok', isError: false });

  it('coalesces 3 reads + 1 grep into a single explored block with all items', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/b.ts'),
      ok('r2'),
      grep('g1', 'foo'),
      ok('g1'),
      read('r3', '/c.ts'),
      ok('r3'),
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('explored');
    expect(blocks[0].items).toHaveLength(4);
    expect(blocks[0].items.map((i) => i.use.tool)).toEqual(['Read', 'Read', 'Grep', 'Read']);
  });

  it('breaks the burst on assistant_text — each phase is its own group', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/b.ts'),
      ok('r2'),
      { type: 'assistant_text', text: 'Found the bug.', partial: false },
      read('r3', '/c.ts'),
      ok('r3'),
      read('r4', '/d.ts'),
      ok('r4'),
    ]);
    const kinds = eventsToBlocks(events).map((b) => b.kind);
    expect(kinds).toEqual(['explored', 'text', 'explored']);
  });

  it('errored read does not coalesce — the failure stays a visible tool card', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/missing.ts'),
      { type: 'tool_result', toolUseId: 'r2', output: 'ENOENT', isError: true },
      read('r3', '/c.ts'),
      ok('r3'),
    ]);
    const kinds = eventsToBlocks(events).map((b) => b.kind);
    // The error breaks the run; the surrounding reads are each one-element
    // groups, which we render as a regular tool block (not a chip).
    expect(kinds).toEqual(['tool', 'tool', 'tool']);
  });

  it('non-explore tool (Edit) breaks the burst', () => {
    const events = wrap([
      read('r1', '/a.ts'),
      ok('r1'),
      read('r2', '/b.ts'),
      ok('r2'),
      {
        type: 'tool_use',
        id: 'e1',
        tool: 'Edit',
        input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
      },
      ok('e1'),
      read('r3', '/c.ts'),
      ok('r3'),
      read('r4', '/d.ts'),
      ok('r4'),
    ]);
    const kinds = eventsToBlocks(events).map((b) => b.kind);
    expect(kinds).toEqual(['explored', 'tool', 'explored']);
  });

  it('routes TodoWrite to a dedicated todos block', () => {
    const events = wrap([
      {
        type: 'tool_use',
        id: 't1',
        tool: 'TodoWrite',
        input: {
          todos: [
            { content: 'Write tests', status: 'completed' },
            { content: 'Wire up UI', status: 'in_progress' },
            { content: 'Ship PR', status: 'pending' },
          ],
        },
      },
      ok('t1'),
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('todos');
    expect(blocks[0].use.input.todos).toHaveLength(3);
  });
});

/**
 * Regression tests for the "skill block renders as visible code block" bug
 * (agent-hub v1.13.0 / Electron, job-search project).
 *
 * Two related symptoms:
 *  1. The <agenthub:skill> block is visible in the chat transcript (either as
 *     raw XML or as a fenced code block).
 *  2. The skill is not loaded on the next turn (when the block is inside fences,
 *     the server-side detector misses it — fixed separately).
 *
 * This suite covers the client-side rendering half: `eventsToBlocks` must strip
 * control blocks from the final text before pushing a `{ kind: 'text' }` block.
 */
describe('eventsToBlocks — control block stripping (regression: v1.13.0)', () => {
  const wrap = (events) => events.map((event, i) => ({ seq: i, event }));

  it('strips a naked <agenthub:skill> block from a non-partial assistant_text event', () => {
    const events = wrap([
      {
        type: 'assistant_text',
        text: 'Done.\n\n<agenthub:skill>{"name":"kanban","reason":"need cards"}\n</agenthub:skill>',
        partial: false,
      },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('text');
    expect(blocks[0].text).not.toContain('<agenthub:skill>');
    expect(blocks[0].text).not.toContain('kanban');
    expect(blocks[0].text).toContain('Done.');
  });

  it('strips a fenced <agenthub:skill> block (the "visible code block" variant)', () => {
    const text = [
      'I need the kanban skill.',
      '',
      '```',
      '<agenthub:skill>{"name": "kanban", "reason": "create card"}',
      '</agenthub:skill>',
      '```',
    ].join('\n');
    const events = wrap([{ type: 'assistant_text', text, partial: false }]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toContain('<agenthub:skill>');
    expect(blocks[0].text).not.toContain('```');
    expect(blocks[0].text).toContain('I need the kanban skill.');
  });

  it('strips blocks accumulated from partial streaming events', () => {
    // Partial events build up in textBuf.partials; stripping applies to the
    // combined text at flush time regardless of partial/non-partial origin.
    const events = wrap([
      { type: 'assistant_text', text: 'Some work.\n\n<agenthub', partial: true },
      {
        type: 'assistant_text',
        text: ':skill>{"name":"kanban"}</agenthub:skill>',
        partial: true,
      },
    ]);
    const blocks = eventsToBlocks(events);
    // The only block should be the visible prose, with the control tag stripped.
    const textBlocks = blocks.filter((b) => b.kind === 'text');
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].text).not.toContain('<agenthub:skill>');
    expect(textBlocks[0].text).toContain('Some work.');
  });

  it('preserves normal prose that contains no control blocks', () => {
    const events = wrap([
      { type: 'assistant_text', text: 'Analysis complete. No issues found.', partial: false },
    ]);
    const blocks = eventsToBlocks(events);
    expect(blocks[0].text).toBe('Analysis complete. No issues found.');
  });

  it('strips a tilde-fenced <agenthub:skill> block (~~~ markdown variant)', () => {
    const text = [
      'Using wiki-search.',
      '~~~',
      '<agenthub:skill>{"name":"wiki-search"}</agenthub:skill>',
      '~~~',
    ].join('\n');
    const events = wrap([{ type: 'assistant_text', text, partial: false }]);
    const blocks = eventsToBlocks(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).not.toContain('<agenthub:skill>');
    expect(blocks[0].text).not.toContain('~~~');
    expect(blocks[0].text).toContain('Using wiki-search.');
  });

  it('produces no text block when the ONLY content is a control block (agent emitting just the invocation)', () => {
    const events = wrap([
      {
        type: 'assistant_text',
        text: '<agenthub:skill>{"name":"kanban"}</agenthub:skill>',
        partial: false,
      },
    ]);
    const blocks = eventsToBlocks(events);
    // After stripping, the text is empty — no block should be pushed.
    expect(blocks.filter((b) => b.kind === 'text')).toHaveLength(0);
  });
});
