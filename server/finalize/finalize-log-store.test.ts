import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../types.js';
import { resetArtifactStoreCache } from '../artifacts/artifact-store.js';
import {
  StepLogAccumulator,
  buildFinalizeStepLogKey,
  createFinalizeStepLogStore,
  decodeStepLog,
  encodeStepLog,
} from './finalize-log-store.js';

describe('StepLogAccumulator', () => {
  it('collects all lines under the byte cap and reports totalLines', () => {
    const acc = new StepLogAccumulator(10_000);
    acc.push('stdout', 'hello');
    acc.push('stderr', 'boom');
    const snap = acc.snapshot();
    expect(snap.truncated).toBe(false);
    expect(snap.totalLines).toBe(2);
    expect(snap.lines).toEqual([
      { stream: 'stdout', text: 'hello' },
      { stream: 'stderr', text: 'boom' },
    ]);
  });

  it('truncates past the byte cap but keeps counting every line', () => {
    const acc = new StepLogAccumulator(20); // tiny cap
    acc.push('stdout', 'aaaaaaaaaa'); // 10 + 1 = 11 bytes → stored in head
    acc.push('stdout', 'bbbbbbbbbb'); // would exceed 20 → drops from head, marks full
    acc.push('stdout', 'cccccccccc'); // still counted, only in the tail ring
    const snap = acc.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.totalLines).toBe(3);
    // head line + truncation notice + trailing tail
    expect(snap.lines[0]).toEqual({ stream: 'stdout', text: 'aaaaaaaaaa' });
    expect(snap.lines[1].stream).toBe('stderr');
    expect(snap.lines[1].text).toContain('[output truncated]');
    expect(snap.lines.at(-1)).toEqual({ stream: 'stdout', text: 'cccccccccc' });
  });

  it('preserves stream identity (stdout/stderr) for the trailing tail of a truncated blob', () => {
    const acc = new StepLogAccumulator(8, 3); // tiny byte cap, 3-line tail ring
    acc.push('stdout', 'head'); // 4 + 1 = 5 bytes → stored in head
    acc.push('stderr', 'err-1'); // exceeds 8 → marks full; tail only
    acc.push('stderr', 'err-2'); // tail only
    acc.push('stdout', 'out-3'); // tail only
    const snap = acc.snapshot();
    expect(snap.truncated).toBe(true);
    // The appended trailing tail keeps each line's ORIGINAL stream — a failing
    // step whose last relevant lines were stderr must not be rendered as stdout.
    const tail = snap.lines.slice(2); // after head + notice
    expect(tail).toEqual([
      { stream: 'stderr', text: 'err-1' },
      { stream: 'stderr', text: 'err-2' },
      { stream: 'stdout', text: 'out-3' },
    ]);
  });
});

describe('encode/decode step log', () => {
  it('round-trips lines and strips ANSI on decode', () => {
    const buf = encodeStepLog({
      truncated: false,
      totalLines: 2,
      lines: [
        { stream: 'stdout', text: '[32mok[0m' },
        { stream: 'stderr', text: 'fail' },
      ],
    });
    const lines = decodeStepLog(buf);
    expect(lines).toEqual([
      { stream: 'stdout', text: 'ok', created_at: '' },
      { stream: 'stderr', text: 'fail', created_at: '' },
    ]);
  });

  it('gzips to a compact blob', () => {
    const big = Array.from({ length: 1000 }, () => 'repeated log line').map((t) => ({
      stream: 'stdout' as const,
      text: t,
    }));
    const buf = encodeStepLog({ truncated: false, totalLines: 1000, lines: big });
    // Highly repetitive → compresses far below the raw size.
    expect(buf.length).toBeLessThan(1000);
  });
});

describe('buildFinalizeStepLogKey', () => {
  it('namespaces under finalize-logs, includes the attempt nonce, and sanitises traversal chars', () => {
    expect(buildFinalizeStepLogKey('run-1', 3, 'att-a')).toBe(
      'finalize-logs/run-1/3-att-a.json.gz',
    );
    expect(buildFinalizeStepLogKey('../evil', 1, 'n/x')).toBe(
      'finalize-logs/.._evil/1-n_x.json.gz',
    );
  });

  it('produces distinct keys for re-executions of the same step (different attempt nonce)', () => {
    expect(buildFinalizeStepLogKey('run-1', 3, 'att-a')).not.toBe(
      buildFinalizeStepLogKey('run-1', 3, 'att-b'),
    );
  });
});

describe('createFinalizeStepLogStore (local backend round-trip)', () => {
  it('writes a blob and reads it back via the recorded location', async () => {
    resetArtifactStoreCache();
    const config = {
      dataDir: `/tmp/agent-hub-test-${process.pid}-${process.hrtime.bigint()}`,
      artifactsBucket: null,
      artifactsBucketRegion: null,
    } as unknown as AppConfig;
    const store = createFinalizeStepLogStore(config);

    const persisted = await store.write(
      'run-xyz',
      2,
      {
        truncated: false,
        totalLines: 1,
        lines: [{ stream: 'stdout', text: 'built ok' }],
      },
      'nonce-1',
    );
    expect(persisted.storage_kind).toBe('local');
    expect(persisted.key).toBe('finalize-logs/run-xyz/2-nonce-1.json.gz');
    expect(persisted.lines).toBe(1);

    const lines = await store.read({
      storage_kind: persisted.storage_kind,
      storage_bucket: persisted.storage_bucket,
      storage_region: persisted.storage_region,
      key: persisted.key,
    });
    expect(lines).toEqual([{ stream: 'stdout', text: 'built ok', created_at: '' }]);
  });

  it('returns null for a missing key', async () => {
    const config = {
      dataDir: `/tmp/agent-hub-test-missing-${process.pid}`,
      artifactsBucket: null,
      artifactsBucketRegion: null,
    } as unknown as AppConfig;
    const store = createFinalizeStepLogStore(config);
    const lines = await store.read({
      storage_kind: 'local',
      storage_bucket: null,
      storage_region: null,
      key: 'finalize-logs/nope/9.json.gz',
    });
    expect(lines).toBeNull();
  });

  it('returns null when no location is recorded (legacy rows)', async () => {
    const config = { dataDir: '/tmp', artifactsBucket: null } as unknown as AppConfig;
    const store = createFinalizeStepLogStore(config);
    expect(
      await store.read({
        storage_kind: null,
        storage_bucket: null,
        storage_region: null,
        key: null,
      }),
    ).toBeNull();
  });
});
