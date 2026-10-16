import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { S3Client } from '@aws-sdk/client-s3';
import { LocalDirDesktopHomeStore } from './desktop-home-store.js';
import { S3DesktopHomeStore } from './desktop-home-store-s3.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/**
 * A versioned bucket, as S3 behaves: a delete without VersionId only adds a
 * delete marker; one with a VersionId removes that version (or marker).
 * Lists page two entries at a time to exercise the markers.
 */
function versionedBucket(opts: { denyVersion?: string } = {}) {
  type Entry = { Key: string; VersionId: string; marker: boolean };
  let entries: Entry[] = [];
  let n = 0;
  const put = (Key: string) => entries.push({ Key, VersionId: `v${++n}`, marker: false });
  const sent: string[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      sent.push(name);
      const input = cmd.input;
      if (name === 'ListObjectVersionsCommand') {
        const all = entries
          .filter((e) => e.Key.startsWith(String(input.Prefix ?? '')))
          .sort((x, y) => (x.Key + x.VersionId).localeCompare(y.Key + y.VersionId));
        const start = input.KeyMarker
          ? all.findIndex(
              (e) => e.Key === input.KeyMarker && e.VersionId === input.VersionIdMarker,
            ) + 1
          : 0;
        const page = all.slice(start, start + 2);
        const last = page.at(-1);
        const truncated = start + 2 < all.length;
        return {
          Versions: page.filter((e) => !e.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
          DeleteMarkers: page
            .filter((e) => e.marker)
            .map(({ Key, VersionId }) => ({ Key, VersionId })),
          IsTruncated: truncated,
          NextKeyMarker: truncated ? last?.Key : undefined,
          NextVersionIdMarker: truncated ? last?.VersionId : undefined,
        };
      }
      if (name === 'DeleteObjectsCommand') {
        const objects = (input.Delete as { Objects: Array<{ Key: string; VersionId?: string }> })
          .Objects;
        const Errors: Array<Record<string, string>> = [];
        for (const o of objects) {
          if (!o.VersionId) {
            entries.push({ Key: o.Key, VersionId: `v${++n}`, marker: true });
          } else if (o.VersionId === opts.denyVersion) {
            Errors.push({ Key: o.Key, Code: 'AccessDenied', Message: 'Access Denied' });
          } else {
            entries = entries.filter((e) => !(e.Key === o.Key && e.VersionId === o.VersionId));
          }
        }
        return Errors.length ? { Errors } : {};
      }
      throw new Error(`unexpected ${name}`);
    },
  } as unknown as S3Client;
  return { client, sent, put, keys: () => entries.map((e) => `${e.Key}@${e.VersionId}`) };
}

describe('desktop home stores', () => {
  it('S3 deletePrefix removes every version and delete marker under the prefix only', async () => {
    const bucket = versionedBucket();
    bucket.put('c1/job-a.tar.gz');
    bucket.put('c1/job-a.tar.gz');
    bucket.put('c1/job-a.tar.gz');
    bucket.put('c1/job-b.tar.gz');
    bucket.put('c2/job-x.tar.gz');
    const store = new S3DesktopHomeStore({ bucket: 'b', client: bucket.client });
    // An earlier non-versioned delete left a marker over the stored versions.
    await bucket.client.send(
      new (await import('@aws-sdk/client-s3')).DeleteObjectsCommand({
        Bucket: 'b',
        Delete: { Objects: [{ Key: 'c1/job-b.tar.gz' }] },
      }),
    );
    await store.deletePrefix('c1/');
    expect(bucket.keys()).toEqual(['c2/job-x.tar.gz@v5']);
  });

  it('S3 delete removes every version of exactly that key', async () => {
    const bucket = versionedBucket();
    bucket.put('c1/job-a.tar.gz');
    bucket.put('c1/job-a.tar.gz');
    bucket.put('c1/job-a.tar.gz.part');
    const store = new S3DesktopHomeStore({ bucket: 'b', client: bucket.client });
    await store.delete('c1/job-a.tar.gz');
    expect(bucket.keys()).toEqual(['c1/job-a.tar.gz.part@v3']);
  });

  it('S3 delete of a missing key is a no-op', async () => {
    const bucket = versionedBucket();
    const store = new S3DesktopHomeStore({ bucket: 'b', client: bucket.client });
    await store.delete('c1/none.tar.gz');
    expect(bucket.sent).toEqual(['ListObjectVersionsCommand']);
  });

  it('S3 deletePrefix fails when a version cannot be removed (Object Lock, permissions)', async () => {
    const bucket = versionedBucket({ denyVersion: 'v2' });
    bucket.put('c1/job-a.tar.gz');
    bucket.put('c1/job-a.tar.gz');
    const store = new S3DesktopHomeStore({ bucket: 'b', client: bucket.client });
    await expect(store.deletePrefix('c1/')).rejects.toThrow(
      /could not delete 1 desktop home object version\(s\) under c1\/: c1\/job-a.tar.gz: AccessDenied/,
    );
  });

  it('S3 deletes work on an unversioned bucket (the single null version)', async () => {
    const deleted: unknown[] = [];
    const client = {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        if (cmd.constructor.name === 'ListObjectVersionsCommand') {
          return { Versions: [{ Key: 'c1/a.tar.gz', VersionId: 'null' }], IsTruncated: false };
        }
        deleted.push(cmd.input.Delete);
        return {};
      },
    } as unknown as S3Client;
    await new S3DesktopHomeStore({ bucket: 'b', client }).deletePrefix('c1/');
    expect(deleted).toEqual([
      { Objects: [{ Key: 'c1/a.tar.gz', VersionId: 'null' }], Quiet: true },
    ]);
  });

  it('local get reads absence as missing but surfaces other errors', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-home-store-'));
    const store = new LocalDirDesktopHomeStore(dir);
    expect(await store.get('c1/none.tar.gz', path.join(dir, 'out'))).toBe(false);

    mkdirSync(path.join(dir, 'c1'));
    writeFileSync(path.join(dir, 'c1', 'x.tar.gz'), 'home');
    if (process.getuid?.() === 0) return; // root ignores permission bits
    chmodSync(path.join(dir, 'c1'), 0o000);
    try {
      await expect(store.get('c1/x.tar.gz', path.join(dir, 'out'))).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(path.join(dir, 'c1'), 0o700);
    }
  });

  it('rejects keys that escape the store root', async () => {
    const store = new LocalDirDesktopHomeStore('/tmp/x');
    await expect(store.get('../etc/passwd', '/tmp/y')).rejects.toThrow(/invalid desktop home key/);
  });
});
