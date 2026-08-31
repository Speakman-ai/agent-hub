import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the command handed to the presigner so we can assert the response
// header overrides are threaded through.
const getSignedUrl = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));

import { S3ArtifactStore } from './artifact-store-s3.js';

beforeEach(() => {
  getSignedUrl.mockReset();
});

describe('S3ArtifactStore.presignGet', () => {
  it('threads the response content-type + disposition overrides into the signed GET', async () => {
    getSignedUrl.mockResolvedValue('https://signed.example/obj?sig=1');
    const store = new S3ArtifactStore({ bucket: 'blobs', region: 'us-east-2' });

    const url = await store.presignGet('sess/art', {
      responseContentType: 'application/pdf',
      responseContentDisposition: 'inline; filename="report.pdf"',
    });

    expect(url).toBe('https://signed.example/obj?sig=1');
    const command = getSignedUrl.mock.calls[0]![1] as { input: Record<string, unknown> };
    expect(command.input.Bucket).toBe('blobs');
    expect(command.input.Key).toBe('sess/art');
    // These overrides make the direct-to-S3 download carry the reconciled type
    // instead of the object's stored (possibly generic) metadata.
    expect(command.input.ResponseContentType).toBe('application/pdf');
    expect(command.input.ResponseContentDisposition).toBe('inline; filename="report.pdf"');
  });

  it('presigns without overrides when none are supplied', async () => {
    getSignedUrl.mockResolvedValue('https://signed.example/obj');
    const store = new S3ArtifactStore({ bucket: 'blobs' });

    await store.presignGet('sess/art');

    const command = getSignedUrl.mock.calls[0]![1] as { input: Record<string, unknown> };
    expect(command.input.ResponseContentType).toBeUndefined();
    expect(command.input.ResponseContentDisposition).toBeUndefined();
  });
});
