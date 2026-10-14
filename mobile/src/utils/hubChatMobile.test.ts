import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { hubChat: {} } }));
import { parseHubChatRefTokens } from '@shared/utils/hubChatRefTokens';
import {
  HUB_REF_SCHEME,
  badgeText,
  chipTokenFor,
  hubChatRefAtPlugin,
  hubChatRefTarget,
  markLiveTokens,
  refFromHref,
} from './hubChatMobile';
import { locateChatMarkdownCode } from './hubChatInstance';

// The renderer's own markdown-it (react-native-markdown-display re-exports it).
const MarkdownIt = require('markdown-it');

/** Every inline token of a body as the chat renderer parses it, after marking. */
function render(body: string) {
  const tokens = parseHubChatRefTokens(body, locateChatMarkdownCode);
  const md = MarkdownIt({ typographer: true }).use(hubChatRefAtPlugin);
  const blocks = md.parse(markLiveTokens(body, tokens), {});
  const inline = blocks.filter((t: any) => t.type === 'inline').flatMap((t: any) => t.children);
  const links = inline.filter((c: any) => c.type === 'link_open');
  return {
    tokens,
    inline,
    links,
    chips: links.map((l: any) => chipTokenFor(l.attrGet('href'), tokens)),
    text: inline
      .filter((c: any) => c.type === 'text' || c.type === 'text_special')
      .map((c: any) => c.content)
      .join(''),
  };
}

describe('chips match live tokens by source occurrence', () => {
  it('marks each live token and drops its leading @', () => {
    const r = render('hi @[bob](user:u1) there');
    expect(r.chips).toEqual([r.tokens[0]]);
    expect(r.inline[0].content).toBe('hi ');
  });

  it('pairs several tokens with their own links', () => {
    const r = render('ping @[bob](user:u1) about @[WEB-12](card:abc) and @[web#7](pr:web#7)');
    expect(r.tokens).toHaveLength(3);
    expect(r.chips).toEqual(r.tokens);
  });

  it('a reference-style link to the same target is not a chip and does not shift the real one', () => {
    const r = render('@[alias][person] then @[bob](user:u1)\n\n[person]: user:u1');
    expect(r.tokens).toHaveLength(1);
    expect(r.links).toHaveLength(2);
    expect(r.chips).toEqual([null, r.tokens[0]]);
    // The alias keeps its `@`; only the live token's is dropped.
    expect(r.text).toContain('@alias');
    expect(r.text).not.toContain('@bob');
  });

  it('escaped and plain links to the same target stay text', () => {
    const r = render('@[bob](user:u1) and \\@[bob](user:u1) and [bob](user:u1)');
    expect(r.tokens).toHaveLength(1);
    expect(r.chips).toEqual([r.tokens[0], null, null]);
  });

  it('a later live token still pairs after an escaped one to the same target', () => {
    const r = render('\\@[bob](user:u1) then @[bob](user:u1)');
    expect(r.chips).toEqual([null, r.tokens[0]]);
  });

  it('keeps a bang before a token a link, not an image', () => {
    const r = render('!@[bob](user:u1)');
    expect(r.inline.some((c: any) => c.type === 'image')).toBe(false);
    expect(r.chips).toEqual([r.tokens[0]]);
  });

  it('leaves code and ordinary links alone', () => {
    expect(render('`@[bob](user:u1)`').links).toHaveLength(0);
    const r = render('see @[docs](https://example.com)');
    expect(r.chips).toEqual([null]);
    expect(r.inline[0].content).toBe('see @');
  });

  it('text typed to look like a marker cannot become a chip', () => {
    const body = `@[bob](user:u1) [x](${HUB_REF_SCHEME}:0)`;
    expect(markLiveTokens(body, parseHubChatRefTokens(body, locateChatMarkdownCode))).toBe(body);
    expect(render('[x](hubref:0)').chips).toEqual([null]);
  });
});

describe('refFromHref', () => {
  it('reads ref schemes and ignores the rest', () => {
    expect(refFromHref('card:abc')).toEqual({ kind: 'card', targetId: 'abc' });
    expect(refFromHref('pr:web%237')).toEqual({ kind: 'pr', targetId: 'web#7' });
    expect(refFromHref('https://example.com')).toBeNull();
    expect(refFromHref('mailto:a@b.c')).toBeNull();
    expect(refFromHref(undefined)).toBeNull();
  });
});

describe('hubChatRefTarget', () => {
  const base = {
    visible: true,
    projectId: 'web',
    label: 'x',
    title: null,
    status: null,
    agentId: null,
    number: null,
  };

  it('opens cards on the board, PRs on their detail, tickets in support', () => {
    expect(hubChatRefTarget({ ...base, kind: 'card', targetId: 'c1' })).toEqual({
      kind: 'screen',
      screen: 'Kanban',
      params: { projectId: 'web', cardId: 'c1' },
    });
    expect(hubChatRefTarget({ ...base, kind: 'pr', targetId: 'web#7', number: 7 })).toEqual({
      kind: 'screen',
      screen: 'PullRequests',
      params: { projectId: 'web', prNumber: 7 },
    });
    expect(hubChatRefTarget({ ...base, kind: 'ticket', targetId: 't1' })).toEqual({
      kind: 'screen',
      screen: 'CustomerSupport',
      params: { projectId: 'web', ticketId: 't1' },
    });
  });

  it('opens a session through its agent', () => {
    expect(hubChatRefTarget({ ...base, kind: 'session', targetId: 's1', agentId: 'a1' })).toEqual({
      kind: 'session',
      agentId: 'a1',
      sessionId: 's1',
    });
  });

  it('has nowhere to go for hidden refs and people', () => {
    expect(hubChatRefTarget({ ...base, kind: 'card', targetId: 'c1', visible: false })).toBeNull();
    expect(hubChatRefTarget({ ...base, kind: 'user', targetId: 'u1' })).toBeNull();
  });
});

describe('badgeText', () => {
  it('caps at 99+', () => {
    expect(badgeText(7)).toBe('7');
    expect(badgeText(150)).toBe('99+');
  });
});
