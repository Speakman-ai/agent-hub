import { getApiBase, getAuthHeaders } from './connection';

// The artifact content endpoint is session-scoped and auth-gated, so a plain
// <a href> / window.open can't carry the bearer token. We fetch the bytes with
// auth headers, wrap them in a blob object URL, and hand that to the browser.

export async function fetchArtifactBlob(
  sessionId: any,
  artifactId: any,
  { download = false }: any = {},
) {
  const base = getApiBase();
  const qs = download ? '?download=1' : '';
  const res = await fetch(`${base}/sessions/${sessionId}/artifacts/${artifactId}/content${qs}`, {
    headers: { ...getAuthHeaders() },
  });
  if (!res.ok) throw new Error(`Failed to fetch artifact (${res.status})`);
  return res.blob();
}

/** Trigger a browser download of an artifact under its original filename. */
export async function downloadArtifact(sessionId: any, artifactId: any, filename: any) {
  const blob = await fetchArtifactBlob(sessionId, artifactId, { download: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'artifact';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
