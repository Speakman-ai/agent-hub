import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthHeaders } from '../utils/connection';

export interface WikiScanStarted {
  sessionId: string;
  agentId: string;
  reused: boolean;
}

/**
 * Start (or rejoin) a docs-agent scan that audits the wiki against the
 * codebase. Resolves with the session, or throws with the server's message.
 */
export async function startWikiScan(
  apiBase: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WikiScanStarted> {
  const res = await fetchImpl(`${apiBase}/projects/${projectId}/wiki/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Scan failed (${res.status})`);
  return { sessionId: data.sessionId, agentId: data.agentId, reused: Boolean(data.reused) };
}

type ShowToast = (message: string, type?: string) => void;

/**
 * Scan state for one project's wiki. A response that lands after the
 * project changed (or the component unmounted) is dropped, so project A's
 * scan never shows up while viewing project B.
 */
export function useWikiScan(
  apiBase: string,
  projectId: string | null | undefined,
  showToast?: ShowToast,
  start: typeof startWikiScan = startWikiScan,
) {
  const [starting, setStarting] = useState(false);
  const [scan, setScan] = useState<WikiScanStarted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setScan(null);
    setError(null);
    setStarting(false);
    return () => {
      generationRef.current += 1;
    };
  }, [projectId]);

  const startScan = useCallback(async () => {
    if (!projectId || starting) return;
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    setStarting(true);
    setError(null);
    try {
      const started = await start(apiBase, projectId);
      if (!isCurrent()) return;
      setScan(started);
      showToast?.(
        started.reused ? 'A wiki scan is already running' : 'Wiki scan started',
        'success',
      );
    } catch (err: any) {
      if (!isCurrent()) return;
      setError(err?.message || 'Scan failed');
    } finally {
      if (isCurrent()) setStarting(false);
    }
  }, [apiBase, projectId, starting, showToast, start]);

  const dismiss = useCallback(() => setScan(null), []);

  return { starting, scan, error, startScan, dismiss };
}
