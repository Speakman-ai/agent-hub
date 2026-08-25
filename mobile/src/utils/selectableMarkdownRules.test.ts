// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { createSelectableMarkdownRules, trimTrailingNewline } from './selectableMarkdownRules';
// Stand-in for React Native's Text so we can inspect props without needing
// the Expo runtime. The Markdown library only calls the rule functions and
// passes the result to React — so what matters is the element's props.
function TextStub() {
  return null;
}
const RULE_STYLES: Record<string, any> = {
  text: { color: '#fff' },
  fence: { fontFamily: 'monospace' },
  code_inline: { backgroundColor: '#222' },
  code_block: { padding: 8 },
};
function runRule(rule: any, node: any, inheritedStyles: any = { fontSize: 14 }) {
  return rule(node, null, null, RULE_STYLES, inheritedStyles);
}
describe('trimTrailingNewline', () => {
  it('strips a single trailing newline', () => {
    expect(trimTrailingNewline('hello\n')).toBe('hello');
  });
  it('leaves content without a trailing newline alone', () => {
    expect(trimTrailingNewline('hello')).toBe('hello');
  });
  it('only strips one newline', () => {
    expect(trimTrailingNewline('hello\n\n')).toBe('hello\n');
  });
  it('passes non-string values through unchanged', () => {
    expect(trimTrailingNewline(undefined)).toBe(undefined);
    expect(trimTrailingNewline(42)).toBe(42);
  });
});
describe('createSelectableMarkdownRules', () => {
  const rules = createSelectableMarkdownRules(TextStub);
  it('exposes the four text-rendering rules', () => {
    expect(Object.keys(rules).sort()).toEqual(['code_block', 'code_inline', 'fence', 'text']);
  });
  it('text rule renders the injected Text with selectable=true', () => {
    const el = runRule(rules.text, { key: 'k1', content: 'hello world' });
    expect(el.type).toBe(TextStub);
    expect(el.key).toBe('k1');
    expect(el.props.selectable).toBe(true);
    expect(el.props.children).toBe('hello world');
    // Inherited styles should be merged ahead of rule-specific style.
    expect(el.props.style).toEqual([{ fontSize: 14 }, RULE_STYLES.text]);
  });
  it('code_inline rule is selectable and preserves content verbatim', () => {
    const el = runRule(rules.code_inline, { key: 'c1', content: 'npm test' });
    expect(el.props.selectable).toBe(true);
    expect(el.props.children).toBe('npm test');
    expect(el.props.style).toEqual([{ fontSize: 14 }, RULE_STYLES.code_inline]);
  });
  it('fence rule strips a single trailing newline and is selectable', () => {
    const el = runRule(rules.fence, {
      key: 'f1',
      content: 'function a() {\n  return 1;\n}\n',
    });
    expect(el.props.selectable).toBe(true);
    expect(el.props.children).toBe('function a() {\n  return 1;\n}');
  });
  it('code_block rule strips a single trailing newline and is selectable', () => {
    const el = runRule(rules.code_block, { key: 'b1', content: 'line\n' });
    expect(el.props.selectable).toBe(true);
    expect(el.props.children).toBe('line');
  });
  it('falls back to an empty inheritedStyles object when omitted', () => {
    const el = rules.text({ key: 'k2', content: 'x' }, null, null, RULE_STYLES);
    expect(el.props.style).toEqual([{}, RULE_STYLES.text]);
    expect(el.props.selectable).toBe(true);
  });
});
