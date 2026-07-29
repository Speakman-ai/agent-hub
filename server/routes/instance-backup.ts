/**
 * Instance Backup — multi-select migration export.
 *
 * Lets an Owner-role user pick which slices of the running instance they
 * want to ship to another host (full DB / slim DB / config / workspaces /
 * designs / per-table JSON dumps) and stream them down as a single zip.
 *
 * Read-only: nothing here mutates the live database. Live SQLite copies
 * use better-sqlite3's online `db.backup()` so the running server can
 * keep accepting writes during export.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import archiver from 'archiver';
import path from 'path';
import os from 'os';
import { existsSync, statSync, readdirSync, mkdtempSync, rmSync, createReadStream } from 'fs';
import Database from 'better-sqlite3';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';
import { getDb } from '../db.js';

interface BackupItemDef {
  id: string;
  label: string;
  description: string;
  estimate: () => number;
}

const SLIM_EXCLUDED_TABLES = ['session_events', 'checkpoints'] as const;

function safeStatSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function dirSize(root: string, opts: { excludeNames?: Set<string> } = {}): number {
  if (!existsSync(root)) return 0;
  const exclude = opts.excludeNames ?? new Set<string>();
  let total = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (exclude.has(ent.name)) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        // Skip per-session worktree dirs anywhere in the tree.
        if (/^session-/.test(ent.name)) continue;
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        stack.push(full);
      } else if (ent.isFile()) {
        total += safeStatSize(full);
      }
    }
  }
  return total;
}

function dbstatSum(predicate: (name: string) => boolean): number {
  try {
    const rows = getDb()
      .prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name')
      .all() as Array<{ name: string; bytes: number }>;
    let sum = 0;
    for (const r of rows) {
      if (predicate(r.name)) sum += Number(r.bytes) || 0;
    }
    return sum;
  } catch {
    return 0;
  }
}

function getWorkspacesDir(dataDir: string): string {
  // dataDir is typically ~/.agent-hub/data; workspaces is its sibling.
  return path.join(path.dirname(dataDir), 'workspaces');
}

function buildItems(dataDir: string): BackupItemDef[] {
  const dbPath = path.join(dataDir, 'agent-hub.db');
  const orgsPath = path.join(dataDir, 'orgs.db');
  const configPath = path.join(dataDir, 'config.json');
  const projectsJsonPath = path.join(dataDir, 'projects.json');
  const designsDir = path.join(dataDir, 'designs');
  const workspacesDir = getWorkspacesDir(dataDir);

  return [
    {
      id: 'db.slim',
      label: 'Database — slim',
      description: 'Full SQLite DB minus session_events / checkpoints. Recommended for migration.',
      estimate: () => {
        const excluded = new Set<string>(SLIM_EXCLUDED_TABLES);
        const sum = dbstatSum(
          (n) =>
            !excluded.has(n) &&
            !n.startsWith('idx_session_events') &&
            !n.startsWith('idx_checkpoints'),
        );
        return sum > 0 ? sum : Math.floor(safeStatSize(dbPath) * 0.1);
      },
    },
    {
      id: 'db.full',
      label: 'Database — full',
      description: 'Complete agent-hub.db (online backup, includes raw event stream).',
      estimate: () => safeStatSize(dbPath),
    },
    {
      id: 'db.orgs',
      label: 'Orgs database',
      description: 'orgs.db — auth users, memberships, invites.',
      estimate: () => safeStatSize(orgsPath),
    },
    {
      id: 'config',
      label: 'Config files',
      description: 'data/config.json + projects.json.',
      estimate: () => safeStatSize(configPath) + safeStatSize(projectsJsonPath),
    },
    {
      id: 'workspaces',
      label: 'Agent workspaces',
      description:
        'Context files (AGENTS/SOUL/MEMORY/etc.), skills/, memory/. Skips per-session worktrees.',
      estimate: () => dirSize(workspacesDir),
    },
    {
      id: 'designs',
      label: 'Design Studio artifacts',
      description: 'data/designs/<uuid>/ HTML/CSS/JS files produced by Design Studio sessions.',
      estimate: () => dirSize(designsDir),
    },
    {
      id: 'json.kanban',
      label: 'Kanban (JSON)',
      description: 'Boards, columns, cards, comments, blockers, epics dumped to JSON.',
      estimate: () => dbstatSum((n) => n.startsWith('kanban')),
    },
    {
      id: 'json.wiki',
      label: 'Wiki (JSON)',
      description: 'wiki_pages + wiki_embeddings (FTS shadow tables not included).',
      estimate: () => dbstatSum((n) => n === 'wiki_pages' || n === 'wiki_embeddings'),
    },
    {
      id: 'json.workflows',
      label: 'Workflows (JSON)',
      description: 'workflows / workflow_steps / workflow_runs / workflow_step_runs.',
      estimate: () => dbstatSum((n) => n.startsWith('workflow')),
    },
    {
      id: 'json.notes',
      label: 'Notes (JSON)',
      description: 'Notes inbox (no FTS shadow tables).',
      estimate: () => dbstatSum((n) => n === 'notes'),
    },
    {
      id: 'json.chat',
      label: 'Chat history (JSON)',
      description: 'Sessions + messages — does not include raw streamed events.',
      estimate: () => dbstatSum((n) => n === 'sessions' || n === 'messages'),
    },
  ];
}

const BundleBody = z.object({
  items: z.array(z.string()).min(1),
});

/**
 * Online-backup a SQLite database to a tmp path. Returns the tmp file
 * path. Caller is responsible for unlinking.
 */
async function backupDbTo(srcPath: string, destPath: string): Promise<void> {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    // better-sqlite3 exposes db.backup(filename) → Promise.
    await (src as unknown as { backup: (p: string) => Promise<void> }).backup(destPath);
  } finally {
    src.close();
  }
}

function dumpTablesToObject(srcPath: string, tables: string[]): Record<string, unknown[]> {
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  const out: Record<string, unknown[]> = {};
  try {
    for (const t of tables) {
      try {
        out[t] = db.prepare(`SELECT * FROM "${t}"`).all() as unknown[];
      } catch {
        out[t] = [];
      }
    }
  } finally {
    db.close();
  }
  return out;
}

interface AppendedEntry {
  id: string;
  path: string;
  bytes: number;
}

export default function createInstanceBackupRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get(
    '/api/instance-backup/manifest',
    requireRole('Owner'),
    (_req: Request, res: Response) => {
      const items = buildItems(deps.config.dataDir).map((it) => ({
        id: it.id,
        label: it.label,
        description: it.description,
        estimatedBytes: it.estimate(),
      }));
      res.json({ items });
    },
  );

  router.post(
    '/api/instance-backup/bundle',
    requireRole('Owner'),
    async (req: Request, res: Response) => {
      const parsed = BundleBody.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Body must be { items: string[] } with at least 1 id.' });
      }

      const dataDir = deps.config.dataDir;
      const allItems = buildItems(dataDir);
      const known = new Set(allItems.map((i) => i.id));
      const unknown = parsed.data.items.filter((id) => !known.has(id));
      if (unknown.length) {
        return res.status(400).json({ error: `Unknown item id(s): ${unknown.join(', ')}` });
      }

      const requested = new Set(parsed.data.items);
      const warnings: string[] = [];

      // db.full and db.slim are mutually exclusive — prefer full when both selected.
      if (requested.has('db.full') && requested.has('db.slim')) {
        requested.delete('db.slim');
        warnings.push('db.full and db.slim both selected — using db.full and dropping db.slim.');
      }

      const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-backup-'));
      const tmpFiles: string[] = [];
      const appended: AppendedEntry[] = [];

      const cleanup = () => {
        try {
          rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        tmpFiles.length = 0;
      };

      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace(/-\d{3}Z$/, 'Z');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="agent-hub-backup-${stamp}.zip"`);
      res.setHeader('Cache-Control', 'no-store');

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('warning', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Surface unexpected warnings via the response error handler.
          archive.emit('error', err);
        }
      });
      archive.on('error', (err) => {
        cleanup();
        if (!res.headersSent) {
          res.status(500).json({ error: `Backup failed: ${err.message}` });
        } else {
          res.destroy(err);
        }
      });
      res.on('close', () => {
        cleanup();
      });
      archive.pipe(res);

      const dbPath = path.join(dataDir, 'agent-hub.db');
      const orgsPath = path.join(dataDir, 'orgs.db');
      const configPath = path.join(dataDir, 'config.json');
      const projectsJsonPath = path.join(dataDir, 'projects.json');
      const designsDir = path.join(dataDir, 'designs');
      const workspacesDir = getWorkspacesDir(dataDir);

      try {
        // ── DB: full ──────────────────────────────────────────────
        if (requested.has('db.full')) {
          const tmp = path.join(tmpRoot, 'agent-hub.db');
          tmpFiles.push(tmp);
          await backupDbTo(dbPath, tmp);
          archive.file(tmp, { name: 'db/agent-hub.db' });
          appended.push({ id: 'db.full', path: 'db/agent-hub.db', bytes: safeStatSize(tmp) });
        }

        // ── DB: slim ──────────────────────────────────────────────
        if (requested.has('db.slim')) {
          const tmp = path.join(tmpRoot, 'agent-hub-slim.db');
          tmpFiles.push(tmp);
          await backupDbTo(dbPath, tmp);
          // Strip heavy tables from the copy, then VACUUM.
          const copy = new Database(tmp);
          try {
            copy.exec('BEGIN');
            for (const t of SLIM_EXCLUDED_TABLES) {
              try {
                copy.exec(`DELETE FROM "${t}"`);
              } catch {
                /* table may not exist on older schemas */
              }
            }
            copy.exec('COMMIT');
            try {
              copy.pragma('wal_checkpoint(TRUNCATE)');
            } catch {
              /* noop */
            }
            copy.exec('VACUUM');
          } finally {
            copy.close();
          }
          archive.file(tmp, { name: 'db/agent-hub.db' });
          appended.push({ id: 'db.slim', path: 'db/agent-hub.db', bytes: safeStatSize(tmp) });
        }

        // ── DB: orgs ──────────────────────────────────────────────
        if (requested.has('db.orgs') && existsSync(orgsPath)) {
          const tmp = path.join(tmpRoot, 'orgs.db');
          tmpFiles.push(tmp);
          await backupDbTo(orgsPath, tmp);
          archive.file(tmp, { name: 'db/orgs.db' });
          appended.push({ id: 'db.orgs', path: 'db/orgs.db', bytes: safeStatSize(tmp) });
        }

        // ── Config files ──────────────────────────────────────────
        if (requested.has('config')) {
          if (existsSync(configPath)) {
            archive.file(configPath, { name: 'config/config.json' });
            appended.push({
              id: 'config',
              path: 'config/config.json',
              bytes: safeStatSize(configPath),
            });
          }
          if (existsSync(projectsJsonPath)) {
            archive.file(projectsJsonPath, { name: 'config/projects.json' });
            appended.push({
              id: 'config',
              path: 'config/projects.json',
              bytes: safeStatSize(projectsJsonPath),
            });
          }
        }

        // ── Workspaces ────────────────────────────────────────────
        if (requested.has('workspaces') && existsSync(workspacesDir)) {
          // Walk manually so we can skip session-* dirs and .git/node_modules.
          const entries = readdirSync(workspacesDir, { withFileTypes: true });
          for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const projDir = path.join(workspacesDir, ent.name);
            // glob: include everything except session-* / .git / node_modules anywhere.
            archive.glob(
              '**/*',
              {
                cwd: projDir,
                dot: false,
                ignore: ['**/session-*/**', '**/.git/**', '**/node_modules/**', 'session-*'],
              },
              { prefix: `workspaces/${ent.name}` },
            );
          }
          appended.push({
            id: 'workspaces',
            path: 'workspaces/',
            bytes: dirSize(workspacesDir),
          });
        }

        // ── Designs ───────────────────────────────────────────────
        if (requested.has('designs') && existsSync(designsDir)) {
          archive.directory(designsDir, 'designs');
          appended.push({ id: 'designs', path: 'designs/', bytes: dirSize(designsDir) });
        }

        // ── JSON dumps ────────────────────────────────────────────
        const jsonGroups: Array<{ id: string; tables: string[]; out: string }> = [
          {
            id: 'json.kanban',
            tables: [
              'kanban_boards',
              'kanban_columns',
              'kanban_cards',
              'kanban_card_comments',
              'kanban_card_blockers',
              'kanban_epics',
            ],
            out: 'json/kanban.json',
          },
          {
            id: 'json.wiki',
            tables: ['wiki_pages', 'wiki_embeddings'],
            out: 'json/wiki.json',
          },
          {
            id: 'json.workflows',
            tables: ['workflows', 'workflow_steps', 'workflow_runs', 'workflow_step_runs'],
            out: 'json/workflows.json',
          },
          {
            id: 'json.notes',
            tables: ['notes'],
            out: 'json/notes.json',
          },
          {
            id: 'json.chat',
            tables: ['sessions', 'messages'],
            out: 'json/chat.json',
          },
        ];
        for (const group of jsonGroups) {
          if (!requested.has(group.id)) continue;
          const dump = dumpTablesToObject(dbPath, group.tables);
          const buf = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
          archive.append(buf, { name: group.out });
          appended.push({ id: group.id, path: group.out, bytes: buf.length });
        }

        // ── Manifest ──────────────────────────────────────────────
        let pkgVersion = 'unknown';
        try {
          const pkgJson = path.join(deps.serverDir, 'package.json');
          if (existsSync(pkgJson)) {
            const { readFileSync } = await import('fs');
            pkgVersion =
              (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version ??
              'unknown';
          }
        } catch {
          /* leave default */
        }
        const manifest = {
          generatedAt: new Date().toISOString(),
          hostname: os.hostname(),
          version: pkgVersion,
          requestedItems: parsed.data.items,
          items: appended,
          warnings: warnings.length ? warnings : undefined,
        };
        archive.append(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), {
          name: 'BACKUP-MANIFEST.json',
        });

        await archive.finalize();
      } catch (err) {
        cleanup();
        if (!res.headersSent) {
          return res.status(500).json({ error: `Backup failed: ${(err as Error).message}` });
        }
        try {
          archive.abort();
        } catch {
          /* noop */
        }
        res.destroy(err as Error);
      }
      // Avoid implicit-any return typing; explicitly return void.
      return undefined;
    },
  );

  return router;
}

// Re-export helpers for tests.
export const __test = {
  buildItems,
  SLIM_EXCLUDED_TABLES,
  // Avoid unused-import noise
  _ignored: createReadStream,
};
