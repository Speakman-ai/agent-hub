/**
 * The markdown code locator for chat refs on the server. It parses with the
 * same CommonMark + GFM parser the web renderer runs on (`react-markdown` +
 * `remark-gfm` sit on `mdast-util-from-markdown` + `micromark-extension-gfm`),
 * so a token the client shows as literal code is never stored as a ref.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { createMarkdownLocator, type MarkdownNode } from '../shared/utils/hubChatRefTokens.js';

export const locateChatMarkdownCode = createMarkdownLocator(
  (body) =>
    fromMarkdown(body, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode,
);
