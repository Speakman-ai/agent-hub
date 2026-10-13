import { describe, it, expect } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import {
  addComposerMention,
  decodeToComposer,
  reconcileComposerMentions,
  encodeComposerMentions,
  findMentionQuery,
  formatHubChatRefToken,
  hubChatRefHref,
  insertMentionText,
  parseHubChatRefTokens,
  markHubChatRefLinks,
  type MarkableNode,
  type HubChatResolvedRef,
} from './hubChatRefs';
import {
  createMarkdownLocator,
  hubChatRefsToPlainText,
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

function resolved(over: Partial<HubChatResolvedRef>): HubChatResolvedRef {
  return {
    kind: 'card',
    targetId: 't1',
    visible: true,
    projectId: 'web',
    label: null,
    title: null,
    status: null,
    agentId: null,
    number: null,
    ...over,
  };
}

/**
 * What the chat renderer shows for `body`: it parses the original body,
 * marks live refs in that tree, and turns marked links into chips. Returns
 * the visible text with each chip as `{n:label-text}`, plus node-type counts.
 */
function renderRefs(body: string) {
  type N = MarkableNode & { url?: string };
  const tree = fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as N;
  const tokens = parseHubChatRefTokens(body, locate);
  markHubChatRefLinks(tree, tokens);
  const types: Record<string, number> = {};
  const chips: { n: number; targetId: string }[] = [];
  const text = (n: N): string => {
    types[n.type] = (types[n.type] ?? 0) + 1;
    const ref = n.data?.hProperties?.['data-hubref'];
    if (n.type === 'link' && typeof ref === 'string') {
      const t = tokens[Number(ref)];
      chips.push({ n: Number(ref), targetId: t.targetId });
      return `{${t.targetId}}`;
    }
    return n.value ?? (n.children ?? []).map((c) => text(c as N)).join('');
  };
  return { text: text(tree), chips, types, tokens };
}

describe('hubChatRefs tokens', () => {
  it('parses known kinds only', () => {
    const toks = parseHubChatRefTokens('@[a](user:u1) @[x](nope:1) @[web#2](pr:web#2)', locate);
    expect(toks.map((t) => `${t.kind}:${t.targetId}`)).toEqual(['user:u1', 'pr:web#2']);
  });

  it('escapes Markdown characters in a token label and folds line breaks', () => {
    expect(formatHubChatRefToken('a]b\nc', 'card', 'c1')).toBe('@[a\\]b c](card:c1)');
  });
});

describe('findMentionQuery', () => {
  it('opens on @ or # at a word start', () => {
    expect(findMentionQuery('hi @al', 6, locate)).toEqual({ trigger: '@', query: 'al', start: 3 });
    expect(findMentionQuery('#WEB-1', 6, locate)).toEqual({
      trigger: '#',
      query: 'WEB-1',
      start: 0,
    });
    expect(findMentionQuery('see (#', 6, locate)).toEqual({ trigger: '#', query: '', start: 5 });
  });

  it('lets a # query carry a project#number separator', () => {
    expect(findMentionQuery('see #web#7', 10, locate)).toEqual({
      trigger: '#',
      query: 'web#7',
      start: 4,
    });
    expect(findMentionQuery('#web#', 5, locate)).toEqual({ trigger: '#', query: 'web#', start: 0 });
    expect(findMentionQuery('@bo#b', 5, locate)).toBeNull();
  });

  it('ignores emails, C# and finished words', () => {
    expect(findMentionQuery('a@b.com', 7, locate)).toBeNull();
    expect(findMentionQuery('C#', 2, locate)).toBeNull();
    expect(findMentionQuery('@bob ', 5, locate)).toBeNull();
  });
});

describe('composer encode/decode', () => {
  it('inserts the display text and encodes it on send', () => {
    const { text, caret } = insertMentionText('ping @bo now', 5, 8, '@bob');
    expect(text).toBe('ping @bob now');
    expect(caret).toBe(9);
    const encoded = encodeComposerMentions(
      text,
      [{ display: '@bob', token: '@[bob](user:u2)', at: 5 }],
      locate,
    );
    expect(encoded).toBe('ping @[bob](user:u2) now');
  });

  it('drops a mention when typing turns it into a different word', () => {
    const m = [{ display: '@bob', token: '@[bob](user:u2)', at: 0 }];
    const send = (prev: string, next: string, caret: number, ms = m) =>
      encodeComposerMentions(next, reconcileComposerMentions(prev, next, ms, caret), locate);
    expect(send('@bob', '@bobby', 6)).toBe('@bobby');
    expect(send('@bob', 'x@bob', 1)).toBe('x@bob');
    // Punctuation and emphasis markers typed next to it keep the mention.
    expect(send('@bob', '@bob.', 5)).toBe('@[bob](user:u2).');
    expect(send('@bob', '@bob_', 5)).toBe('@[bob](user:u2)_');
    expect(send('@bob', '_@bob', 1)).toBe('_@[bob](user:u2)');
  });

  it('judges joins by the resulting text, whether typed, deleted or replaced', () => {
    const bob = (at: number) => ({ display: '@bob', token: '@[bob](user:u2)', at });
    const cases: [string, string, string, number, number, string][] = [
      // [what, prev, next, caret, mention offset in prev, sent]
      ['delete the space after', '@bob by', '@bobby', 4, 0, '@bobby'],
      ['delete the space before', 'x @bob', 'x@bob', 1, 2, 'x@bob'],
      ['delete space before, word', 'hi @bob', 'hi@bob', 2, 3, 'hi@bob'],
      ['delete the space after, digit', '@bob 7', '@bob7', 4, 0, '@bob7'],
      ['delete a comma between', '@bob,by', '@bobby', 4, 0, '@bobby'],
      ['replace a span with a word', '@bob and more', '@bobby more', 6, 0, '@bobby more'],
      ['non-Latin letter', '@bob', '@bobé', 5, 0, '@bobé'],
      ['type after, keeps on punctuation', '@bob', '@bob.', 5, 0, '@[bob](user:u2).'],
      ['delete space, emphasis after', '@bob _', '@bob_', 4, 0, '@[bob](user:u2)_'],
      ['delete space, bracket before', '( @bob', '(@bob', 1, 2, '(@[bob](user:u2)'],
      ['delete space, emoji before', '🙂 @bob', '🙂@bob', 2, 3, '🙂@[bob](user:u2)'],
      ['delete comma, space now after', '@bob, by', '@bob by', 4, 0, '@[bob](user:u2) by'],
      ['edit before shifts it', 'x and @bob', '@bob', 0, 6, '@[bob](user:u2)'],
      ['edit far away', 'x_@bob_y z', 'x_@bob_y zz', 11, 2, 'x_@[bob](user:u2)_y zz'],
    ];
    for (const [what, prev, next, caret, at, sent] of cases) {
      const carried = reconcileComposerMentions(prev, next, [bob(at)], caret);
      expect(encodeComposerMentions(next, carried, locate), what).toBe(sent);
    }
  });

  it('round-trips mentions wrapped in Markdown emphasis and punctuation', () => {
    for (const body of [
      '_@[bob](user:u2)_',
      '*@[bob](user:u2)*',
      '**@[bob](user:u2)**',
      '__@[bob](user:u2)__',
      '~~@[WEB-3](card:c3)~~',
      '(@[bob](user:u2))',
      '"@[bob](user:u2)"',
      "@[bob](user:u2)'s idea, @[WEB-3](card:c3)-related",
      'x_@[bob](user:u2)_y',
    ]) {
      const decoded = decodeToComposer(body, locate);
      expect(decoded.mentions, body).toHaveLength(parseHubChatRefTokens(body, locate).length);
      expect(encodeComposerMentions(decoded.text, decoded.mentions, locate), body).toBe(body);
    }
  });

  it('keeps an emphasised mention through an unrelated edit', () => {
    const decoded = decodeToComposer('hi _@[bob](user:u2)_', locate);
    expect(decoded.text).toBe('hi _@bob_');
    const next = 'hi _@bob_ thanks';
    const carried = reconcileComposerMentions(decoded.text, next, decoded.mentions, next.length);
    expect(encodeComposerMentions(next, carried, locate)).toBe('hi _@[bob](user:u2)_ thanks');
  });

  it('opens the picker after an emphasis marker', () => {
    expect(findMentionQuery('_@bo', 4, locate)).toEqual({ trigger: '@', query: 'bo', start: 1 });
    expect(findMentionQuery('**#WEB', 6, locate)).toEqual({ trigger: '#', query: 'WEB', start: 2 });
  });

  it('round-trips a stored body through the editor', () => {
    const body = 'hey @[bob](user:u2), look at @[WEB-3](card:c3)';
    const decoded = decodeToComposer(body, locate);
    expect(decoded.text).toBe('hey @bob, look at #WEB-3');
    expect(encodeComposerMentions(decoded.text, decoded.mentions, locate)).toBe(body);
  });

  it('keeps each target when two refs share a label', () => {
    const body = '@[Login](ticket:t1) and @[Login](ticket:t2)';
    const decoded = decodeToComposer(body, locate);
    expect(decoded.text).toBe('#Login and #Login');
    expect(encodeComposerMentions(decoded.text, decoded.mentions, locate)).toBe(body);

    // Editing text between them keeps both targets in place.
    const edited = '#Login or #Login';
    const carried = reconcileComposerMentions(decoded.text, edited, decoded.mentions, 9);
    expect(encodeComposerMentions(edited, carried, locate)).toBe(
      '@[Login](ticket:t1) or @[Login](ticket:t2)',
    );
  });

  it('drops the occurrence the user deleted, even when labels match', () => {
    const decoded = decodeToComposer('@[Login](ticket:t1) @[Login](ticket:t2)', locate);
    // Delete the first "#Login " (caret ends at 0).
    const next = '#Login';
    const carried = reconcileComposerMentions(decoded.text, next, decoded.mentions, 0);
    expect(encodeComposerMentions(next, carried, locate)).toBe('@[Login](ticket:t2)');
  });

  it('drops a mention the edit cut into and shifts the ones after it', () => {
    const mentions = [
      { display: '@bob', token: '@[bob](user:u2)', at: 0 },
      { display: '@amy', token: '@[amy](user:u3)', at: 5 },
    ];
    const carried = reconcileComposerMentions('@bob @amy', '@bo @amy', mentions, 3);
    expect(carried).toEqual([{ display: '@amy', token: '@[amy](user:u3)', at: 4 }]);
  });

  it('adds a picked mention by position, not by label', () => {
    const a = { display: '#Login', token: '@[Login](ticket:t1)', at: 0 };
    const b = { display: '#Login', token: '@[Login](ticket:t2)', at: 7 };
    expect(addComposerMention([a], b)).toEqual([a, b]);
    expect(encodeComposerMentions('#Login #Login', [a, b], locate)).toBe(
      '@[Login](ticket:t1) @[Login](ticket:t2)',
    );
  });
});

describe('markHubChatRefLinks', () => {
  it('marks live refs in the original parse and leaves code alone', () => {
    const r = renderRefs('see @[WEB-3](card:c3) and `@[x](user:u1)` @[bob](user:u2)');
    expect(r.text).toBe('see {c3} and @[x](user:u1) {u2}');
    expect(r.chips.map((c) => c.n)).toEqual([0, 1]);
  });

  it('never lets a neighbouring character change a ref into another node type', () => {
    // Each prefix can turn following Markdown into an image, emphasis, link
    // label or HTML when the source is rewritten; marking the parse cannot.
    for (const prefix of ['!', '*', '_', '~', '[', '<', '\\\\', '&', '`x` ']) {
      const body = `a ${prefix}@[WEB-3](card:c3) b`;
      const live = parseHubChatRefTokens(body, locate);
      const r = renderRefs(body);
      expect(r.chips.length, body).toBe(live.length);
      expect(r.types.image ?? 0, body).toBe(0);
    }
    const bang = renderRefs('!@[WEB-3](card:c3)');
    expect(bang.text).toBe('!{c3}');
    expect(bang.chips).toEqual([{ n: 0, targetId: 'c3' }]);
  });

  it('drops only the token\'s own "@"', () => {
    expect(renderRefs('mail me@ @[bob](user:u2)').text).toBe('mail me@ {u2}');
    expect(renderRefs('@@[bob](user:u2)').text).toBe('@{u2}');
  });
});

describe('hubChatRefHref', () => {
  it('links each kind to its page', () => {
    expect(hubChatRefHref(resolved({ kind: 'card', targetId: 'c3' }))).toBe(
      '/projects/web/board?card=c3',
    );
    expect(hubChatRefHref(resolved({ kind: 'pr', targetId: 'web#7', number: 7 }))).toBe(
      '/projects/web/pulls/7',
    );
    expect(hubChatRefHref(resolved({ kind: 'ticket', targetId: 'tk' }))).toBe(
      '/projects/web/support?ticket=tk',
    );
    expect(hubChatRefHref(resolved({ kind: 'session', targetId: 's1', agentId: 'web-dev' }))).toBe(
      '/sessions/s1?agent=web-dev',
    );
  });

  it('has no link for a ref the viewer cannot see', () => {
    expect(hubChatRefHref(resolved({ visible: false }))).toBeNull();
  });
});

describe('code literals in the composer and renderer', () => {
  it('does not open the picker inside code', () => {
    expect(findMentionQuery('` @bo', 5, locate)).toEqual({ trigger: '@', query: 'bo', start: 2 });
    expect(findMentionQuery('` @bo`', 5, locate)).toBeNull();
    expect(findMentionQuery('```\n#WEB', 8, locate)).toBeNull();
  });

  it('keeps a mention typed inside code as literal text on send', () => {
    const m = { display: '@bob', token: '@[bob](user:u2)', at: 2 };
    expect(encodeComposerMentions('` @bob`', [m], locate)).toBe('` @bob`');
    expect(encodeComposerMentions('`x` @bob', [{ ...m, at: 4 }], locate)).toBe(
      '`x` @[bob](user:u2)',
    );
  });

  it('round-trips a body whose code holds a literal token', () => {
    const body = '`@[bob](user:u2)` and @[bob](user:u2)';
    const decoded = decodeToComposer(body, locate);
    expect(decoded.text).toBe('`@[bob](user:u2)` and @bob');
    expect(encodeComposerMentions(decoded.text, decoded.mentions, locate)).toBe(body);
    const r = renderRefs('```\n@[bob](user:u2)\n```\n@[bob](user:u2)');
    expect(r.text).toBe('@[bob](user:u2){u2}');
    expect(r.chips).toHaveLength(1);
  });
});

describe('escaped tokens: storage, rendering and editing agree', () => {
  const escaped = 'see \\@[bob](user:u2) and @[amy](user:u3)';

  it('renders, decodes and stores only the live token', () => {
    const stored = parseHubChatRefTokens(escaped, locate).map((t) => t.targetId);
    expect(stored).toEqual(['u3']);
    const r = renderRefs(escaped);
    expect(r.chips.map((c) => c.targetId)).toEqual(['u3']);
    const decoded = decodeToComposer(escaped, locate);
    expect(decoded.text).toBe('see \\@[bob](user:u2) and @amy');
    expect(encodeComposerMentions(decoded.text, decoded.mentions, locate)).toBe(escaped);
  });

  it('never encodes a mention that would land escaped', () => {
    const m = { display: '@bob', token: '@[bob](user:u2)', at: 1 };
    expect(encodeComposerMentions('\\@bob', [m], locate)).toBe('\\@bob');
    expect(encodeComposerMentions('\\\\@bob', [{ ...m, at: 2 }], locate)).toBe(
      '\\\\@[bob](user:u2)',
    );
  });
});

describe('labels with Markdown characters round-trip everywhere', () => {
  const nasty = [
    '[Bug] Login broken',
    'Login broken \\',
    'path\\to\\file',
    '[[nested]] [x](y)',
    '**bold** _em_ ~~gone~~',
    'use `code` here',
    '<b>html</b> &amp; &#35;',
    'see https://example.com and a@b.co',
    '# heading-ish',
    '!',
    '\\@[bob](user:u1)',
  ];

  for (const label of nasty) {
    it(JSON.stringify(label), () => {
      const token = formatHubChatRefToken(label, 'ticket', 't1') as string;
      const body = `see ${token} now`;

      // Storage: one live token whose label decodes to the plain title.
      const [parsed, ...rest] = parseHubChatRefTokens(body, locate);
      expect(rest).toEqual([]);
      expect(parsed).toMatchObject({ raw: token, kind: 'ticket', targetId: 't1', label });

      // Rendering: exactly one chip, and the rest of the text is untouched.
      const r = renderRefs(body);
      expect(r.chips).toEqual([{ n: 0, targetId: 't1' }]);
      expect(r.text).toBe('see {t1} now');

      // Editing: decodes to the readable text and re-encodes to the same token.
      const decoded = decodeToComposer(body, locate);
      expect(decoded.text).toBe(`see #${label} now`);
      expect(encodeComposerMentions(decoded.text, decoded.mentions, locate)).toBe(body);

      // Picking it in the composer sends the live token too.
      const picked = encodeComposerMentions(
        `#${label}`,
        [{ display: `#${label}`, token, at: 0 }],
        locate,
      );
      expect(picked).toBe(token);

      // Previews read like the rendered message.
      expect(hubChatRefsToPlainText(body, locate)).toBe(`see #${label} now`);
    });
  }
});
