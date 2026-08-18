/**
 * Workflow-project client — thin wrapper over `POST /api/projects` for the
 * non-code path of the New Project wizard.
 *
 * A "workflow" project is one without a code repo / scaffolding step:
 * pure kanban + wiki + agents + sessions + crons. Server-side
 * this is just `POST /api/projects` with `mode: 'workflow'` (and no
 * `githubRepo`). Validated by `server/test/api.test.ts` →
 * "creates a tasks-only project (mode=workflow, no githubRepo)".
 *
 * The wizard owns the user-facing `name` + optional `description` /
 * `color`. We derive a deterministic project id from the name (alnum +
 * hyphens, lowercased) and let the server reject duplicates with a 409 so
 * the form can prompt the user to rename.
 */

import { getApiBase, getAuthHeaders } from './connection';

/** Slugify a free-text name into a valid project id (alnum + hyphens). */
export function slugifyProjectId(raw: any) {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * POST /api/projects with `mode: 'workflow'`.
 *
 * @param {{ name: string, id?: string, description?: string, color?: string, cwd?: string, visibility?: 'shared' | 'private' }} input
 * @returns {Promise<object>} the created project row
 *
 * Throws an Error with `.status` set when the server rejects the request
 * so the form can branch on 409 (duplicate id) vs other failures.
 */
export async function createWorkflowProject(input: any) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) {
    const err = new Error('name is required');
    (err as any).status = 400;
    throw err;
  }
  const id = (input && typeof input.id === 'string' && input.id.trim()) || slugifyProjectId(name);
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
    const err = new Error(
      'name must yield a valid id (letters, digits, hyphens) — try a simpler name',
    );
    (err as any).status = 400;
    throw err;
  }

  // `cwd` is unused in workflow mode: the server ignores whatever we send
  // and points a workflow project's cwd at its own managed, durable
  // resource dir (`<projectsDir>/<id>/workspace`). We still send `/tmp` so
  // the body shape is unchanged and the user isn't asked for a path that
  // has no observable effect.
  const body: Record<string, any> = {
    id,
    name,
    cwd: input?.cwd || '/tmp',
    mode: 'workflow',
  };
  if (input?.color) body.color = input.color;
  // Visibility is optional — server defaults to 'shared' if omitted.
  // Only forward an explicit 'private' (or 'shared' for clarity) so a
  // wizard that doesn't expose the toggle yet inherits the safe default.
  if (input?.visibility === 'private' || input?.visibility === 'shared') {
    body.visibility = input.visibility;
  }

  const res = await fetch(`${getApiBase()}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data?.error || data?.message || '';
    } catch {
      /* response was not JSON */
    }
    const err = new Error(
      detail ? `${res.status}: ${detail}` : `Failed to create project (${res.status})`,
    );
    (err as any).status = res.status;
    throw err;
  }

  return res.json();
}
