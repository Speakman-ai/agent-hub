#!/usr/bin/env tsx
/**
 * scripts/preview-snapshot.ts — CLI tool for creating preview DB snapshots.
 *
 * Usage:
 *   npx tsx scripts/preview-snapshot.ts snapshot [--dest <dir>] [--filename <name>]
 *   npx tsx scripts/preview-snapshot.ts seed     [--dest <dir>] [--filename <name>]
 *   npx tsx scripts/preview-snapshot.ts list     [--dest <dir>]
 *   npx tsx scripts/preview-snapshot.ts clean    [--dest <dir>]
 *
 * Environment:
 *   AGENT_HUB_DATA_DIR  — Source data directory (default: ~/.agent-hub/data)
 *
 * Examples:
 *   # Snapshot the live DB for a preview deployment
 *   npx tsx scripts/preview-snapshot.ts snapshot
 *
 *   # Create a fresh seed for CI
 *   npx tsx scripts/preview-snapshot.ts seed --filename ci-preview.db
 *
 *   # Mount into docker-compose.preview.yml:
 *   #   volumes:
 *   #     - ./snapshots/ci-preview.db:/data/agent-hub.db:ro
 */

import { parseArgs } from 'util';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import {
  createSnapshot,
  createSeedDb,
  listSnapshots,
  deleteSnapshot,
  getSnapshotDir,
} from '../server/preview-db.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dest: { type: 'string', short: 'd' },
    filename: { type: 'string', short: 'f' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];

if (values.help || !command) {
  console.log(`
Usage: npx tsx scripts/preview-snapshot.ts <command> [options]

Commands:
  snapshot   Create a snapshot of the live database
  seed       Create a fresh seeded database
  list       List all snapshots
  clean      Delete all snapshots

Options:
  --dest, -d <dir>       Destination directory (default: <dataDir>/snapshots)
  --filename, -f <name>  Output filename
  --help, -h             Show this help
`);
  process.exit(0);
}

const dataDir = process.env.AGENT_HUB_DATA_DIR || path.join(os.homedir(), '.agent-hub', 'data');
const destDir = (values.dest as string) || getSnapshotDir(dataDir);

async function main(): Promise<void> {
  switch (command) {
    case 'snapshot': {
      const dbPath = path.join(dataDir, 'agent-hub.db');
      console.log(`[preview] Opening source DB: ${dbPath}`);
      const db = new Database(dbPath, { readonly: true });
      db.pragma('journal_mode = WAL');

      try {
        console.log(`[preview] Creating snapshot in: ${destDir}`);
        const result = await createSnapshot(db, {
          destDir,
          filename: values.filename as string | undefined,
        });
        console.log(`[preview] Snapshot created:`);
        console.log(`  File:   ${result.path}`);
        console.log(`  Size:   ${(result.sizeBytes / 1024).toFixed(1)} KB`);
        console.log(`  Tables: ${result.tables.join(', ')}`);
      } finally {
        db.close();
      }
      break;
    }

    case 'seed': {
      console.log(`[preview] Creating seed DB in: ${destDir}`);
      const result = createSeedDb({
        destDir,
        filename: values.filename as string | undefined,
      });
      console.log(`[preview] Seed DB created:`);
      console.log(`  File:   ${result.path}`);
      console.log(`  Size:   ${(result.sizeBytes / 1024).toFixed(1)} KB`);
      console.log(`  Tables: ${result.tables.join(', ')}`);
      break;
    }

    case 'list': {
      const snapshots = listSnapshots(destDir);
      if (snapshots.length === 0) {
        console.log('[preview] No snapshots found.');
        break;
      }
      console.log(`[preview] ${snapshots.length} snapshot(s) in ${destDir}:\n`);
      for (const s of snapshots) {
        const size = (s.sizeBytes / 1024).toFixed(1);
        console.log(`  ${path.basename(s.path)}  ${s.mode}  ${size} KB  ${s.createdAt}`);
      }
      break;
    }

    case 'clean': {
      const snapshots = listSnapshots(destDir);
      if (snapshots.length === 0) {
        console.log('[preview] No snapshots to clean.');
        break;
      }
      let deleted = 0;
      for (const s of snapshots) {
        if (deleteSnapshot(s.path)) deleted++;
      }
      console.log(`[preview] Deleted ${deleted} snapshot(s).`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[preview] Fatal error:', err);
  process.exit(1);
});
