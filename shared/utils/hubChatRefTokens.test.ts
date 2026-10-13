import { describe, it, expect } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import {
  HUB_CHAT_REF_MAX_ID,
  HUB_CHAT_REF_MAX_LABEL,
  formatHubChatRefToken,
  hubChatRefDisplay,
  hubChatRefsToPlainText,
  createMarkdownLocator,
  escapeMarkdownText,
  parseHubChatRefTokens,
  sanitizeHubChatRefLabel,
  type MarkdownNode,
} from './hubChatRefTokens';

// The renderer's parser (react-markdown + remark-gfm sit on these).
const locate = createMarkdownLocator(
  (body) =>
    fromMarkdown(body, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode,
);

describe('hub chat ref token grammar', () => {
  it('every formatted token parses back, whatever the label', () => {
    const labels = [
      'bob',
      'a]b\nc\r\nd',
      '  spaced   out  ',
      'x'.repeat(HUB_CHAT_REF_MAX_LABEL),
      'y'.repeat(HUB_CHAT_REF_MAX_LABEL + 1),
      'z '.repeat(500),
      '',
    ];
    for (const label of labels) {
      const token = formatHubChatRefToken(label, 'ticket', 't1');
      expect(token).not.toBeNull();
      const [parsed] = parseHubChatRefTokens(`see ${token} now`, locate);
      expect(parsed?.raw, JSON.stringify(label)).toBe(token);
      expect(parsed.targetId).toBe('t1');
      expect(parsed.label.length).toBeLessThanOrEqual(HUB_CHAT_REF_MAX_LABEL);
    }
  });

  it('truncates a long label with an ellipsis', () => {
    const label = sanitizeHubChatRefLabel('w'.repeat(500));
    expect(label).toHaveLength(HUB_CHAT_REF_MAX_LABEL);
    expect(label.endsWith('…')).toBe(true);
  });

  it('display text matches the label a token stores', () => {
    const long = 'Login fails '.repeat(40);
    const token = formatHubChatRefToken(long, 'ticket', 't1') as string;
    const [parsed] = parseHubChatRefTokens(token, locate);
    expect(hubChatRefDisplay('ticket', long)).toBe(`#${parsed.label}`);
  });

  it('refuses ids the parser cannot read', () => {
    expect(formatHubChatRefToken('x', 'card', '')).toBeNull();
    expect(formatHubChatRefToken('x', 'card', 'a b')).toBeNull();
    expect(formatHubChatRefToken('x', 'card', 'a)b')).toBeNull();
    expect(formatHubChatRefToken('x', 'card', 'i'.repeat(HUB_CHAT_REF_MAX_ID + 1))).toBeNull();
    expect(formatHubChatRefToken('x', 'card', 'i'.repeat(HUB_CHAT_REF_MAX_ID))).not.toBeNull();
  });

  it('renders plain text with each kind’s trigger', () => {
    expect(
      hubChatRefsToPlainText('hi @[bob](user:u1), see @[WEB-3](card:c3) @[x](nope:1)', locate),
    ).toBe('hi @bob, see #WEB-3 @[x](nope:1)');
  });
});

describe('markdown code boundaries (renderer parser)', () => {
  const tok = '@[bob](user:u1)';
  const live = (body: string) => parseHubChatRefTokens(body, locate).length;

  it('finds fenced, indented and inline code and raw HTML', () => {
    const body = 'a `x` b ``y ` z`` c\n\n```ts\ncode\n```\n\n    indented\n\n<div>html</div>';
    const spans = locate(body).code.map(([s, e]) => body.slice(s, e));
    expect(spans).toEqual([
      '`x`',
      '``y ` z``',
      '```ts\ncode\n```',
      '    indented',
      '<div>html</div>',
    ]);
  });

  it('treats an indented block as code', () => {
    expect(live(`    ${tok}`)).toBe(0);
    expect(live(`\t${tok}`)).toBe(0);
    expect(live(`intro\n\n    ${tok}\n\nafter ${tok}`)).toBe(1);
    // Nested under a list item, code needs the item's indent plus four.
    expect(live(`- item\n\n      ${tok}`)).toBe(0);
  });

  it('keeps an indented line that the renderer reads as paragraph text', () => {
    // A lazy continuation line is not code, so the mention is real.
    expect(live(`intro\n    ${tok}`)).toBe(1);
    // Inside a list item, four spaces is just the item's paragraph.
    expect(live(`- item\n\n    ${tok}`)).toBe(1);
  });

  it('skips tokens in fences, inline code and HTML, and keeps the rest', () => {
    const body = `\`${tok}\` ${tok}\n\n\`\`\`\n${tok}\n\`\`\`\n\n~~~\n${tok}\n~~~\n\n<div>\n${tok}\n</div>\n\n${tok}`;
    const tokens = parseHubChatRefTokens(body, locate);
    expect(tokens).toHaveLength(2);
    for (const t of tokens) expect(body.slice(t.index, t.index + t.raw.length)).toBe(tok);
  });

  it('keeps a token between inline HTML tags, which the renderer links', () => {
    expect(live(`<span>${tok}</span>`)).toBe(1);
  });

  it('runs an unclosed fence to the end and ignores an unmatched backtick', () => {
    expect(live(`a\n\n~~~\n${tok}`)).toBe(0);
    expect(live(`just \` ${tok}`)).toBe(1);
  });

  it('treats a backslash-escaped token as literal text', () => {
    expect(live(`\\${tok}`)).toBe(0);
    expect(live(`see \\${tok} and ${tok}`)).toBe(1);
    // An escaped backslash leaves the @ unescaped.
    expect(live(`\\\\${tok}`)).toBe(1);
    expect(live(`\\\\\\${tok}`)).toBe(0);
  });

  it('only counts tokens Markdown actually parses as links', () => {
    // An escaped bracket breaks the link, so it is not a ref either.
    expect(live('@\\[bob](user:u1)')).toBe(0);
    // Inside another link's brackets the inner link wins (CommonMark), so
    // the renderer links the token and it counts.
    expect(live(`[see ${tok}](https://x.test)`)).toBe(1);
  });

  it('leaves literal spans untouched in plain text', () => {
    expect(hubChatRefsToPlainText(`    ${tok}\n\nhi ${tok}`, locate)).toBe(`    ${tok}\n\nhi @bob`);
  });
});

describe('escapeMarkdownText', () => {
  type N = { type: string; value?: string; children?: N[] };
  const rendered = (md: string): string => {
    const tree = fromMarkdown(md, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as N;
    const text = (n: N): string => n.value ?? (n.children ?? []).map(text).join('');
    // Literal text must stay one paragraph of plain text nodes.
    expect(tree.children?.map((c) => c.type)).toEqual(['paragraph']);
    const kinds = new Set<string>();
    const walk = (n: N) => {
      kinds.add(n.type);
      (n.children ?? []).forEach(walk);
    };
    walk(tree);
    expect([...kinds].sort()).toEqual(['paragraph', 'root', 'text']);
    return text(tree);
  };

  const samples = [
    '[Bug] Login broken',
    'ends in \\',
    '**bold** _em_ ~~x~~ `code`',
    '<b>tag</b> &amp; [a](b) ![i](j)',
    'a | b',
    '# heading',
    '> quote',
    '- item',
    '+ item',
    '1. step',
    '2) step',
    '=== setext',
    'VLT-1 web#7 @mallory',
  ];

  for (const sample of samples) {
    it(JSON.stringify(sample), () => {
      expect(rendered(escapeMarkdownText(sample, true))).toBe(sample);
      expect(rendered(`x ${escapeMarkdownText(sample, false)}`)).toBe(`x ${sample}`);
    });
  }

  it('leaves ordinary punctuation readable', () => {
    expect(escapeMarkdownText('VLT-1 web#7 @mallory', false)).toBe('VLT-1 web#7 @mallory');
  });
});
