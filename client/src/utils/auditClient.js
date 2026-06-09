/**
 * Audit / roster client — thin wrapper over the backend endpoints that
 * drive Act IV of the New Project storyboard.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Contract (to be implemented by hub-backend — see follow-up card):
 *
 *   GET  /api/projects/:id/audit
 *     auth:  standard JWT / API key
 *     200:   normalized audit report — see utils/auditReport.js
 *              { projectId, generatedAt, score, categories[], findings[], gaps[] }
 *     404:   { error: 'project not found' }
 *     500:   { error: <string> }
 *
 *   POST /api/projects/:id/audit/refresh
 *     body:  {} (reserved for future options — e.g. { categories: ['tests'] })
 *     auth:  standard JWT / API key
 *     202:   { jobId: string }            — async audit dispatched
 *     200:   <audit report>               — sync path returned inline
 *
 *   GET  /api/projects/:id/roster/suggest
 *     auth:  standard JWT / API key
 *     200:   { tracks: [{ id, label, rationale, keywords, suggestedAgentId }] }
 *
 *   POST /api/projects/:id/roster
 *     body:  { tracks: [{ id, label, agentId, custom }] }  — from rosterToPayload()
 *     auth:  standard JWT / API key
 *     200:   { tracks: [...], updatedAt: <ISO> }
 *     400:   { error: 'invalid payload' }
 *
 *   GET  /api/agents
 *     auth:  standard JWT / API key
 *     200:   [{ id, name, role, engine, tags? }]       — existing endpoint
 *
 * The client helpers here are deliberately minimal. State reduction happens
 * in utils/auditReport.js and utils/rosterSuggest.js.
 * ─────────────────────────────────────────────────────────────────────
 */

import { getApiBase, getAuthHeaders } from './connection.js';

async function doFetch(path, options = {}) {
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || body.message || JSON.stringify(body);
    } catch {
      /* non-JSON response */
    }
    throw new Error(detail ? `${res.status}: ${detail}` : `Request failed: ${res.status}`);
  }
  return res.json();
}

/** Fetch the current audit report for a project. Returns the raw server
 *  payload — callers are expected to normalize via `normalizeReport`. */
export async function fetchAuditReport(projectId) {
  if (!projectId) throw new Error('projectId is required');
  return doFetch(`/projects/${encodeURIComponent(projectId)}/audit`);
}

/** Ask the server to regenerate the audit. Returns either the new report
 *  inline (200) or a job id the caller can poll (202). */
export async function refreshAuditReport(projectId, options = {}) {
  if (!projectId) throw new Error('projectId is required');
  return doFetch(`/projects/${encodeURIComponent(projectId)}/audit/refresh`, {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

/** Fetch a suggested roster for a project — server matches tracks against
 *  available agents. Client may supplement with local `suggestRoster`
 *  fallback when this endpoint is unavailable. */
export async function fetchRosterSuggestions(projectId) {
  if (!projectId) throw new Error('projectId is required');
  return doFetch(`/projects/${encodeURIComponent(projectId)}/roster/suggest`);
}

/** Persist the user-chosen roster on the project record. Payload comes
 *  from `rosterToPayload()`. */
export async function saveRoster(projectId, payload) {
  if (!projectId) throw new Error('projectId is required');
  if (!payload || typeof payload !== 'object') throw new Error('payload required');
  return doFetch(`/projects/${encodeURIComponent(projectId)}/roster`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Fetch the full agent list for the current org so the picker can render
 *  "assign" dropdowns. */
export async function fetchAgents() {
  return doFetch('/agents');
}
