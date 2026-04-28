import { useEffect, useRef, useState } from 'react';

/**
 * Lazy-loaded singleton mermaid module. Mermaid pulls in a large dependency
 * tree (d3, dagre, cytoscape, etc.), so we dynamic-import on first use to
 * keep the main client bundle lean — surfaces that never render a diagram
 * never pay the cost.
 */
let mermaidPromise = null;

export function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default || m;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        fontFamily: 'inherit',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let idCounter = 0;

/**
 * Render a Mermaid diagram from raw source text. Renders to SVG asynchronously
 * (mermaid.render is async). On parse/render error, falls back to a styled
 * error box that also shows the original source so the user isn't left staring
 * at a blank panel.
 */
export default function MermaidDiagram({ source }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(null);
  const idRef = useRef(`mermaid-${++idCounter}`);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSvg('');
    if (!source || !source.trim()) {
      return () => {
        cancelled = true;
      };
    }
    loadMermaid()
      .then(async (mermaid) => {
        try {
          // mermaid.render mutates DOM with a temp node — use a unique id per render.
          const renderId = `${idRef.current}-${Date.now()}`;
          const result = await mermaid.render(renderId, source);
          if (cancelled) return;
          setSvg(result?.svg || '');
        } catch (e) {
          if (cancelled) return;
          setError(String(e?.message || e));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Failed to load mermaid: ${String(e?.message || e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (error) {
    return (
      <div
        className="my-2 p-3 rounded-lg bg-red-950/40 border border-red-900 text-xs text-red-300"
        data-testid="mermaid-error"
      >
        <div className="font-medium mb-1">Mermaid render error</div>
        <pre className="whitespace-pre-wrap text-red-200/80 mb-2">{error}</pre>
        <pre className="whitespace-pre-wrap text-gray-400">{source}</pre>
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram my-2 flex justify-center bg-gray-950 rounded-lg p-3 overflow-x-auto"
      data-testid="mermaid-diagram"
      // mermaid produces a self-contained <svg> string; injecting as HTML is
      // the documented usage. `securityLevel: 'loose'` is safe here because
      // wiki content authorship is gated behind authenticated org members.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
