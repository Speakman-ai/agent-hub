import React, { useState } from 'react';
import { parseWikiRagIndicator } from '@shared/utils/wikiRagIndicator';

/**
 * Chip rendered under an assistant bubble when the automatic wiki-RAG path ran
 * for that turn. `consulted` shows "Consulted wiki · N pages" and expands to the
 * page list; `no_match` shows a subtle "Wiki checked · no strong match" (retrieval
 * ran but nothing cleared the relevance floor). Renders nothing when the message
 * carries no wiki-RAG metadata.
 */
function WikiConsultedChip({ metadata }: { metadata: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const indicator = parseWikiRagIndicator(metadata);
  if (!indicator) return null;

  if (indicator.status === 'no_match') {
    return (
      <div className="mt-1.5">
        <span
          className="inline-flex items-center gap-1 text-[11px] text-gray-500"
          title={indicator.query ? `Wiki searched for: ${indicator.query}` : undefined}
        >
          <span aria-hidden>📖</span>
          Wiki checked · no strong match
        </span>
      </div>
    );
  }

  const count = indicator.retrieved || indicator.pages.length;
  const canExpand = indicator.pages.length > 0;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => canExpand && setExpanded((v) => !v)}
        className={`inline-flex items-center gap-1 rounded-full border border-emerald-800/50 bg-emerald-900/20 px-2 py-0.5 text-[11px] text-emerald-300 transition-colors ${
          canExpand ? 'hover:bg-emerald-900/40 cursor-pointer' : 'cursor-default'
        }`}
        aria-expanded={canExpand ? expanded : undefined}
        title={indicator.query ? `Wiki searched for: ${indicator.query}` : undefined}
      >
        <span aria-hidden>📖</span>
        Consulted wiki · {count} {count === 1 ? 'page' : 'pages'}
        {canExpand && <span aria-hidden>{expanded ? '▾' : '▸'}</span>}
      </button>
      {expanded && canExpand && (
        <ul className="mt-1 space-y-0.5 pl-1">
          {indicator.pages.map((p) => (
            <li key={p.slug} className="text-[11px] text-gray-400">
              <span className="text-gray-300">{p.title}</span>
              {p.category ? <span className="text-gray-600"> · {p.category}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default WikiConsultedChip;
