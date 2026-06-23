import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffView } from './SessionTail';

/**
 * DiffView — leading whitespace preservation.
 *
 * Code previews and diffs shown in tool cards must preserve leading
 * indentation (spaces/tabs) so nested code is readable. Previously the
 * diff line rendered the code string directly in a <div>, which causes
 * HTML's default whitespace collapsing and destroys indentation.
 *
 * The fix wraps the code portion in a span with `whitespace-pre` and
 * an explicit `tab-size`, so spaces and tabs render as authored.
 */
describe('DiffView leading-whitespace preservation', () => {
  it('preserves leading spaces for indented removals and additions (Edit)', () => {
    // 10-line diff triggers Cursor-style preview/expand; click "view all"
    // so removals are visible alongside additions for the whitespace check.
    const { container } = render(
      <DiffView
        tool="Edit"
        input={{
          file_path: '/tmp/foo.js',
          old_string: 'class Foo {\n  bar() {\n    return 1;\n  }\n}',
          new_string: 'class Foo {\n  bar() {\n    return 2;\n  }\n}',
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('diff-view-expand' as any) as any);

    // The code portion of each diff line is rendered in a span with
    // the `whitespace-pre` class. Collect those spans and verify the
    // textContent still has the original leading spaces.
    const codeSpans = container.querySelectorAll('span.whitespace-pre');
    expect(codeSpans.length).toBeGreaterThan(0);

    const lines = Array.from(codeSpans).map((el: any) => (el as any).textContent);
    // Four-space-indented line must retain its four leading spaces.
    expect(lines!).toContain('    return 1;');
    expect(lines!).toContain('    return 2;');
    // Two-space indented lines retain their two leading spaces.
    expect(lines!).toContain('  bar() {');
    expect(lines!).toContain('  }');
  });

  it('preserves leading tabs for indented additions (Write)', () => {
    const content = 'function outer() {\n\tfunction inner() {\n\t\treturn 42;\n\t}\n}';
    const { container } = render(
      <DiffView tool="Write" input={{ file_path: '/tmp/bar.js', content }} />,
    );

    const codeSpans = container.querySelectorAll('span.whitespace-pre');
    const lines = Array.from(codeSpans).map((el: any) => (el as any).textContent);

    expect(lines!).toContain('\tfunction inner() {');
    expect(lines!).toContain('\t\treturn 42;');
    expect(lines!).toContain('\t}');
  });

  it('marks the gutter indicator as non-selectable and keeps it separate from code', () => {
    const { container } = render(
      <DiffView
        tool="Edit"
        input={{
          file_path: '/tmp/foo.js',
          old_string: '    indented line',
          new_string: '    indented line',
        }}
      />,
    );

    // Gutter markers (+/-) must be in select-none spans so copy-paste of
    // the diff doesn't pick them up along with the code.
    const gutters = container.querySelectorAll('span.select-none');
    expect(gutters.length).toBeGreaterThan(0);
    const gutterText = Array.from(gutters).map((el: any) => (el as any).textContent);
    expect(gutterText!).toContain('+');
    expect(gutterText!).toContain('-');
  });
});
