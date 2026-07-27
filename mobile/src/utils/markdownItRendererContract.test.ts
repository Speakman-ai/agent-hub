import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Contract guard for the `markdown-it` override in mobile/package.json.
 *
 * Advisories GHSA-6vfc-qv3f-vr6c (CVE-2022-21670) and GHSA-6v5v-wf23-fmfq are
 * only patched at markdown-it 12.3.2 / 14.2.0, but every markdown surface in
 * the app renders through react-native-markdown-display@7, whose newest release
 * still declares `markdown-it: ^10.0.0`. Clearing the advisories therefore means
 * forcing markdown-it past its parent's declared range with an `overrides` entry
 * -- exactly the situation where a lockfile bump can install cleanly and still
 * break the renderer at runtime, because npm can no longer vouch for the range.
 *
 * react-native-markdown-display ships source (`main: src/index.js`), so it can't
 * be imported into this Node-environment suite without a React Native transform.
 * Instead this pins the exact call surface its shipped code uses against
 * whatever version the override resolves to:
 *
 *   src/index.js               `MarkdownIt({typographer: true})`  (no `new`)
 *   lib/util/stringToTokens.js `markdownIt.parse(source, {})`
 *   lib/util/tokensToAST.js    token.{type,content,info,meta,block,markup,
 *                                     attrs,children,nesting}
 *   lib/util/getTokenTypeByToken.js  token.type with `_open`/`_close` suffixes
 *
 * If a future markdown-it major drops the factory call, renames tokens, or
 * changes `attrs` away from `[name, value]` pairs, this fails instead of
 * shipping a blank chat transcript.
 */

/**
 * The token shape react-native-markdown-display reads, declared locally rather
 * than pulled from `@types/markdown-it`. markdown-it ships no types of its own,
 * and the DefinitelyTyped package tracks markdown-it's *current* API -- which
 * would quietly absorb exactly the kind of rename this test exists to catch.
 * Writing the contract down here keeps it pinned to what the renderer needs.
 */
interface MarkdownItToken {
  type: string;
  tag: string;
  content: string;
  markup: string;
  info: string;
  meta: unknown;
  block: boolean;
  nesting: 1 | 0 | -1;
  attrs: Array<[string, string]> | null;
  children: MarkdownItToken[] | null;
}

interface MarkdownItInstance {
  parse(source: string, env: Record<string, unknown>): MarkdownItToken[];
}

type MarkdownItFactory = {
  (options?: Record<string, unknown>): MarkdownItInstance;
  new (options?: Record<string, unknown>): MarkdownItInstance;
};

const require = createRequire(import.meta.url);
const MarkdownIt = require('markdown-it') as MarkdownItFactory;
const markdownItVersion: string = require('markdown-it/package.json').version;

const SOURCE = [
  '# Heading',
  '',
  'text with *emphasis*, `code`, and a [link](https://example.com)',
  '',
  '- first',
  '- second',
  '',
  '> quoted',
  '',
  '```js',
  'let a = 1;',
  '```',
].join('\n');

describe('markdown-it override honours the react-native-markdown-display contract', () => {
  it('clears the advisory floor the override exists to reach', () => {
    const [major, minor] = markdownItVersion.split('.').map((n) => parseInt(n, 10));
    expect(
      major > 14 || (major === 14 && minor >= 2),
      `markdown-it@${markdownItVersion} is below the GHSA-6v5v-wf23-fmfq floor 14.2.0`,
    ).toBe(true);
  });

  it('is constructible as a bare factory call, without `new`', () => {
    // src/index.js defaults the `markdownit` prop to `MarkdownIt({typographer: true})`.
    const md = MarkdownIt({ typographer: true });
    expect(md).toBeInstanceOf(MarkdownIt);
    expect(typeof md.parse).toBe('function');
  });

  it('exposes every token field the AST builder reads', () => {
    const tokens = MarkdownIt({ typographer: true }).parse(SOURCE, {});
    expect(tokens.length).toBeGreaterThan(0);

    for (const token of tokens) {
      // createNode() reads all of these off every token; `undefined` for the
      // optional ones is fine, a missing property shape is not.
      expect(typeof token.type).toBe('string');
      expect(typeof token.content).toBe('string');
      expect(typeof token.markup).toBe('string');
      expect(typeof token.info).toBe('string');
      expect(typeof token.block).toBe('boolean');
      expect([1, 0, -1]).toContain(token.nesting);
      if (token.attrs !== null) {
        // Reduced as `const [name, value] = curr` -- must stay pair tuples.
        for (const attr of token.attrs) {
          expect(Array.isArray(attr)).toBe(true);
          expect(attr).toHaveLength(2);
        }
      }
    }
  });

  it('emits the block token types the renderer maps to components', () => {
    const types = new Set(MarkdownIt({ typographer: true }).parse(SOURCE, {}).map((t) => t.type));
    // getTokenTypeByToken strips `_open`/`_close`, so these names are the
    // renderRules keys. A rename upstream silently renders nothing.
    for (const expected of [
      'heading_open',
      'inline',
      'paragraph_open',
      'bullet_list_open',
      'list_item_open',
      'blockquote_open',
      'fence',
    ]) {
      expect(types.has(expected), `markdown-it no longer emits a "${expected}" token`).toBe(true);
    }
  });

  it('nests inline children and preserves link attrs and fence info', () => {
    const tokens = MarkdownIt({ typographer: true }).parse(SOURCE, {});

    const inline = tokens.find((t) => t.type === 'inline');
    expect(inline, 'expected an inline token').toBeDefined();
    expect(Array.isArray(inline!.children)).toBe(true);

    // tokensToAST recurses into token.children, so link attributes must survive
    // one level down -- that is what makes onLinkPress work.
    const linkOpen = tokens.flatMap((t) => t.children ?? []).find((t) => t.type === 'link_open');
    expect(linkOpen, 'expected a nested link_open token').toBeDefined();
    expect(Object.fromEntries(linkOpen!.attrs ?? [])).toMatchObject({
      href: 'https://example.com',
    });

    const fence = tokens.find((t) => t.type === 'fence');
    expect(fence?.info).toBe('js');
    expect(fence?.content).toBe('let a = 1;\n');
  });

  it('produces balanced nesting so the AST stack unwinds cleanly', () => {
    // tokensToAST push/pops on nesting 1/-1; an unbalanced stream throws on
    // `stack.pop()` returning undefined.
    let depth = 0;
    for (const token of MarkdownIt({ typographer: true }).parse(SOURCE, {})) {
      depth += token.nesting;
      expect(depth, 'nesting went negative').toBeGreaterThanOrEqual(0);
    }
    expect(depth, 'nesting did not return to zero').toBe(0);
  });
});
