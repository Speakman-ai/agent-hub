import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCard } from './SessionTail.jsx';

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
