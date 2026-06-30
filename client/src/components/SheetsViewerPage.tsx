import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { api } from '../utils/api';
import {
  SHEETS_SURFACE_SCOPES,
  hasSheetsScope,
  hasSheetsWriteScope,
  hasDriveFileScope,
  type GoogleStatusLike,
} from '../utils/googleSurface';

export { SHEETS_SURFACE_SCOPES };

type GoogleStatus = NonNullable<GoogleStatusLike>;

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

type DriveFile = {
  id: string | null;
  name: string | null;
  mimeType: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
};

type SheetTab = {
  sheetId: number | null;
  title: string | null;
  index: number | null;
  rowCount: number | null;
  columnCount: number | null;
};

type SpreadsheetMeta = {
  spreadsheetId: string | null;
  title: string | null;
  spreadsheetUrl: string | null;
  sheets: SheetTab[];
};

type CellValue = string | number | boolean;

/**
 * Convert a zero-based column index into its A1 column letters (0 -> A, 25 -> Z,
 * 26 -> AA). Exported for unit testing the range builder.
 */
export function columnLetter(index: number): string {
  let i = Math.max(0, Math.floor(index)) + 1;
  let s = '';
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/** Wrap a sheet/tab title in single quotes, escaping embedded quotes, for A1 notation. */
export function quoteSheetTitle(title: string): string {
  return `'${String(title).replace(/'/g, "''")}'`;
}

/** Build the A1 range for a single cell within a named tab, e.g. `'Sheet 1'!B3`. */
export function buildCellRange(title: string, row: number, col: number): string {
  return `${quoteSheetTitle(title)}!${columnLetter(col)}${row + 1}`;
}

/**
 * Extract a spreadsheet ID from a raw ID or a Google Sheets URL. A normal share
 * URL looks like `https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0`; we
 * pull the `/spreadsheets/d/<ID>` segment so the Sheets proxy receives the bare
 * ID rather than the whole URL. Bare IDs pass through unchanged. Exported for
 * unit testing.
 */
export function extractSpreadsheetId(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const fromUrl = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl) return fromUrl[1];
  // A bare ID (no scheme/slashes) is used as-is.
  if (/^[a-zA-Z0-9-_]+$/.test(raw)) return raw;
  // Other URLs: strip query/hash and take a trailing id-like path segment.
  const path = raw.split(/[?#]/)[0];
  const segment = path.split('/').filter(Boolean).pop() || '';
  return /^[a-zA-Z0-9-_]+$/.test(segment) ? segment : raw;
}

function formatDriveTime(value: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function CellEditModal({
  cellLabel,
  initialValue,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  cellLabel: string;
  initialValue: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Edit cell {cellLabel}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close cell editor"
          >
            <X size={16} />
          </button>
        </div>
        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(value);
          }}
        >
          <label className="block">
            <span className="text-xs text-gray-400">Value</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              autoFocus
            />
          </label>
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function SheetsViewerPage({
  onOpenAccountSettings,
}: {
  onOpenAccountSettings?: () => void;
}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  const [files, setFiles] = useState<DriveFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [manualId, setManualId] = useState('');

  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [meta, setMeta] = useState<SpreadsheetMeta | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [grid, setGrid] = useState<CellValue[][]>([]);
  const [valuesLoading, setValuesLoading] = useState(false);

  const [editCell, setEditCell] = useState<{ row: number; col: number; value: string } | null>(
    null,
  );
  const [savingCell, setSavingCell] = useState(false);
  const [cellError, setCellError] = useState<string | null>(null);

  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const sheetsEnabled = hasSheetsScope(status);
  const canWrite = hasSheetsWriteScope(status);
  const canList = hasDriveFileScope(status);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const body = await api.listGoogleDriveFiles({
        q: `mimeType = '${SPREADSHEET_MIME}' and trashed = false`,
        orderBy: 'modifiedTime desc',
        pageSize: 50,
      });
      setFiles(body.files || []);
    } catch (err: any) {
      setError(err.message || 'Failed to list spreadsheets');
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasSheetsScope(nextStatus) && hasDriveFileScope(nextStatus)) {
        await loadFiles();
      } else {
        setFiles([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Sheets');
    } finally {
      setLoading(false);
    }
  }, [loadFiles]);

  useEffect(() => {
    load();
  }, [load]);

  const startOAuth = async () => {
    setOauthBusy(true);
    setError(null);
    try {
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const body = await api.startGoogleOAuth({ returnTo, scopes: SHEETS_SURFACE_SCOPES });
      window.location.href = body.authorizeUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start Google consent');
      setOauthBusy(false);
    }
  };

  const loadValues = useCallback(async (spreadsheetId: string, tabTitle: string) => {
    setValuesLoading(true);
    setError(null);
    try {
      const body = await api.readGoogleSheetValues(spreadsheetId, {
        range: quoteSheetTitle(tabTitle),
      });
      setGrid((body.values || []) as CellValue[][]);
    } catch (err: any) {
      setError(err.message || 'Failed to read spreadsheet values');
      setGrid([]);
    } finally {
      setValuesLoading(false);
    }
  }, []);

  const openSpreadsheet = useCallback(
    async (id: string, name: string) => {
      const trimmedId = id.trim();
      if (!trimmedId) return;
      setSelected({ id: trimmedId, name });
      setMeta(null);
      setGrid([]);
      setActiveTab(null);
      setError(null);
      setValuesLoading(true);
      try {
        const data = (await api.getGoogleSpreadsheet(trimmedId)) as SpreadsheetMeta;
        setMeta(data);
        const firstTab = data.sheets?.find((s) => s.title)?.title || null;
        setActiveTab(firstTab);
        if (firstTab) {
          await loadValues(trimmedId, firstTab);
        } else {
          setValuesLoading(false);
        }
      } catch (err: any) {
        setError(err.message || 'Failed to open spreadsheet');
        setValuesLoading(false);
      }
    },
    [loadValues],
  );

  const selectTab = async (title: string) => {
    if (!selected) return;
    setActiveTab(title);
    await loadValues(selected.id, title);
  };

  const closeSpreadsheet = () => {
    setSelected(null);
    setMeta(null);
    setGrid([]);
    setActiveTab(null);
  };

  const saveCell = async (value: string) => {
    if (!selected || !activeTab || !editCell) return;
    setSavingCell(true);
    setCellError(null);
    try {
      await api.updateGoogleSheetValues(selected.id, {
        range: buildCellRange(activeTab, editCell.row, editCell.col),
        values: [[value]],
        valueInputOption: 'USER_ENTERED',
      });
      setEditCell(null);
      await loadValues(selected.id, activeTab);
    } catch (err: any) {
      setCellError(err.message || 'Failed to save cell');
    } finally {
      setSavingCell(false);
    }
  };

  let emptyState: {
    title: string;
    body: string;
    action: string | null;
    onAction?: () => void;
  } | null = null;
  if (!configured && !connected) {
    emptyState = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Sheets can connect.',
      action: onOpenAccountSettings ? 'Open Account settings' : null,
      onAction: onOpenAccountSettings,
    };
  } else if (!connected) {
    emptyState = {
      title: 'Connect Google to use Sheets',
      body: 'Spreadsheets stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: startOAuth,
    };
  } else if (!sheetsEnabled) {
    emptyState = {
      title: 'Enable Sheets access',
      body: `Connected as ${status?.email || 'Google account'}, but Sheets access has not been granted yet.`,
      action: 'Enable Sheets',
      onAction: startOAuth,
    };
  }

  const widestRow = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const columnCount = Math.max(widestRow, 1);

  return (
    <div className="flex-1 overflow-y-auto bg-gray-950 p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-blue-300">
              <FileSpreadsheet size={14} />
              Sheets
            </div>
            <h2 className="mt-1 text-2xl font-semibold text-white">
              {selected ? meta?.title || selected.name || 'Spreadsheet' : 'Spreadsheets'}
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              {selected
                ? 'View and edit the selected spreadsheet through the Google proxy.'
                : 'Pick a spreadsheet from your Google Drive or open one by ID.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selected ? (
              <>
                <button
                  type="button"
                  onClick={closeSpreadsheet}
                  className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
                >
                  <ChevronLeft size={14} />
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => activeTab && selected && loadValues(selected.id, activeTab)}
                  disabled={valuesLoading || !activeTab}
                  className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                >
                  <RefreshCw size={14} className={valuesLoading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </>
            ) : (
              connected &&
              sheetsEnabled &&
              canList && (
                <button
                  type="button"
                  onClick={loadFiles}
                  disabled={filesLoading}
                  className="inline-flex items-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                >
                  <RefreshCw size={14} className={filesLoading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              )
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" />
            Loading Sheets...
          </div>
        ) : emptyState ? (
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-6">
            <h3 className="text-lg font-semibold text-white">{emptyState.title}</h3>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">{emptyState.body}</p>
            {emptyState.action && (
              <button
                type="button"
                onClick={emptyState.onAction}
                disabled={oauthBusy}
                className="mt-4 inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {oauthBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ExternalLink size={14} />
                )}
                {emptyState.action}
              </button>
            )}
          </div>
        ) : selected ? (
          <div className="space-y-4">
            {meta && meta.sheets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {meta.sheets.map((tab) => (
                  <button
                    key={tab.sheetId ?? tab.title}
                    type="button"
                    onClick={() => tab.title && selectTab(tab.title)}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === tab.title
                        ? 'bg-blue-600 text-white'
                        : 'border border-gray-700 text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    {tab.title || '(untitled)'}
                  </button>
                ))}
              </div>
            )}
            {!canWrite && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                Read-only access. Re-consent with edit access from Settings -&gt; Account to change
                cells.
              </div>
            )}
            {valuesLoading ? (
              <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
                <Loader2 size={16} className="animate-spin" />
                Loading values...
              </div>
            ) : grid.length === 0 ? (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
                This sheet has no data in the loaded range.
              </div>
            ) : (
              <div className="overflow-auto rounded-lg border border-gray-800 bg-gray-900">
                <table className="min-w-full border-collapse text-sm">
                  <tbody>
                    {grid.map((row, rowIdx) => (
                      <tr key={rowIdx} className="border-b border-gray-800 last:border-b-0">
                        <td className="sticky left-0 bg-gray-950 px-2 py-1 text-right text-xs text-gray-600">
                          {rowIdx + 1}
                        </td>
                        {Array.from({ length: columnCount }).map((_, colIdx) => {
                          const raw = row[colIdx];
                          const text = raw === undefined || raw === null ? '' : String(raw);
                          return (
                            <td key={colIdx} className="border-l border-gray-800 p-0 align-top">
                              {canWrite ? (
                                <button
                                  type="button"
                                  data-testid={`sheet-cell-${rowIdx}-${colIdx}`}
                                  onClick={() =>
                                    setEditCell({ row: rowIdx, col: colIdx, value: text })
                                  }
                                  className="block h-full w-full min-w-[6rem] px-3 py-1.5 text-left text-gray-200 hover:bg-gray-800"
                                >
                                  {text || ' '}
                                </button>
                              ) : (
                                <div className="min-w-[6rem] px-3 py-1.5 text-gray-200">
                                  {text || ' '}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const id = extractSpreadsheetId(manualId);
                if (id) openSpreadsheet(id, id);
              }}
              className="flex flex-col gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 sm:flex-row sm:items-end"
            >
              <label className="block flex-1">
                <span className="text-xs text-gray-400">Open by spreadsheet ID or URL</span>
                <input
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  placeholder="1AbC...xyz"
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <button
                type="submit"
                disabled={!manualId.trim()}
                className="inline-flex items-center justify-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                <Search size={14} />
                Open
              </button>
            </form>

            {!canList ? (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
                Enable Drive access to list spreadsheets you have opened with the Hub, or open one
                by ID above.
              </div>
            ) : filesLoading ? (
              <div className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
                <Loader2 size={16} className="animate-spin" />
                Loading spreadsheets...
              </div>
            ) : files.length === 0 ? (
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-400">
                No spreadsheets found. Drive only lists files created or opened with the Hub
                (drive.file). Open one by ID above to add it.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
                {files.map((file) => (
                  <button
                    key={file.id || file.name}
                    type="button"
                    data-testid={`sheet-file-${file.id}`}
                    onClick={() => file.id && openSpreadsheet(file.id, file.name || file.id)}
                    className="flex w-full items-center gap-3 border-b border-gray-800 p-4 text-left last:border-b-0 hover:bg-gray-800/50"
                  >
                    <FileSpreadsheet size={16} className="flex-shrink-0 text-green-400" />
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-200">
                      {file.name || '(untitled)'}
                    </span>
                    {file.modifiedTime && (
                      <span className="flex-shrink-0 text-xs text-gray-500">
                        {formatDriveTime(file.modifiedTime)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {editCell && activeTab && (
        <CellEditModal
          cellLabel={`${columnLetter(editCell.col)}${editCell.row + 1}`}
          initialValue={editCell.value}
          saving={savingCell}
          error={cellError}
          onCancel={() => {
            setEditCell(null);
            setCellError(null);
          }}
          onSubmit={saveCell}
        />
      )}
    </div>
  );
}
