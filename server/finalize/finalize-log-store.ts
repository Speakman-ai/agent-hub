/**
 * finalize-log-store.ts — durable, lazy-loaded storage for Finalize CI step
 * output.
 *
 * Background: Finalize step output used to be streamed line-by-line into the
 * session as `messages` rows + `message` WebSocket broadcasts (one per line,
 * capped). That flooded the live session window and bloated message history
 * during a run, and reading one step's logs scanned the ENTIRE session message
 * table. This module replaces that: each step's output is written ONCE, as a
 * single gzipped blob, to a dedicated store keyed by (runId, stepIndex). The
 * step-log viewer fetches that blob on click — nothing lands in the chat
 * stream.
 *
 * Backend: we reuse the artifact-store abstraction (S3 when
 * `config.artifactsBucket` is set, else a local dir under
 * `<dataDir>/artifacts`). Logs live under a `finalize-logs/` key prefix so they
 * are visually separate from per-session artifacts within the same backend.
 * The resolved backend (kind + bucket/region) is persisted on the
 * `finalize_run_steps` row so reads resolve the ORIGINAL backend even after the
 * Hub's storage config changes.
 */
import { gunzipSync, gzipSync } from 'zlib';
import { stripAnsi } from '../ansi-strip.js';
import type { AppConfig } from '../types.js';
import { getArtifactStore, getArtifactStoreForLocation } from '../artifacts/artifact-store.js';
import type { FinalizeStepOutputLine } from './step-output.js';

/**
 * Hard cap on the RAW (pre-gzip) bytes of a single step's output we store.
 * Verbose CI steps (Cypress E2E, webpack/tsc) can emit hundreds of MB; storing
 * a head slice keeps memory + storage bounded while preserving triage context
 * (the failure excerpt + bounded tail are captured independently). Override
 * with `FINALIZE_STEP_MAX_LOG_BYTES`.
 */
export const STEP_MAX_LOG_BYTES = (() => {
  const n = Number.parseInt(process.env.FINALIZE_STEP_MAX_LOG_BYTES ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5_000_000;
})();

/**
 * How many trailing lines a truncated blob keeps (after the head slice) so the
 * viewer shows head + "…truncated…" + the most recent output. These are stored
 * WITH their stream tag (stdout/stderr) — preserved through the accumulator's
 * own ring buffer rather than a stream-less string tail.
 */
export const STEP_TRUNCATED_TAIL_LINES = 40;

const LOG_KEY_PREFIX = 'finalize-logs';

export interface StepLogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface StepLogSnapshot {
  lines: StepLogLine[];
  /** True when output was dropped because it exceeded the byte cap. */
  truncated: boolean;
  /** Total lines the step emitted (NOT the stored count). */
  totalLines: number;
}

/**
 * Bounded accumulator fed one line at a time during a step run. Collects a head
 * slice up to {@link STEP_MAX_LOG_BYTES}; once full it stops growing the head
 * but keeps counting (so `totalLines` stays accurate) and keeps a small ring
 * buffer of the most recent TYPED lines. On a truncated snapshot it composes
 * head + notice + that typed tail, so trailing stderr stays stderr. Memory is
 * O(maxBytes + tailLines) regardless of total output length.
 */
export class StepLogAccumulator {
  private readonly head: StepLogLine[] = [];
  /** Ring buffer of the last `tailLines` lines, WITH their stream tag. */
  private readonly tail: StepLogLine[] = [];
  private bytes = 0;
  private total = 0;
  private full = false;

  constructor(
    private readonly maxBytes: number = STEP_MAX_LOG_BYTES,
    private readonly tailLines: number = STEP_TRUNCATED_TAIL_LINES,
  ) {}

  push(stream: 'stdout' | 'stderr', text: string): void {
    this.total += 1;
    // Always feed the typed tail ring so a truncated snapshot can show the most
    // recent output with stream identity intact.
    this.tail.push({ stream, text });
    if (this.tail.length > this.tailLines) this.tail.shift();
    if (this.full) return;
    const size = Buffer.byteLength(text, 'utf8') + 1; // +1 for the newline
    if (this.bytes + size > this.maxBytes) {
      this.full = true;
      return;
    }
    this.bytes += size;
    this.head.push({ stream, text });
  }

  get lineCount(): number {
    return this.total;
  }

  /**
   * Build the snapshot to persist. When the head slice was truncated, append a
   * one-line notice and the bounded trailing tail (typed) so the viewer shows
   * head + "…truncated…" + the most recent lines rather than a silent cut-off.
   */
  snapshot(): StepLogSnapshot {
    if (!this.full) {
      return { lines: [...this.head], truncated: false, totalLines: this.total };
    }
    const headLen = this.head.length;
    // The tail ring covers lines [total - tail.length, total). The head covers
    // lines [0, headLen). Drop any tail lines that overlap the head so nothing
    // is shown twice (only possible for pathologically small caps).
    const tailStartIndex = this.total - this.tail.length;
    const skip = Math.max(0, headLen - tailStartIndex);
    const tailSlice = this.tail.slice(skip);
    const dropped = this.total - headLen - tailSlice.length;
    const lines = [...this.head];
    lines.push({
      stream: 'stderr',
      text:
        `[output truncated] ${dropped} of ${this.total} lines omitted ` +
        `(step exceeded ${this.maxBytes} bytes of stored output)` +
        (tailSlice.length ? `; last ${tailSlice.length} lines follow` : ''),
    });
    for (const t of tailSlice) lines.push(t);
    return { lines, truncated: true, totalLines: this.total };
  }
}

/**
 * Server-controlled inputs only, so the key can never traverse outside root.
 *
 * `attempt` is a per-execution nonce (the step row's `log_attempt`, a UUID
 * minted when the execution started). Including it means a re-executed
 * (runId, stepIndex) — e.g. a v2 job retried within the same run — writes a
 * DISTINCT blob, so a slow upload from an earlier attempt can never overwrite
 * the newer attempt's output. The attach UPDATE is guarded on the same nonce so
 * a stale attempt also can't reattach its (now-orphaned) key onto the newer
 * row. A UUID (not the ms `ended_at`) avoids same-millisecond collisions.
 */
export function buildFinalizeStepLogKey(runId: string, stepIndex: number, attempt: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${LOG_KEY_PREFIX}/${safe(runId)}/${safe(String(stepIndex))}-${safe(attempt)}.json.gz`;
}

interface StoredLogV1 {
  v: 1;
  truncated: boolean;
  totalLines: number;
  /** Compact tuples: ['o'|'e', text] to keep the blob small. */
  lines: Array<['o' | 'e', string]>;
}

export function encodeStepLog(snap: StepLogSnapshot): Buffer {
  const payload: StoredLogV1 = {
    v: 1,
    truncated: snap.truncated,
    totalLines: snap.totalLines,
    lines: snap.lines.map((l) => [l.stream === 'stderr' ? 'e' : 'o', l.text]),
  };
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
}

export function decodeStepLog(buf: Buffer): FinalizeStepOutputLine[] {
  const parsed = JSON.parse(gunzipSync(buf).toString('utf8')) as StoredLogV1;
  if (!parsed || !Array.isArray(parsed.lines)) return [];
  return parsed.lines.map(([s, t]) => ({
    stream: s === 'e' ? 'stderr' : 'stdout',
    text: stripAnsi(t),
    created_at: '',
  }));
}

/** What gets persisted on the `finalize_run_steps` row after a write. */
export interface StepLogPersist {
  storage_kind: string;
  storage_bucket: string | null;
  storage_region: string | null;
  key: string;
  /** Total lines the step emitted. */
  lines: number;
  truncated: boolean;
}

/** Backend pointer recorded on the row, used to resolve reads. */
export interface StepLogLocation {
  storage_kind: string | null;
  storage_bucket: string | null;
  storage_region: string | null;
  key: string | null;
}

export interface FinalizeStepLogStore {
  /**
   * Upload one step's output blob; returns what to persist on the step row.
   * `attempt` is the step's per-execution nonce (`log_attempt`) — makes the
   * blob key unique per execution (see buildFinalizeStepLogKey).
   */
  write(
    runId: string,
    stepIndex: number,
    snap: StepLogSnapshot,
    attempt: string,
  ): Promise<StepLogPersist>;
  /** Read a step's output back from its recorded backend. Null if absent. */
  read(location: StepLogLocation): Promise<FinalizeStepOutputLine[] | null>;
}

export function createFinalizeStepLogStore(config: AppConfig): FinalizeStepLogStore {
  return {
    async write(runId, stepIndex, snap, attempt): Promise<StepLogPersist> {
      const store = getArtifactStore(config);
      const key = buildFinalizeStepLogKey(runId, stepIndex, attempt);
      await store.put(key, encodeStepLog(snap), 'application/gzip');
      return {
        storage_kind: store.kind,
        storage_bucket: store.kind === 's3' ? (config.artifactsBucket ?? null) : null,
        storage_region: store.kind === 's3' ? (config.artifactsBucketRegion ?? null) : null,
        key,
        lines: snap.totalLines,
        truncated: snap.truncated,
      };
    },
    async read(location): Promise<FinalizeStepOutputLine[] | null> {
      if (!location.key || !location.storage_kind) return null;
      let store;
      try {
        store = getArtifactStoreForLocation(
          {
            storage_kind: location.storage_kind,
            storage_bucket: location.storage_bucket,
            storage_region: location.storage_region,
          },
          config,
        );
      } catch (err) {
        console.warn(
          `[finalize-log-store] cannot resolve backend for key=${location.key}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
      try {
        const buf = await store.getBuffer(location.key);
        return decodeStepLog(buf);
      } catch {
        // Missing object (never written / pruned) → treat as no output.
        return null;
      }
    },
  };
}
