/**
 * Provisioning client — thin wrapper over the /api/projects/provision
 * endpoint + its WebSocket event stream.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Contract (to be implemented by hub-backend):
 *
 *   POST /api/projects/provision
 *     body:  provisioning payload from AdaptiveQuestionnaire.toProvisioningPayload()
 *     auth:  standard JWT / API key
 *     200:   { jobId: string, wsUrl: string }
 *     4xx:   { error: string }
 *
 *   WS <wsUrl>
 *     Server pushes newline-delimited JSON events (one per message frame):
 *       { type:'phase', phase:<id>, status:'started'|'ok'|'failed'|'skipped',
 *         message?:string, at:<ISO> }
 *       { type:'log',   line:<string>, at:<ISO> }
 *       { type:'done',  repoUrl?:<string>, partial?:boolean,
 *         error?:{ code:number, message:string, hint?:string } }
 *     After a 'done' event the server closes the socket.
 *
 * The client helpers here are deliberately minimal — they own transport
 * concerns (fetch, auth headers, socket URL wiring) and hand raw events
 * back to the caller. State reduction happens in provisioningStatus.js.
 * ─────────────────────────────────────────────────────────────────────
 */

import { getApiBase, getAuthHeaders } from './connection.js';

/**
 * Kick off a provisioning job.
 * @param {object} payload — shape from adaptiveQuestionnaire.toProvisioningPayload()
 * @returns {Promise<{ jobId: string, wsUrl: string }>}
 */
export async function provisionProject(payload) {
  const base = getApiBase();
  const res = await fetch(`${base}/projects/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      /* response wasn't JSON */
    }
    throw new Error(detail ? `${res.status}: ${detail}` : `Provisioning failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Subscribe to the event stream for a provisioning job.
 *
 * The server's WebSocket URL (returned from provisionProject) is opened
 * here; events arrive as JSON-per-frame. The returned object exposes
 * `close()` for the caller to tear down on unmount or cancellation.
 *
 * @param {string} wsUrl
 * @param {{ onEvent: (ev) => void, onClose?: () => void, onError?: (err) => void }} handlers
 * @returns {{ close: () => void }}
 */
export function subscribeProvisioningEvents(wsUrl, handlers) {
  const { onEvent, onClose, onError } = handlers || {};
  let closed = false;
  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    onError?.(err);
    return { close: () => {} };
  }
  socket.onmessage = (msg) => {
    if (closed) return;
    try {
      const data = JSON.parse(msg.data);
      onEvent?.(data);
    } catch (err) {
      onError?.(err);
    }
  };
  socket.onclose = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  socket.onerror = (err) => {
    if (closed) return;
    onError?.(err);
  };
  return {
    close: () => {
      closed = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    },
  };
}
