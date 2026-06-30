import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('api Google Sheets + Drive helpers', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, files: [], values: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('lists Drive spreadsheets through the user-scoped proxy', async () => {
    await api.listGoogleDriveFiles({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet'",
      orderBy: 'modifiedTime desc',
      pageSize: 50,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/google/drive/files?');
    expect(String(url)).toContain('orderBy=modifiedTime+desc');
    expect(String(url)).toContain('pageSize=50');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('reads spreadsheet metadata and a value range', async () => {
    await api.getGoogleSpreadsheet('sheet/1');
    await api.readGoogleSheetValues('sheet/1', { range: "'Tab1'!A1:B2" });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/google/sheets/sheet%2F1');
    expect(String(fetchSpy.mock.calls[1][0])).toContain(
      '/api/google/sheets/sheet%2F1/values?range=',
    );
    expect(fetchSpy.mock.calls[1][1].method ?? 'GET').toBe('GET');
  });

  it('updates and appends values through the Sheets proxy', async () => {
    await api.updateGoogleSheetValues('sheet-1', {
      range: "'Tab1'!A1",
      values: [['x']],
      valueInputOption: 'USER_ENTERED',
    });
    await api.appendGoogleSheetValues('sheet-1', {
      range: "'Tab1'!A1",
      values: [['y']],
    });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/google/sheets/sheet-1/values');
    expect(fetchSpy.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      range: "'Tab1'!A1",
      values: [['x']],
      valueInputOption: 'USER_ENTERED',
    });
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/api/google/sheets/sheet-1/values/append');
    expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
  });
});
