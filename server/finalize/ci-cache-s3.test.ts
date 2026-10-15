import { describe, expect, it, vi } from 'vitest';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { MAX_LIST_PAGES, S3CacheStore, resolveCacheStore } from './ci-cache-s3.js';

function storeWith(send: (cmd: unknown) => unknown) {
  const client = { send: vi.fn(async (cmd: unknown) => send(cmd)) } as unknown as S3Client;
  return { store: new S3CacheStore({ bucket: 'b', client }), client };
}

describe('S3CacheStore', () => {
  it('checks existence with an exact-key listing, so a cold key is a miss, not a 403', async () => {
    const calls: ListObjectsV2Command[] = [];
    const listing: Record<string, string[]> = {
      'p/img-abc': ['p/img-abc'],
      'p/img-ab': ['p/img-abc'], // a longer key shares the prefix: not an exact hit
      'p/cold': [],
    };
    const { store } = storeWith((cmd) => {
      expect(cmd).toBeInstanceOf(ListObjectsV2Command);
      const input = (cmd as ListObjectsV2Command).input;
      calls.push(cmd as ListObjectsV2Command);
      return { Contents: (listing[input.Prefix ?? ''] ?? []).map((Key) => ({ Key })) };
    });

    expect(await store.exists('p/img-abc')).toBe(true);
    expect(await store.exists('p/img-ab')).toBe(false);
    expect(await store.exists('p/cold')).toBe(false);
    expect(calls.every((c) => c.input.MaxKeys === 1)).toBe(true);
  });

  it('rethrows real access errors instead of reporting a miss', async () => {
    const denied = Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
    await expect(
      storeWith(() => {
        throw denied;
      }).store.exists('p/k'),
    ).rejects.toThrow('AccessDenied');
  });

  it('forwards an abort signal to every S3 request', async () => {
    const { store, client } = storeWith(() => ({ Contents: [], IsTruncated: false }));
    const ac = new AbortController();
    await store.exists('p/k', ac.signal);
    await store.newestWithPrefix('p/', ac.signal);
    for (const call of (client.send as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual({ abortSignal: ac.signal });
    }
  });

  const presignStore = () =>
    new S3CacheStore({
      bucket: 'b',
      region: 'us-east-2',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
      // A listing client with SDK defaults must not leak into presigning.
      client: new S3Client({ region: 'us-east-2' }),
    });

  it('presigns a conditional PUT with If-None-Match signed into the URL', async () => {
    const url = new URL(await presignStore().presignPut('finalize-cache/o/p/k'));
    const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toContain('if-none-match');
  });

  it('presigns the PUT with no body checksum, so a nonempty archive upload is accepted', async () => {
    // With SDK defaults the URL would carry x-amz-checksum-crc32=AAAAAA== (the
    // empty body's CRC32) and S3 would reject any real archive with BadDigest.
    const url = new URL(await presignStore().presignPut('finalize-cache/o/p/k'));
    const params = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(params.filter((k) => k.includes('checksum'))).toEqual([]);
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed.filter((h) => h.includes('checksum') || h === 'content-length')).toEqual([]);
    // The upload curl sends only these headers, so the signature still matches.
    expect(signed.sort()).toEqual(['host', 'if-none-match']);
  });

  it('documents the SDK default this guards against', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const defaults = new S3Client({
      region: 'us-east-2',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
    });
    const url = new URL(
      await getSignedUrl(defaults, new PutObjectCommand({ Bucket: 'b', Key: 'k' }), {
        expiresIn: 60,
      }),
    );
    // If a future SDK stops doing this, the guard is harmless; this test then
    // documents that the empty-body checksum is no longer injected.
    const crc = url.searchParams.get('x-amz-checksum-crc32');
    expect(crc === null || crc === 'AAAAAA==').toBe(true);
  });

  it('presigns GETs without SDK checksum parameters curl cannot use', async () => {
    const url = new URL(await presignStore().presignGet('finalize-cache/o/p/k'));
    expect([...url.searchParams.keys()].some((k) => /checksum/i.test(k))).toBe(false);
  });

  it('returns the newest object across list pages', async () => {
    const pages = [
      {
        Contents: [
          { Key: 'p/a', LastModified: new Date(1000) },
          { Key: 'p/b', LastModified: new Date(3000) },
        ],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      { Contents: [{ Key: 'p/c', LastModified: new Date(2000) }], IsTruncated: false },
    ];
    const { store, client } = storeWith((cmd) => {
      expect(cmd).toBeInstanceOf(ListObjectsV2Command);
      return pages.shift();
    });

    expect(await store.newestWithPrefix('p/')).toBe('p/b');
    const tokens = (client.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([c]) => (c as ListObjectsV2Command).input.ContinuationToken,
    );
    expect(tokens).toEqual([undefined, 't1']);
  });

  it('refuses to guess when the newest match lies beyond the listing bound', async () => {
    // Keys are listed by name: the newest object sits on the page right after
    // the bound. Returning the newest *seen* would silently restore old data.
    let page = 0;
    const { store, client } = storeWith(() => {
      page += 1;
      const newestOnThisPage = page === MAX_LIST_PAGES + 1;
      return {
        Contents: [
          {
            Key: `p/k-${String(page).padStart(4, '0')}`,
            LastModified: new Date(newestOnThisPage ? 9e12 : page),
          },
        ],
        IsTruncated: true,
        NextContinuationToken: `t${page}`,
      };
    });

    await expect(store.newestWithPrefix('p/k-')).rejects.toThrow(/more specific restore-keys/);
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(MAX_LIST_PAGES);
  });

  it('returns the newest match when the full listing fits within the bound', async () => {
    let page = 0;
    const { store } = storeWith(() => {
      page += 1;
      const last = page === MAX_LIST_PAGES;
      return {
        Contents: [{ Key: `p/k-${page}`, LastModified: new Date(last ? 9e12 : page) }],
        IsTruncated: !last,
        NextContinuationToken: last ? undefined : `t${page}`,
      };
    });
    expect(await store.newestWithPrefix('p/k-')).toBe(`p/k-${MAX_LIST_PAGES}`);
  });

  it('returns null when nothing matches the prefix', async () => {
    const { store } = storeWith((cmd) => {
      expect(cmd).toBeInstanceOf(ListObjectsV2Command);
      return { Contents: [], IsTruncated: false };
    });
    expect(await store.newestWithPrefix('none/')).toBeNull();
  });
});

describe('resolveCacheStore', () => {
  it('is null without FINALIZE_CACHE_BUCKET', () => {
    expect(resolveCacheStore({})).toBeNull();
    expect(resolveCacheStore({ FINALIZE_CACHE_BUCKET: '  ' })).toBeNull();
    expect(
      resolveCacheStore({ FINALIZE_CACHE_BUCKET: 'cache', AWS_REGION: 'us-east-2' }),
    ).toBeInstanceOf(S3CacheStore);
  });
});
