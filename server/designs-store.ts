/**
 * Designs store — Claude-Design-style canvas.
 *
 * Phase 1 MVP. Designs are hub-level (not project-scoped) with optional links
 * to N projects. Each design has an on-disk artifact directory at
 * `<designsRoot>/<designId>/` that doubles as (a) the cwd for the spawned
 * Claude Code CLI process and (b) the source for an `express.static` mount
 * rendered in an iframe.
 *
 * This module owns both the DB rows (designs, design_projects, design_messages)
 * and the filesystem artifact dir lifecycle. Routes + the chat handler call
 * into these helpers.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getStmts } from './db.js';
import type {
  DesignRow,
  DesignProjectRow,
  DesignMessageRow,
  DesignWithProjects,
  Project,
} from './types.js';

const SEED_INDEX_HTML = '<!doctype html><html><body></body></html>';

/** Absolute path to a design's artifact directory. */
export function designDir(designsRoot: string, designId: string): string {
  return path.join(designsRoot, designId);
}

/** Ensure the top-level designs root exists. Safe to call repeatedly. */
export function ensureDesignsRoot(designsRoot: string): void {
  mkdirSync(designsRoot, { recursive: true });
}

/**
 * Create a new design row, link any projects, and seed the artifact dir
 * with a blank `index.html`. Returns the full design with linked projects.
 */
export function createDesign(
  name: string,
  linkedProjectIds: string[],
  designsRoot: string,
  lookupProject: (id: string) => Project | null,
  orgId: string = 'default',
): DesignWithProjects {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Design name is required');
  }
  const stmts = getStmts();
  const id = uuidv4();
  stmts.createDesign.run(id, name.trim(), orgId);
  for (const projectId of linkedProjectIds) {
    stmts.linkDesignProject.run(id, projectId);
  }

  // Seed artifact directory.
  const dir = designDir(designsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), SEED_INDEX_HTML, 'utf-8');

  return getDesign(id, lookupProject)!;
}

/**
 * List all designs ordered by updated_at DESC, each with its linked
 * projects resolved via the supplied lookup.
 */
export function listDesigns(
  lookupProject: (id: string) => Project | null,
  orgId: string = 'default',
): DesignWithProjects[] {
  const stmts = getStmts();
  const rows = stmts.listDesigns.all(orgId) as DesignRow[];
  return rows.map((row) => hydrate(row, lookupProject));
}

/**
 * Fetch a single design with its linked projects, or null if it doesn't exist.
 * When `orgId` is provided the row must belong to that org — otherwise null is
 * returned, preventing cross-org access by design ID.
 */
export function getDesign(
  id: string,
  lookupProject: (id: string) => Project | null,
  orgId?: string,
): DesignWithProjects | null {
  const stmts = getStmts();
  const row = stmts.getDesign.get(id) as DesignRow | undefined;
  if (!row) return null;
  if (orgId && row.org_id !== orgId) return null;
  return hydrate(row, lookupProject);
}

/**
 * Rename a design. No-op if the row is missing (caller should 404 first).
 */
export function renameDesign(id: string, name: string): void {
  if (!name || !name.trim()) throw new Error('Design name is required');
  getStmts().updateDesignName.run(name.trim(), id);
}

/**
 * Persist which `--model` Design Studio uses for this design (engine-specific).
 * Pass `null` to clear and follow the hub default for the active engine.
 */
export function setDesignAgentModel(designId: string, agentModel: string | null): void {
  getStmts().updateDesignAgentModel.run(agentModel, designId);
}

/** Atomically update engine, model, and engine resume id (used by PATCH /api/designs/:id). */
export function patchDesignChatEngineModelSession(
  designId: string,
  agent_engine: string | null,
  agent_model: string | null,
  engine_session_id: string | null,
): void {
  getStmts().updateDesignChatEngineModelSession.run(
    agent_engine,
    agent_model,
    engine_session_id,
    designId,
  );
}

/**
 * Replace the set of linked projects for a design. Used by `PATCH` handlers
 * that let the caller pass a fresh `linkedProjectIds` array.
 */
export function setLinkedProjects(designId: string, linkedProjectIds: string[]): void {
  const stmts = getStmts();
  stmts.clearDesignProjects.run(designId);
  for (const projectId of linkedProjectIds) {
    stmts.linkDesignProject.run(designId, projectId);
  }
}

/**
 * Add a single project link. Idempotent (INSERT OR IGNORE under the hood).
 */
export function linkProject(designId: string, projectId: string): void {
  getStmts().linkDesignProject.run(designId, projectId);
}

/** Remove a single project link. No-op if absent. */
export function unlinkProject(designId: string, projectId: string): void {
  getStmts().unlinkDesignProject.run(designId, projectId);
}

/**
 * Delete a design. Cascades to design_projects + design_messages via FK,
 * then removes the artifact directory from disk (best-effort — tolerates
 * already-missing dirs).
 */
export function deleteDesign(id: string, designsRoot: string): void {
  getStmts().deleteDesign.run(id);
  const dir = designDir(designsRoot, id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Insert a user/assistant/system message for a design. Touches updated_at. */
export function appendDesignMessage(
  designId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): DesignMessageRow {
  const stmts = getStmts();
  const id = uuidv4();
  stmts.appendDesignMessage.run(id, designId, role, content);
  stmts.touchDesign.run(designId);
  return {
    id,
    design_id: designId,
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

/** List all messages for a design in chronological order. */
export function listDesignMessages(designId: string): DesignMessageRow[] {
  return getStmts().listDesignMessages.all(designId) as DesignMessageRow[];
}

/** List the files in a design's artifact directory (non-recursive). */
export function listDesignFiles(designsRoot: string, designId: string): string[] {
  const dir = designDir(designsRoot, designId);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export interface DesignFileEntry {
  /** Forward-slash path relative to the design's artifact dir (never starts with '/'). */
  path: string;
  size: number;
  /** Modification time as ISO8601. */
  mtime: string;
}

/**
 * Recursive listing of every regular file under the design's artifact dir.
 *
 * Used by `GET /api/designs/:id/files` so agents (not just browsers) can
 * discover what a design has produced — HTML/CSS/JS plus anything under
 * `assets/`. Returns a flat array of `{path, size, mtime}` entries with
 * forward-slash paths relative to the artifact root. Symlinks and special
 * files are ignored; directories are walked but not emitted themselves.
 */
export function listDesignFilesRecursive(designsRoot: string, designId: string): DesignFileEntry[] {
  const root = designDir(designsRoot, designId);
  if (!existsSync(root)) return [];
  const out: DesignFileEntry[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st: ReturnType<typeof statSync>;
      try {
        // lstat-equivalent via statSync + isSymbolicLink check; we use statSync
        // and skip non-regular entries below. A symlink pointing outside the
        // artifact root would still be filesystem-served, so the path-traversal
        // guard on `/design-files/:id/*` is the real safety net; here we just
        // avoid exposing weird entries in the listing.
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(childAbs, childRel);
      } else if (st.isFile()) {
        out.push({
          path: childRel,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      }
    }
  };
  walk(root, '');
  return out;
}

// ─── Internal ───────────────────────────────────────────────────────

function hydrate(row: DesignRow, lookup: (id: string) => Project | null): DesignWithProjects {
  const links = getStmts().listDesignProjects.all(row.id) as DesignProjectRow[];
  const linkedProjects = links
    .map((l) => lookup(l.project_id))
    .filter((p): p is Project => p !== null);
  return { ...row, linkedProjects };
}
