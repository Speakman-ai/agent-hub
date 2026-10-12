/** Category keys returned by GET /api/sessions/:id/context-usage. */
export type ContextUsageCategoryKey =
  | 'system'
  | 'rules'
  | 'skills'
  | 'wiki'
  | 'memory'
  | 'engine'
  | 'conversation';

/** GET /api/sessions/:id/context-usage */
export interface SessionContextUsage {
  sessionId: string;
  engine: string | null;
  model: string | null;
  source: 'reported' | 'estimated' | 'none';
  totalTokens: number;
  contextWindow: number | null;
  percent: number | null;
  categories: Array<{ key: ContextUsageCategoryKey; label: string; tokens: number }>;
  updatedAt: string | null;
}

/** Swatch colors per category, shared by the bar and the legend. */
export const CONTEXT_CATEGORY_COLORS: Record<ContextUsageCategoryKey, string> = {
  system: '#cbd5e1',
  rules: '#86efac',
  skills: '#fcd34d',
  wiki: '#67e8f9',
  memory: '#c084fc',
  engine: '#818cf8',
  conversation: '#ea580c',
};

/** 1700 → "1.7K", 256000 → "256K", 1000000 → "1M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  const [div, unit] = n >= 1_000_000 ? [1_000_000, 'M'] : [1000, 'K'];
  const v = n / div;
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded}${unit}`;
}

/** Bar segment widths as percentages of the context window (or of the total when unknown). */
export function contextBarSegments(
  categories: Array<{ key: ContextUsageCategoryKey; tokens: number }>,
  contextWindow: number | null,
): Array<{ key: ContextUsageCategoryKey; widthPct: number }> {
  const total = categories.reduce((a, c) => a + c.tokens, 0);
  const denom = Math.max(contextWindow ?? 0, total);
  if (denom <= 0) return [];
  return categories
    .filter((c) => c.tokens > 0)
    .map((c) => ({ key: c.key, widthPct: (c.tokens / denom) * 100 }));
}

/**
 * Poll `fetchUsage` every `intervalMs` until the returned stop function runs.
 * Only the newest response is applied: one that resolves after a later
 * request already landed is dropped, and nothing applies after stop. Callers
 * start a fresh poller per session, so a slow response for the previous
 * session can't overwrite the current one.
 */
export function startLatestOnlyPolling<T>(opts: {
  fetchUsage: () => Promise<T>;
  onData: (data: T) => void;
  onError: (err: unknown) => void;
  intervalMs: number;
}): () => void {
  let stopped = false;
  let issued = 0;
  let applied = 0;
  const tick = () => {
    const seq = ++issued;
    opts.fetchUsage().then(
      (data) => {
        if (stopped || seq < applied) return;
        applied = seq;
        opts.onData(data);
      },
      (err: unknown) => {
        if (stopped || seq < applied) return;
        opts.onError(err);
      },
    );
  };
  tick();
  const timer = setInterval(tick, opts.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
