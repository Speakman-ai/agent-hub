/**
 * The markdown code locator for chat refs in the web client. Same parser and
 * extensions as `MarkdownContent` (`react-markdown` + `remark-gfm`), so the
 * composer, the editor and chip rendering treat exactly the renderer's code
 * blocks, inline code and raw HTML as literal text.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { createMarkdownLocator, type MarkdownNode } from '@shared/utils/hubChatRefTokens';

export const locateChatMarkdownCode = createMarkdownLocator(
  (body) =>
    fromMarkdown(body, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode,
);
