import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    getGoogleStatus: vi.fn(),
    startGoogleOAuth: vi.fn(),
    listGoogleDriveFiles: vi.fn(),
    getGoogleSpreadsheet: vi.fn(),
    readGoogleSheetValues: vi.fn(),
    updateGoogleSheetValues: vi.fn(),
    appendGoogleSheetValues: vi.fn(),
  },
}));

import SheetsViewerPage, {
  SHEETS_SURFACE_SCOPES,
  columnLetter,
  quoteSheetTitle,
  buildCellRange,
  extractSpreadsheetId,
} from './SheetsViewerPage';
import { SHEETS_SCOPE, DRIVE_FILE_SCOPE } from '../utils/googleSurface';
import { api } from '../utils/api';

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SheetsViewerPage A1 helpers', () => {
  it('maps zero-based column indexes to A1 letters', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
  });

  it('quotes sheet titles and escapes embedded quotes', () => {
    expect(quoteSheetTitle('Sheet1')).toBe("'Sheet1'");
    expect(quoteSheetTitle("Bob's data")).toBe("'Bob''s data'");
  });

  it('builds a single-cell A1 range from a tab title and zero-based row/col', () => {
    expect(buildCellRange('Sheet1', 0, 0)).toBe("'Sheet1'!A1");
    expect(buildCellRange('Q2 Plan', 2, 1)).toBe("'Q2 Plan'!B3");
  });

  it('extracts the spreadsheet ID from a share URL and passes bare IDs through', () => {
    expect(
      extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-_xyz/edit#gid=0'),
    ).toBe('1AbC-_xyz');
    expect(
      extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-_xyz/edit?usp=sharing'),
    ).toBe('1AbC-_xyz');
    expect(extractSpreadsheetId('  1AbC-_xyz  ')).toBe('1AbC-_xyz');
    expect(extractSpreadsheetId('')).toBe('');
  });
});

describe('SheetsViewerPage', () => {
  it('renders a connect route when Google is not linked', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: false,
      grantedScopes: [],
      serverConfigured: true,
    });

    render(<SheetsViewerPage />);

    expect(await screen.findByText('Connect Google to use Sheets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Google/i })).toBeInTheDocument();
    expect(mockApi.listGoogleDriveFiles).not.toHaveBeenCalled();
  });

  it('shows an inline Enable Sheets affordance when connected but missing consent', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.send'],
      serverConfigured: true,
    });

    render(<SheetsViewerPage />);

    expect(await screen.findByText('Enable Sheets access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Sheets/i })).toBeInTheDocument();
    expect(mockApi.listGoogleDriveFiles).not.toHaveBeenCalled();
  });

  it('requests the Sheets + Drive surface scopes when enabling consent', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [],
      serverConfigured: true,
    });
    mockApi.startGoogleOAuth.mockResolvedValueOnce({ authorizeUrl: 'https://accounts.google/x' });

    render(<SheetsViewerPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Enable Sheets/i }));

    await waitFor(() => {
      expect(mockApi.startGoogleOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: SHEETS_SURFACE_SCOPES }),
      );
    });
    expect(SHEETS_SURFACE_SCOPES).toEqual([SHEETS_SCOPE, DRIVE_FILE_SCOPE]);
  });

  it('lists Drive spreadsheets, opens a selection, and renders its values grid', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
      serverConfigured: true,
    });
    mockApi.listGoogleDriveFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'sheet-1',
          name: 'Budget',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: '2026-06-01T00:00:00Z',
          webViewLink: null,
        },
      ],
    });
    mockApi.getGoogleSpreadsheet.mockResolvedValueOnce({
      spreadsheetId: 'sheet-1',
      title: 'Budget',
      spreadsheetUrl: null,
      sheets: [{ sheetId: 0, title: 'Tab1', index: 0, rowCount: 100, columnCount: 26 }],
    });
    mockApi.readGoogleSheetValues.mockResolvedValueOnce({
      range: 'Tab1!A1:B2',
      majorDimension: 'ROWS',
      values: [
        ['Item', 'Cost'],
        ['Coffee', '5'],
      ],
    });

    render(<SheetsViewerPage />);

    // The Drive-backed picker lists the spreadsheet.
    const fileRow = await screen.findByTestId('sheet-file-sheet-1');
    expect(fileRow).toBeInTheDocument();
    expect(mockApi.listGoogleDriveFiles).toHaveBeenCalled();

    fireEvent.click(fileRow);

    // Metadata + values load; the grid renders the first tab's cells.
    expect(await screen.findByText('Coffee')).toBeInTheDocument();
    expect(screen.getByText('Item')).toBeInTheDocument();
    expect(mockApi.getGoogleSpreadsheet).toHaveBeenCalledWith('sheet-1');
    // The whole-tab range is read with the quoted tab title.
    expect(mockApi.readGoogleSheetValues).toHaveBeenCalledWith('sheet-1', {
      range: "'Tab1'",
    });
  });

  it('edits a cell via the proxy PUT when the full spreadsheets scope is granted', async () => {
    mockApi.getGoogleStatus.mockResolvedValue({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [SHEETS_SCOPE, DRIVE_FILE_SCOPE],
      serverConfigured: true,
    });
    mockApi.listGoogleDriveFiles.mockResolvedValue({
      files: [
        {
          id: 'sheet-1',
          name: 'Budget',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: null,
          webViewLink: null,
        },
      ],
    });
    mockApi.getGoogleSpreadsheet.mockResolvedValue({
      spreadsheetId: 'sheet-1',
      title: 'Budget',
      spreadsheetUrl: null,
      sheets: [{ sheetId: 0, title: 'Tab1', index: 0, rowCount: 100, columnCount: 26 }],
    });
    mockApi.readGoogleSheetValues
      .mockResolvedValueOnce({ range: 'Tab1', majorDimension: 'ROWS', values: [['Coffee', '5']] })
      .mockResolvedValueOnce({ range: 'Tab1', majorDimension: 'ROWS', values: [['Tea', '5']] });
    mockApi.updateGoogleSheetValues.mockResolvedValueOnce({
      spreadsheetId: 'sheet-1',
      updatedRange: 'Tab1!A1',
      updatedCells: 1,
    });

    render(<SheetsViewerPage />);

    fireEvent.click(await screen.findByTestId('sheet-file-sheet-1'));
    // Cell A1 (row 0, col 0) is an editable button when write scope is present.
    const cell = await screen.findByTestId('sheet-cell-0-0');
    fireEvent.click(cell);

    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Tea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockApi.updateGoogleSheetValues).toHaveBeenCalledWith('sheet-1', {
        range: "'Tab1'!A1",
        values: [['Tea']],
        valueInputOption: 'USER_ENTERED',
      });
    });
    expect(await screen.findByText('Tea')).toBeInTheDocument();
  });

  it('renders read-only cells (no edit affordance) when only the readonly scope is granted', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', DRIVE_FILE_SCOPE],
      serverConfigured: true,
    });
    mockApi.listGoogleDriveFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'sheet-ro',
          name: 'Report',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: null,
          webViewLink: null,
        },
      ],
    });
    mockApi.getGoogleSpreadsheet.mockResolvedValueOnce({
      spreadsheetId: 'sheet-ro',
      title: 'Report',
      spreadsheetUrl: null,
      sheets: [{ sheetId: 0, title: 'Tab1', index: 0, rowCount: 1, columnCount: 1 }],
    });
    mockApi.readGoogleSheetValues.mockResolvedValueOnce({
      range: 'Tab1',
      majorDimension: 'ROWS',
      values: [['Locked']],
    });

    render(<SheetsViewerPage />);

    fireEvent.click(await screen.findByTestId('sheet-file-sheet-ro'));
    expect(await screen.findByText('Locked')).toBeInTheDocument();
    // No editable cell button rendered; a read-only notice is shown.
    expect(screen.queryByTestId('sheet-cell-0-0')).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only access/i)).toBeInTheDocument();
  });

  it('opens a spreadsheet by manual ID without the Drive picker', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      // Sheets granted, but NOT drive.file → picker disabled, manual entry only.
      grantedScopes: [SHEETS_SCOPE],
      serverConfigured: true,
    });
    mockApi.getGoogleSpreadsheet.mockResolvedValueOnce({
      spreadsheetId: 'manual-1',
      title: 'Manual Sheet',
      spreadsheetUrl: null,
      sheets: [{ sheetId: 0, title: 'Tab1', index: 0, rowCount: 1, columnCount: 1 }],
    });
    mockApi.readGoogleSheetValues.mockResolvedValueOnce({
      range: 'Tab1',
      majorDimension: 'ROWS',
      values: [['Hello']],
    });

    render(<SheetsViewerPage />);

    // Drive list is never called without drive.file scope.
    await screen.findByText(/Open by spreadsheet ID/i);
    expect(mockApi.listGoogleDriveFiles).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('1AbC...xyz'), {
      target: { value: 'manual-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Hello')).toBeInTheDocument();
    expect(mockApi.getGoogleSpreadsheet).toHaveBeenCalledWith('manual-1');
  });

  it('extracts the spreadsheet ID when a full Google Sheets URL is pasted', async () => {
    mockApi.getGoogleStatus.mockResolvedValueOnce({
      connected: true,
      email: 'person@example.com',
      grantedScopes: [SHEETS_SCOPE],
      serverConfigured: true,
    });
    mockApi.getGoogleSpreadsheet.mockResolvedValueOnce({
      spreadsheetId: '1AbC-_xyz',
      title: 'Pasted Sheet',
      spreadsheetUrl: null,
      sheets: [{ sheetId: 0, title: 'Tab1', index: 0, rowCount: 1, columnCount: 1 }],
    });
    mockApi.readGoogleSheetValues.mockResolvedValueOnce({
      range: 'Tab1',
      majorDimension: 'ROWS',
      values: [['Hi']],
    });

    render(<SheetsViewerPage />);

    await screen.findByText(/Open by spreadsheet ID/i);
    fireEvent.change(screen.getByPlaceholderText('1AbC...xyz'), {
      target: { value: 'https://docs.google.com/spreadsheets/d/1AbC-_xyz/edit#gid=0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Hi')).toBeInTheDocument();
    // The proxy receives the bare ID, not the whole URL.
    expect(mockApi.getGoogleSpreadsheet).toHaveBeenCalledWith('1AbC-_xyz');
  });
});
