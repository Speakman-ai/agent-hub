// Bug report capture + submission helpers.
//
// The endpoint is intentionally hard-coded to the production Agent Hub — bug
// reports must always flow to the central intake regardless of where the
// client runs.

export const BUG_REPORT_ENDPOINT = 'https://agenthub.surveytracker.io/api/bug-reports';
export const BUG_REPORT_PROJECT_ID = 'agent-hub';

/**
 * Convert a data URL (e.g. "data:image/png;base64,...") into a Blob.
 */
function dataUrlToBlob(dataUrl: any) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!match) {
    throw new Error('Invalid data URL');
  }
  const mime = match[1] || 'image/png';
  const binary = atob(match[2]);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Capture a PNG screenshot of the current view.
 *
 * Prefers the Electron bridge (`window.electronAPI.captureBugScreenshot`) when
 * available; otherwise falls back to dynamically importing html2canvas and
 * snapshotting `document.body`.
 *
 * @returns {Promise<Blob>} PNG blob
 */
export async function captureScreenshot() {
  if (typeof window !== 'undefined' && window.electronAPI?.captureBugScreenshot) {
    const dataUrl = await window.electronAPI.captureBugScreenshot();
    return dataUrlToBlob(dataUrl);
  }

  const mod = await import('html2canvas');
  const html2canvas = mod.default || mod;
  const canvas = await html2canvas(document.body, {
    backgroundColor: '#0b0f17',
    useCORS: true,
    logging: false,
    // Keep the capture at device pixel ratio but cap to avoid giant uploads.
    scale: Math.min(window.devicePixelRatio || 1, 2),
  });

  return new Promise((resolve: any, reject: any) => {
    canvas.toBlob((blob: any) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to produce screenshot blob'));
    }, 'image/png');
  });
}

/**
 * Detect whether we're running inside the Electron shell.
 */
function detectClientType() {
  if (typeof window !== 'undefined' && window.electronAPI?.captureBugScreenshot) {
    return 'electron';
  }
  return 'web';
}

/**
 * Submit a bug report to the central intake endpoint.
 *
 * Builds a multipart FormData payload and POSTs it with `mode: 'cors'` so it
 * can be sent from any origin (dev, prod, Electron). Resolves with the parsed
 * JSON body on success (HTTP 2xx); rejects with an Error whose message is the
 * response body on non-2xx responses.
 *
 * NOTE: `currentProjectId` on the wire is intentionally fixed to
 * `BUG_REPORT_PROJECT_ID`. A `projectId` arg is accepted-and-ignored for
 * backward compatibility with existing call sites; do not rely on it.
 */
export async function submitBugReport({
  title,
  description,
  severity,
  screenshotBlob,
  screenshotMissReason,

  projectId: _projectId,
  agentId,
  replayRef,
  replayMissReason,
}: any) {
  if (!title || !String(title).trim()) {
    throw new Error('Title is required');
  }

  const form = new FormData();
  form.append('title', String(title).trim().slice(0, 200));
  form.append('description', description ? String(description) : '');
  form.append('severity', severity || 'medium');

  if (screenshotBlob) {
    form.append('screenshot', screenshotBlob, 'screenshot.png');
  } else if (screenshotMissReason) {
    form.append('screenshotMissReason', String(screenshotMissReason));
  }

  form.append(
    'sourceUrl',
    typeof window !== 'undefined' && window.location ? window.location.href : '',
  );
  form.append('userAgent', typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
  form.append('appVersion', import.meta.env?.VITE_APP_VERSION ?? '');
  form.append('clientType', detectClientType());

  form.append('currentProjectId', BUG_REPORT_PROJECT_ID);
  if (agentId) form.append('currentAgentId', String(agentId));
  if (replayRef) form.append('replayRef', String(replayRef));
  // Only meaningful when no replay attached — names why the capture was missing
  // so the intake agent / operator can diagnose a "didn't capture replay" report.
  else if (replayMissReason) form.append('replayMissReason', String(replayMissReason));

  const res = await fetch(BUG_REPORT_ENDPOINT, {
    method: 'POST',
    mode: 'cors',
    body: form,
  });

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // ignore
    }
    throw new Error(bodyText || `Bug report failed (HTTP ${res.status})`);
  }

  try {
    return await res.json();
  } catch {
    // Server responded 2xx but body wasn't JSON — treat as success anyway.
    return { status: 'dispatched' };
  }
}
