import React from 'react';

// Overrides for `react-native-markdown-display` that render every text leaf
// with `selectable` enabled, so users can drag-select and copy partial text
// from a chat bubble (like they can in a browser) instead of being limited
// to the bubble-level long-press-to-copy behavior.
//
// Mirrors the library's default text / fence / code_inline / code_block
// rules verbatim — including the trailing-newline trim for fence/code_block
// — and adds the single `selectable` prop. Keeping the default styling
// pipeline (`inheritedStyles` + rule style) intact means markdown formatting
// is unaffected.
//
// The `Text` component is injected rather than imported so the rules are
// unit-testable in a plain-node Vitest environment (which can't resolve
// `react-native`).

export function trimTrailingNewline(content) {
  if (typeof content === 'string' && content.charAt(content.length - 1) === '\n') {
    return content.substring(0, content.length - 1);
  }
  return content;
}

export function createSelectableMarkdownRules(Text) {
  return {
    text: (node, children, parent, styles, inheritedStyles = {}) =>
      React.createElement(
        Text,
        { key: node.key, style: [inheritedStyles, styles.text], selectable: true },
        node.content,
      ),
    fence: (node, children, parent, styles, inheritedStyles = {}) =>
      React.createElement(
        Text,
        { key: node.key, style: [inheritedStyles, styles.fence], selectable: true },
        trimTrailingNewline(node.content),
      ),
    code_inline: (node, children, parent, styles, inheritedStyles = {}) =>
      React.createElement(
        Text,
        { key: node.key, style: [inheritedStyles, styles.code_inline], selectable: true },
        node.content,
      ),
    code_block: (node, children, parent, styles, inheritedStyles = {}) =>
      React.createElement(
        Text,
        { key: node.key, style: [inheritedStyles, styles.code_block], selectable: true },
        trimTrailingNewline(node.content),
      ),
  };
}
