import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  SHEETS_SURFACE_SCOPES,
  hasSheetsScope,
  hasSheetsWriteScope,
  hasDriveFileScope,
} from '../utils/googleSurface';

export { SHEETS_SURFACE_SCOPES };

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** Sheets is a global, per-user surface — the return hash carries no project. */
export function sheetsReturnTo() {
  return '/#/sheets';
}

export async function openSheetsOAuth({ apiClient, openURL }: any) {
  const body = await apiClient.startGoogleOAuth({
    returnTo: sheetsReturnTo(),
    scopes: SHEETS_SURFACE_SCOPES,
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

/** Convert a zero-based column index into its A1 letters (0 -> A, 26 -> AA). */
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
  if (/^[a-zA-Z0-9-_]+$/.test(raw)) return raw;
  const path = raw.split(/[?#]/)[0];
  const segment = path.split('/').filter(Boolean).pop() || '';
  return /^[a-zA-Z0-9-_]+$/.test(segment) ? segment : raw;
}

function CellEditModal({ cellLabel, initialValue, saving, error, onClose, onSave }: any) {
  const [value, setValue] = useState(String(initialValue ?? ''));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Edit cell {cellLabel}</Text>
          <Text style={styles.inputLabel}>Value</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            style={styles.input}
            placeholderTextColor={colors.gray500}
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={saving}
              onPress={() => onSave(value)}
              style={[styles.primaryButton, saving && styles.disabledButton]}
            >
              <Text style={styles.primaryButtonText}>{saving ? 'Saving' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function SheetsContent({
  loading,
  status,
  error,
  files,
  filesLoading,
  manualId,
  onChangeManualId,
  onOpenManual,
  onOpenFile,
  onRefreshFiles,
  onConnect,
  onOpenSettings,
  selected,
  meta,
  activeTab,
  grid,
  valuesLoading,
  canWrite,
  canList,
  onSelectTab,
  onBack,
  onRefreshValues,
  onEditCell,
}: any) {
  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const sheetsEnabled = hasSheetsScope(status);

  if (loading) {
    return (
      <View style={styles.centerCard}>
        <ActivityIndicator color={colors.blue400} />
        <Text style={styles.muted}>Loading Sheets...</Text>
      </View>
    );
  }

  let empty: any = null;
  if (!configured && !connected) {
    empty = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Sheets can connect.',
      action: 'Open Account settings',
      onAction: onOpenSettings,
    };
  } else if (!connected) {
    empty = {
      title: 'Connect Google to use Sheets',
      body: 'Spreadsheets stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: onConnect,
    };
  } else if (!sheetsEnabled) {
    empty = {
      title: 'Enable Sheets access',
      body: `Connected as ${status?.email || 'Google account'}, but Sheets access has not been granted yet.`,
      action: 'Enable Sheets',
      onAction: onConnect,
    };
  }

  if (empty) {
    return (
      <View style={styles.content}>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{empty.title}</Text>
          <Text style={styles.emptyBody}>{empty.body}</Text>
          {empty.action ? (
            <TouchableOpacity onPress={empty.onAction} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{empty.action}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  // Spreadsheet open: show tabs + value grid. Render a rectangular grid (every
  // row padded to the widest row's width) so blank cells in existing columns
  // remain visible and editable, matching the web viewer.
  if (selected) {
    const columnCount = (grid || []).reduce(
      (max: number, row: any[]) => Math.max(max, row?.length || 0),
      0,
    );
    return (
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>Sheets</Text>
            <Text style={styles.title} numberOfLines={1}>
              {meta?.title || selected.name || 'Spreadsheet'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={onBack} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onRefreshValues} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>
                {valuesLoading ? 'Refreshing' : 'Refresh'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {meta?.sheets?.length ? (
          <View style={styles.tabRow}>
            {meta.sheets.map((tab: any) => (
              <TouchableOpacity
                key={tab.sheetId ?? tab.title}
                testID={`sheet-tab-${tab.title}`}
                onPress={() => tab.title && onSelectTab(tab.title)}
                style={[styles.tab, activeTab === tab.title && styles.tabActive]}
              >
                <Text style={[styles.tabText, activeTab === tab.title && styles.tabTextActive]}>
                  {tab.title || '(untitled)'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
        {!canWrite ? (
          <Text style={styles.readonlyNote}>
            Read-only access. Re-consent with edit access from Settings to change cells.
          </Text>
        ) : null}
        {valuesLoading ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.blue400} />
            <Text style={styles.muted}>Loading values...</Text>
          </View>
        ) : !grid?.length ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyBody}>This sheet has no data in the loaded range.</Text>
          </View>
        ) : (
          <ScrollView horizontal>
            <ScrollView>
              <View>
                {grid.map((row: any[], rowIdx: number) => (
                  <View key={rowIdx} style={styles.gridRow}>
                    <View style={styles.rowHeader}>
                      <Text style={styles.rowHeaderText}>{rowIdx + 1}</Text>
                    </View>
                    {Array.from({ length: columnCount }).map((_, colIdx: number) => {
                      const cell = row[colIdx];
                      const text = cell === undefined || cell === null ? '' : String(cell);
                      return canWrite ? (
                        <TouchableOpacity
                          key={colIdx}
                          testID={`sheet-cell-${rowIdx}-${colIdx}`}
                          style={styles.cell}
                          onPress={() => onEditCell(rowIdx, colIdx, text)}
                        >
                          <Text style={styles.cellText}>{text}</Text>
                        </TouchableOpacity>
                      ) : (
                        <View key={colIdx} style={styles.cell}>
                          <Text style={styles.cellText}>{text}</Text>
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
          </ScrollView>
        )}
      </View>
    );
  }

  // Picker: manual ID entry + Drive-backed spreadsheet list.
  return (
    <View style={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Sheets</Text>
          <Text style={styles.title}>Spreadsheets</Text>
        </View>
        {canList ? (
          <TouchableOpacity onPress={onRefreshFiles} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>
              {filesLoading ? 'Refreshing' : 'Refresh'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.manualCard}>
        <Text style={styles.inputLabel}>Open by spreadsheet ID or URL</Text>
        <TextInput
          value={manualId}
          onChangeText={onChangeManualId}
          placeholder="1AbC...xyz"
          placeholderTextColor={colors.gray500}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          disabled={!manualId?.trim()}
          onPress={onOpenManual}
          style={[styles.primaryButton, !manualId?.trim() && styles.disabledButton]}
        >
          <Text style={styles.primaryButtonText}>Open</Text>
        </TouchableOpacity>
      </View>
      {!canList ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyBody}>
            Enable Drive access to list spreadsheets you have opened with the Hub, or open one by ID
            above.
          </Text>
        </View>
      ) : filesLoading ? (
        <View style={styles.centerCard}>
          <ActivityIndicator color={colors.blue400} />
          <Text style={styles.muted}>Loading spreadsheets...</Text>
        </View>
      ) : !files?.length ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyBody}>
            No spreadsheets found. Drive only lists files created or opened with the Hub
            (drive.file). Open one by ID above to add it.
          </Text>
        </View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item: any, index) => item.id || `${item.name}-${index}`}
          renderItem={({ item }: any) => (
            <TouchableOpacity
              testID={`sheet-file-${item.id}`}
              onPress={() => item.id && onOpenFile(item)}
              style={styles.fileCard}
            >
              <Text style={styles.fileName} numberOfLines={1}>
                {item.name || '(untitled)'}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

export default function SheetsScreen({ navigation }: any) {
  const sidebar = React.useContext(SidebarContext);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);

  const [files, setFiles] = useState<any[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [manualId, setManualId] = useState('');

  const [selected, setSelected] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<any>(null);
  const [grid, setGrid] = useState<any[]>([]);
  const [valuesLoading, setValuesLoading] = useState(false);

  const [editCell, setEditCell] = useState<any>(null);
  const [savingCell, setSavingCell] = useState(false);
  const [cellError, setCellError] = useState<any>(null);

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

  const connect = async () => {
    try {
      await openSheetsOAuth({ apiClient: api, openURL: Linking.openURL });
    } catch (err: any) {
      Alert.alert('Google Sheets', err.message || 'Failed to start Google consent');
    }
  };

  const loadValues = useCallback(async (spreadsheetId: string, tabTitle: string) => {
    setValuesLoading(true);
    setError(null);
    try {
      const body = await api.readGoogleSheetValues(spreadsheetId, {
        range: quoteSheetTitle(tabTitle),
      });
      setGrid(body.values || []);
    } catch (err: any) {
      setError(err.message || 'Failed to read spreadsheet values');
      setGrid([]);
    } finally {
      setValuesLoading(false);
    }
  }, []);

  const openSpreadsheet = useCallback(
    async (id: string, name: string) => {
      const trimmedId = String(id || '').trim();
      if (!trimmedId) return;
      setSelected({ id: trimmedId, name });
      setMeta(null);
      setGrid([]);
      setActiveTab(null);
      setError(null);
      setValuesLoading(true);
      try {
        const data = await api.getGoogleSpreadsheet(trimmedId);
        setMeta(data);
        const firstTab = data.sheets?.find((s: any) => s.title)?.title || null;
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

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={sidebar?.toggleSidebar} style={styles.menuButton}>
          <Text style={styles.menuButtonText}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Sheets</Text>
      </View>
      <SheetsContent
        loading={loading}
        status={status}
        error={error}
        files={files}
        filesLoading={filesLoading}
        manualId={manualId}
        onChangeManualId={setManualId}
        onOpenManual={() => {
          const id = extractSpreadsheetId(manualId);
          if (id) openSpreadsheet(id, id);
        }}
        onOpenFile={(file: any) => openSpreadsheet(file.id, file.name || file.id)}
        onRefreshFiles={loadFiles}
        onConnect={connect}
        onOpenSettings={() => navigation.navigate('Settings', { tab: 'account' })}
        selected={selected}
        meta={meta}
        activeTab={activeTab}
        grid={grid}
        valuesLoading={valuesLoading}
        canWrite={canWrite}
        canList={canList}
        onSelectTab={selectTab}
        onBack={() => {
          setSelected(null);
          setMeta(null);
          setGrid([]);
          setActiveTab(null);
        }}
        onRefreshValues={() => activeTab && selected && loadValues(selected.id, activeTab)}
        onEditCell={(row: number, col: number, value: string) => setEditCell({ row, col, value })}
      />
      {editCell && activeTab ? (
        <CellEditModal
          cellLabel={`${columnLetter(editCell.col)}${editCell.row + 1}`}
          initialValue={editCell.value}
          saving={savingCell}
          error={cellError}
          onClose={() => {
            setEditCell(null);
            setCellError(null);
          }}
          onSave={saveCell}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  menuButton: { padding: 8, marginRight: 8 },
  menuButtonText: { color: colors.gray300, fontSize: 20 },
  topBarTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  content: { flex: 1, padding: 16 },
  centerCard: {
    margin: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
  },
  muted: { color: colors.gray400, fontSize: 13 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  kicker: { color: colors.blue300, fontSize: 11, textTransform: 'uppercase', fontWeight: '700' },
  title: { color: colors.white, fontSize: 26, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 8 },
  primaryButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  secondaryButtonText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  disabledButton: { opacity: 0.5 },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 10 },
  emptyCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 18,
    gap: 10,
  },
  emptyTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  emptyBody: { color: colors.gray400, fontSize: 13, lineHeight: 19 },
  manualCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 14,
    gap: 8,
    marginBottom: 12,
  },
  fileCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  fileName: { color: colors.white, fontSize: 15, fontWeight: '600' },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  tab: { borderWidth: 1, borderColor: colors.gray700, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  tabActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  tabText: { color: colors.gray300, fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: colors.white },
  readonlyNote: { color: colors.amber400, fontSize: 12, marginBottom: 8 },
  gridRow: { flexDirection: 'row' },
  rowHeader: {
    minWidth: 36,
    paddingHorizontal: 6,
    paddingVertical: 8,
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray800,
  },
  rowHeaderText: { color: colors.gray600, fontSize: 11, textAlign: 'right' },
  cell: {
    minWidth: 96,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  cellText: { color: colors.gray200, fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: colors.black60, justifyContent: 'center', padding: 16 },
  modalCard: {
    maxHeight: '90%',
    borderRadius: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 16,
  },
  modalTitle: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 14 },
  inputLabel: { color: colors.gray400, fontSize: 12, marginBottom: 6, marginTop: 8 },
  input: {
    color: colors.white,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
});
