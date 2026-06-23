import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCard, ExploredChip, TodoListCard, DiffView, describeTool } from './SessionTail';

/**
 * File-modifying tool cards used to swap entirely to the generic collapsible
 * tool row when `tool_result.isError` was true, which hid DiffView — users only
 * saw the error after expanding the card (Electron / web bug report).
 */
describe('ToolCard — Edit/Write diff + error', () => {
  const editUse = {
    type: 'tool_use',
    id: 'e1',
    tool: 'Edit',
    input: {
      file_path: '/project/src/foo.js',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    },
  };

  it('keeps the diff visible when the tool result is an error', () => {
    render(
      <ToolCard
        use={editUse}
        result={{ output: 'String not found in file', isError: true }}
        defaultOpen={false}
      />,
    );

    expect(screen.getByText('String not found in file')).toBeTruthy();
    expect(screen.getByText('Update:')).toBeTruthy();
    expect(screen.getByText('const x = 1;')).toBeTruthy();
    expect(screen.getByText('const x = 2;')).toBeTruthy();
  });

  it('shows a running strip while the tool_result has not arrived', () => {
    render(<ToolCard use={editUse} result={undefined} defaultOpen={false} />);

    expect(screen.getByText('running…')).toBeTruthy();
    expect(screen.getByText('Update:')).toBeTruthy();
  });

  it('does not show an error strip on successful Edit', () => {
    render(
      <ToolCard use={editUse} result={{ output: 'ok', isError: false }} defaultOpen={false} />,
    );

    expect(screen.queryByText('error')).toBeNull();
    expect(screen.queryByText('running…')).toBeNull();
  });
});

/**
 * The collapsed ToolCard header reads as Cursor-style intent text, not raw
 * `Bash: <command>`. The model-supplied `description` is the headline, and
 * the actual command is a separate monospace chip — so the at-a-glance
 * timeline communicates *why* not *what*.
 */
describe('ToolCard — humanized headline', () => {
  it('shows the Bash description as the headline with the command as a chip', () => {
    render(
      <ToolCard
        use={{
          type: 'tool_use',
          id: 'b1',
          tool: 'Bash',
          input: {
            command: 'pytest -k adjoiners',
            description: 'Re-run live test with adjoiner overlay',
          },
        }}
        result={{ output: 'ok', isError: false }}
      />,
    );
    expect(screen.getByText('Re-run live test with adjoiner overlay')).toBeTruthy();
    expect(screen.getByText('pytest -k adjoiners')).toBeTruthy();
  });

  it('falls back to a "Run …" headline when no description is provided', () => {
    render(
      <ToolCard
        use={{ type: 'tool_use', id: 'b2', tool: 'Bash', input: { command: 'ls -la' } }}
        result={{ output: '', isError: false }}
      />,
    );
    expect(screen.getByText(/^Run ls -la$/)).toBeTruthy();
  });

  it('humanizes Read/Grep tools (basename + verb)', () => {
    expect(describeTool('Read', { file_path: '/project/src/foo.ts' }).headline).toBe('Read foo.ts');
    expect(describeTool('Grep', { pattern: 'TODO' }).headline).toBe('Search for /TODO/');
    expect(describeTool('Grep', { pattern: 'TODO', path: '/src/utils.ts' }).headline).toBe(
      'Search utils.ts for /TODO/',
    );
  });
});

/**
 * "Explored 3 files, 1 search" — collapses bursts of read/search calls into
 * a single status chip, expandable to reveal the underlying calls. Mirrors
 * Cursor's chat where context-gathering doesn't dominate the timeline.
 */
describe('ExploredChip', () => {
  const items = [
    { use: { tool: 'Read', input: { file_path: '/a.ts' } }, result: { isError: false } },
    { use: { tool: 'Read', input: { file_path: '/b.ts' } }, result: { isError: false } },
    { use: { tool: 'Grep', input: { pattern: 'foo' } }, result: { isError: false } },
  ];

  it('summarizes counts in the collapsed header', () => {
    render(<ExploredChip items={items} />);
    expect(screen.getByText('Explored')).toBeTruthy();
    expect(screen.getByText(/2 files, 1 search/)).toBeTruthy();
  });

  it('expands to a list of underlying calls on click', () => {
    render(<ExploredChip items={items} />);
    fireEvent.click(screen.getByTestId('explored-chip' as any) as any);
    expect(screen.getByText('Read a.ts')).toBeTruthy();
    expect(screen.getByText('Read b.ts')).toBeTruthy();
    expect(screen.getByText('Search for /foo/')).toBeTruthy();
  });
});

/**
 * TodoWrite gets a dedicated card so the "M of N Done" progress is visible
 * at a glance and individual items can be reviewed on click — instead of
 * being hidden behind a generic "3 todos" tool row.
 */
describe('TodoListCard', () => {
  const use = {
    type: 'tool_use',
    id: 't1',
    tool: 'TodoWrite',
    input: {
      todos: [
        { content: 'Write tests', status: 'completed' },
        { content: 'Wire up UI', status: 'in_progress' },
        { content: 'Ship PR', status: 'pending' },
        { content: 'Cancelled task', status: 'cancelled' },
      ],
    },
  };

  it('shows "1 of 4 Done" header and only incomplete items collapsed', () => {
    render(<TodoListCard use={use} result={{ isError: false }} />);
    expect(screen.getByText('1 of 4 Done')).toBeTruthy();
    expect(screen.getByText('Wire up UI')).toBeTruthy();
    expect(screen.getByText('Ship PR')).toBeTruthy();
    // Completed and cancelled items are hidden in the collapsed state.
    expect(screen.queryByText('Write tests')).toBeNull();
    expect(screen.queryByText('Cancelled task')).toBeNull();
  });

  it('reveals all items including completed/cancelled when expanded', () => {
    render(<TodoListCard use={use} result={{ isError: false }} />);
    fireEvent.click(screen.getByTestId('todo-list-toggle' as any) as any);
    expect(screen.getByText('Write tests')).toBeTruthy();
    expect(screen.getByText('Cancelled task')).toBeTruthy();
  });

  it('shows completed todos when collapsed and every item is done', () => {
    const allDone = {
      type: 'tool_use',
      id: 't2',
      tool: 'TodoWrite',
      input: {
        todos: [
          { content: 'Alpha', status: 'completed' },
          { content: 'Beta', status: 'completed' },
        ],
      },
    };
    render(<TodoListCard use={allDone} result={{ isError: false }} />);
    expect(screen.getByText('2 of 2 Done')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('shows cancelled todos when collapsed and no active work remains', () => {
    const onlyCancelled = {
      type: 'tool_use',
      id: 't3',
      tool: 'TodoWrite',
      input: {
        todos: [{ content: 'Dropped scope', status: 'cancelled' }],
      },
    };
    render(<TodoListCard use={onlyCancelled} result={{ isError: false }} />);
    expect(screen.getByText('0 of 1 Done')).toBeTruthy();
    expect(screen.getByText('Dropped scope')).toBeTruthy();
  });

  it('caps collapsed fallback at four terminal todos', () => {
    const sixDone = {
      type: 'tool_use',
      id: 't4',
      tool: 'TodoWrite',
      input: {
        todos: Array.from({ length: 6 }, (_: any, i: any) => ({
          content: `Task ${i + 1}`,
          status: 'completed',
        })),
      },
    };
    render(<TodoListCard use={sixDone} result={{ isError: false }} />);
    expect(screen.queryByText('Task 1')).toBeNull();
    expect(screen.queryByText('Task 2')).toBeNull();
    expect(screen.getByText('Task 3')).toBeTruthy();
    expect(screen.getByText('Task 6')).toBeTruthy();
  });
});

/**
 * Cursor-style diff preview — large diffs collapse to ~5 lines plus a
 * "N more lines · view all" footer that expands to the full diff. Small
 * diffs render fully without the footer.
 */
describe('DiffView — preview / expand', () => {
  const longInput = {
    file_path: '/big.ts',
    old_string: 'a\nb',
    new_string: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n'),
  };

  it('collapses long diffs to a preview with a "more lines" footer', () => {
    render(<DiffView tool="Edit" input={longInput} />);
    expect(screen.getByText('l1')).toBeTruthy();
    expect(screen.getByText('l5')).toBeTruthy();
    // Lines beyond the preview are hidden until expand.
    expect(screen.queryByText('l10')).toBeNull();
    expect(screen.getByTestId('diff-view-expand')).toBeTruthy();
  });

  it('shows the full diff after the user clicks the footer', () => {
    render(<DiffView tool="Edit" input={longInput} />);
    fireEvent.click(screen.getByTestId('diff-view-expand' as any) as any);
    expect(screen.getByText('l10')).toBeTruthy();
    expect(screen.queryByTestId('diff-view-expand')).toBeNull();
  });

  it('does not render the footer for diffs that already fit', () => {
    render(
      <DiffView tool="Edit" input={{ file_path: '/small.ts', old_string: 'x', new_string: 'y' }} />,
    );
    expect(screen.queryByTestId('diff-view-expand')).toBeNull();
  });
});
