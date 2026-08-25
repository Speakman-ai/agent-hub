// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { uploadAttachments } from './uploadAttachments';
function makeApi() {
  return {
    uploadImage: vi.fn(async (dataUrl: any, name: any) => ({
      id: `img-${name}`,
      url: `/uploads/${name}`,
      contentType: 'image/png',
    })),
    uploadFile: vi.fn(async ({ name, type }: any) => ({
      id: `file-${name}`,
      url: `/uploads/${name}`,
      contentType: type,
    })),
  };
}
describe('uploadAttachments — routes each kind to the right endpoint', () => {
  it('images → api.uploadImage(dataUrl, name)', async () => {
    const api = makeApi();
    const out = await uploadAttachments(
      [{ kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAA', uri: 'file:///a' }],
      api,
    );
    expect(api.uploadImage).toHaveBeenCalledTimes(1);
    expect(api.uploadImage).toHaveBeenCalledWith('data:image/png;base64,AAA', 'a.png');
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('img-a.png');
  });
  it('videos → api.uploadFile({ uri, name, type })', async () => {
    const api = makeApi();
    const out = await uploadAttachments(
      [
        {
          kind: 'video',
          name: 'clip.mp4',
          uri: 'file:///tmp/clip.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 12345,
        },
      ],
      api,
    );
    expect(api.uploadFile).toHaveBeenCalledWith({
      uri: 'file:///tmp/clip.mp4',
      name: 'clip.mp4',
      type: 'video/mp4',
      size: 12345,
    });
    expect(api.uploadImage).not.toHaveBeenCalled();
    expect(out[0].contentType).toBe('video/mp4');
  });
  it('generic files → api.uploadFile with octet-stream fallback', async () => {
    const api = makeApi();
    await uploadAttachments(
      [{ kind: 'file', name: 'notes.txt', uri: 'file:///tmp/notes.txt' }],
      api,
    );
    expect(api.uploadFile).toHaveBeenCalledWith({
      uri: 'file:///tmp/notes.txt',
      name: 'notes.txt',
      type: 'application/octet-stream',
      size: undefined,
    });
  });
  it('batches multiple attachments and preserves order of successful results', async () => {
    const api = makeApi();
    const out = await uploadAttachments(
      [
        { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,A' },
        { kind: 'video', name: 'b.mp4', uri: 'file:///b', mimeType: 'video/mp4' },
        { kind: 'file', name: 'c.pdf', uri: 'file:///c', mimeType: 'application/pdf' },
      ],
      api,
    );
    expect(out.map((r: any) => r.id)).toEqual(['img-a.png', 'file-b.mp4', 'file-c.pdf']);
  });
  it('drops images without a dataUrl instead of calling the API', async () => {
    const api = makeApi();
    const out = await uploadAttachments([{ kind: 'image', name: 'bad.png' }], api);
    expect(out).toEqual([]);
    expect(api.uploadImage).not.toHaveBeenCalled();
  });
  it('drops videos/files without a uri', async () => {
    const api = makeApi();
    const out = await uploadAttachments([{ kind: 'video', name: 'no-uri.mp4' }], api);
    expect(out).toEqual([]);
    expect(api.uploadFile).not.toHaveBeenCalled();
  });
  it('returns [] for empty or non-array input', async () => {
    const api = makeApi();
    await expect(uploadAttachments([], api)).resolves.toEqual([]);
    await expect(uploadAttachments(null, api)).resolves.toEqual([]);
    await expect(uploadAttachments(undefined, api)).resolves.toEqual([]);
  });
});
