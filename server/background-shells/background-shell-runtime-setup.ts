/**
 * Production wiring for {@link BackgroundShellRuntime}.
 *
 * Builds a disk-backed log sink under `<dataDir>/background-shells/` and
 * constructs the runtime with the real `child_process.spawn`. Mirrors
 * `preview-runtime-setup.ts`; kept separate from the runtime class so the
 * class stays IO-free and unit-testable with injected fakes.
 */
import type { Database } from 'better-sqlite3';
import { spawn as childSpawn } from 'child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'fs';
import path from 'path';
import {
  BackgroundShellRuntime,
  type BackgroundShellBroadcast,
  type BackgroundShellLogSink,
  type BackgroundShellRuntimeConfig,
} from './background-shell-runtime.js';

const DEFAULT_LOG_TAIL_LINES = 500;
const LOG_TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_LOG_TAIL_BYTES = 1024 * 1024;

/** Read only a bounded suffix of a persisted shell log. */
export function readTailLines(logPath: string, limit?: number): string[] {
  const maxLines = limit == null ? DEFAULT_LOG_TAIL_LINES : Math.max(0, Math.floor(limit));
  if (maxLines === 0) return [];

  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    fd = openSync(logPath, 'r');
    let position = size;
    let bytesRead = 0;
    let contents = '';
    let newlineCount = 0;

    while (position > 0 && bytesRead < MAX_LOG_TAIL_BYTES && newlineCount <= maxLines) {
      const chunkSize = Math.min(LOG_TAIL_CHUNK_BYTES, position, MAX_LOG_TAIL_BYTES - bytesRead);
      position -= chunkSize;
      const chunk = Buffer.allocUnsafe(chunkSize);
      const count = readSync(fd, chunk, 0, chunkSize, position);
      if (count === 0) break;
      bytesRead += count;
      const text = chunk.subarray(0, count).toString('utf8');
      contents = text + contents;
      newlineCount += (text.match(/\n/g) ?? []).length;
    }

    const lines = contents.split('\n').filter((line) => line.length > 0);
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface CreateBackgroundShellRuntimeDeps {
  db: Database;
  dataDir: string;
  broadcast?: BackgroundShellBroadcast;
  config?: BackgroundShellRuntimeConfig;
}

export function createBackgroundShellRuntime(
  deps: CreateBackgroundShellRuntimeDeps,
): BackgroundShellRuntime {
  const logsDir = path.join(deps.dataDir, 'background-shells');
  mkdirSync(logsDir, { recursive: true });

  const logSink: BackgroundShellLogSink = {
    open(shellId: string) {
      const safe = shellId.replace(/[^A-Za-z0-9_-]/g, '_');
      const logPath = path.join(logsDir, `${safe}.log`);
      // Touch so `log_path` points at a real (possibly empty) file even
      // before the first chunk. Best-effort — real errors surface on append.
      try {
        const fd = openSync(logPath, 'a');
        closeSync(fd);
      } catch {
        /* swallow — appendFileSync below surfaces real errors */
      }
      return {
        path: logPath,
        append(chunk: string) {
          try {
            appendFileSync(logPath, chunk);
          } catch (err) {
            console.warn(
              `[bg-shell-log] append failed (${logPath}):`,
              err instanceof Error ? err.message : String(err),
            );
          }
        },
      };
    },
    read(logPath: string, limit?: number) {
      return readTailLines(logPath, limit);
    },
  };

  return new BackgroundShellRuntime({
    db: deps.db,
    spawn: childSpawn,
    logSink,
    broadcast: deps.broadcast,
    config: deps.config,
  });
}
