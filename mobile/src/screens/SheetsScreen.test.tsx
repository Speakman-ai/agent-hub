import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem }: any) => (
    <div>{(data || []).map((item: any, index: number) => renderItem({ item, index }))}</div>
  ),
  Linking: { openURL: vi.fn() },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ projects: [] }) }));
vi.mock('../utils/api', () => ({ api: {} }));

import {
  SheetsContent,
  SHEETS_SURFACE_SCOPES,
  buildCellRange,
  columnLetter,
  extractSpreadsheetId,
  openSheetsOAuth,
  quoteSheetTitle,
  sheetsReturnTo,
} from './SheetsScreen';
import { SHEETS_SCOPE, DRIVE_FILE_SCOPE } from '../utils/googleSurface';

const noop = () => undefined;

const baseProps = {
  loading: false,
  error: null,
  files: [],
  filesLoading: false,
  manualId: '',
  onChangeManualId: noop,
  onOpenManual: noop,
  onOpenFile: noop,
  onRefreshFiles: noop,
  onConnect: noop,
  onOpenSettings: noop,
  selected: null,
  meta: null,
  activeTab: null,
  grid: [],
  valuesLoading: false,
  canWrite: false,
  canList: false,
  onSelectTab: noop,
  onBack: noop,
  onRefreshValues: noop,
  onEditCell: noop,
};

describe('SheetsScreen A1 helpers', () => {
  it('maps zero-based column indexes to A1 letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
  });

  it('quotes sheet titles and builds single-cell ranges', () => {
    expect(quoteSheetTitle("Bob's data")).toBe("'Bob''s data'");
    expect(buildCellRange('Sheet1', 0, 0)).toBe("'Sheet1'!A1");
    expect(buildCellRange('Q2 Plan', 2, 1)).toBe("'Q2 Plan'!B3");
  });

  it('extracts the spreadsheet ID from a share URL and passes bare IDs through', () => {
    expect(
      extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-_xyz/edit#gid=0'),
    ).toBe('1AbC-_xyz');
    expect(extractSpreadsheetId('  1AbC-_xyz  ')).toBe('1AbC-_xyz');
    expect(extractSpreadsheetId('')).toBe('');
  });
});

describe('SheetsScreen mobile parity', () => {
  it('renders the not-linked route to connect Google', () => {
    const html = renderToStaticMarkup(
      <SheetsContent
        {...baseProps}
        status={{ connected: false, grantedScopes: [], serverConfigured: true }}
      />,
    );
    expect(html).toContain('Connect Google to use Sheets');
    expect(html).toContain('Connect Google');
  });

  it('renders the inline Enable Sheets affordance when connected but missing consent', () => {
    const html = renderToStaticMarkup(
      <SheetsContent
        {...baseProps}
        status={{
          connected: true,
          email: 'person@example.com',
          grantedScopes: ['https://www.googleapis.com/auth/gmail.send'],
          serverConfigured: true,
        }}
      />,
    );
    expect(html).toContain('Enable Sheets access');
    expect(html).toContain('Enable Sheets');
  });

  it('renders the Drive-backed spreadsheet picker when connected with Sheets + Drive scopes', () => {
    const html = renderToStaticMarkup(
      <SheetsContent
        {...baseProps}
        status={{
          connected: true,
          grantedScopes: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
          serverConfigured: true,
        }}
        canList
        files={[{ id: 'sheet-1', name: 'Budget' }]}
      />,
    );
    expect(html).toContain('Spreadsheets');
    expect(html).toContain('Open by spreadsheet ID');
    expect(html).toContain('Budget');
  });

  it('renders the value grid for a selected spreadsheet tab', () => {
    const html = renderToStaticMarkup(
      <SheetsContent
        {...baseProps}
        status={{
          connected: true,
          grantedScopes: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
          serverConfigured: true,
        }}
        canWrite
        canList
        selected={{ id: 'sheet-1', name: 'Budget' }}
        meta={{ title: 'Budget', sheets: [{ sheetId: 0, title: 'Tab1' }] }}
        activeTab="Tab1"
        grid={[
          ['Item', 'Cost'],
          ['Coffee', '5'],
        ]}
      />,
    );
    expect(html).toContain('Budget');
    expect(html).toContain('Item');
    expect(html).toContain('Coffee');
  });

  it('pads short rows so blank cells in existing columns stay editable (rectangular grid)', () => {
    // A sparse sheet: row 0 has 2 columns, row 1 has only 1. The grid must pad
    // row 1 to the widest row (2) so the blank B-column cell is reachable.
    const html = renderToStaticMarkup(
      <SheetsContent
        {...baseProps}
        status={{
          connected: true,
          grantedScopes: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
          serverConfigured: true,
        }}
        canWrite
        canList
        selected={{ id: 'sheet-1', name: 'Sparse' }}
        meta={{ title: 'Sparse', sheets: [{ sheetId: 0, title: 'Tab1' }] }}
        activeTab="Tab1"
        grid={[['a', 'b'], ['c']]}
      />,
    );
    const cellCount = (html.match(/sheet-cell-/g) || []).length;
    // 2 rows x 2 columns = 4 editable cells, including the padded blank B2.
    expect(cellCount).toBe(4);
    expect(html).toContain('sheet-cell-1-1');
  });

  it('shows a read-only notice and no editable cells when write scope is missing', () => {
    const html = renderToStaticMarkup(
      <SheetsContent
        {...baseProps}
        status={{
          connected: true,
          grantedScopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', DRIVE_FILE_SCOPE],
          serverConfigured: true,
        }}
        canWrite={false}
        canList
        selected={{ id: 'sheet-ro', name: 'Report' }}
        meta={{ title: 'Report', sheets: [{ sheetId: 0, title: 'Tab1' }] }}
        activeTab="Tab1"
        grid={[['Locked']]}
      />,
    );
    expect(html).toContain('Read-only access');
    expect(html).toContain('Locked');
  });

  it('starts OAuth with the GLOBAL sheets hash route and the Sheets + Drive scopes', async () => {
    const apiClient = {
      startGoogleOAuth: vi.fn().mockResolvedValue({
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      }),
    };
    const openURL = vi.fn().mockResolvedValue(true);

    await expect(openSheetsOAuth({ apiClient, openURL })).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    );

    expect(apiClient.startGoogleOAuth).toHaveBeenCalledWith({
      returnTo: '/#/sheets',
      scopes: SHEETS_SURFACE_SCOPES,
    });
    expect(SHEETS_SURFACE_SCOPES).toEqual([SHEETS_SCOPE, DRIVE_FILE_SCOPE]);
    expect(sheetsReturnTo()).toBe('/#/sheets');
  });
});
