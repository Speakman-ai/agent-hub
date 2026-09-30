import type { Root, RootContent } from 'mdast';
import { parseDetailsOpener, isDetailsCloser } from '@shared/utils/voiceNoteMarkdown';

const DETAILS_CLASS =
  'notes-details my-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2';
const SUMMARY_CLASS =
  'cursor-pointer select-none text-xs font-medium text-gray-400 hover:text-gray-200';

/**
 * Remark plugin: folds top-level `<details><summary>…</summary> … </details>`
 * HTML runs into a real `<details>` element whose children are the markdown
 * parsed between them. Notes render without raw HTML, so this is the only way
 * the opener/closer tags become a collapsible section. Children keep their
 * source positions, so heading-line features (Scope, Ticket) still line up.
 */
export default function remarkDetails() {
  return (tree: Root) => {
    tree.children = foldDetails(tree.children);
  };
}

function foldDetails(nodes: RootContent[]): RootContent[] {
  const out: RootContent[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const opener = node.type === 'html' ? parseDetailsOpener(node.value) : null;
    if (!opener) {
      out.push(node);
      continue;
    }
    let depth = 1;
    let end = -1;
    for (let k = i + 1; k < nodes.length; k++) {
      const n = nodes[k];
      if (n.type !== 'html') continue;
      if (parseDetailsOpener(n.value)) depth++;
      else if (isDetailsCloser(n.value) && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end === -1) {
      out.push(node);
      continue;
    }
    const inner = foldDetails(nodes.slice(i + 1, end));
    if (opener.rest) {
      inner.unshift({ type: 'paragraph', children: [{ type: 'text', value: opener.rest }] });
    }
    const summary = {
      type: 'paragraph',
      data: { hName: 'summary', hProperties: { className: SUMMARY_CLASS } },
      children: [{ type: 'text', value: opener.summary }],
    };
    out.push({
      type: 'blockquote',
      position: node.position,
      data: { hName: 'details', hProperties: { className: DETAILS_CLASS } },
      children: [summary, ...inner],
    } as unknown as RootContent);
    i = end;
  }
  return out;
}
