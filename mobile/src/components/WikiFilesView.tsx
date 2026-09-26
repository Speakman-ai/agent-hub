import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createUseLiveRef } from '@shared/hooks/useLiveRef';

const useLiveRef = createUseLiveRef({ useEffect, useRef });
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import { uploadWikiFile, shareWikiFile } from '../utils/wikiFileTransfer';
import {
  buildWikiFolderTree,
  formatWikiFileSize,
  normalizeWikiFolderInput,
  type WikiFileWire,
  type WikiFolderNode,
} from '@shared/utils/wikiFiles';

interface Props {
  projectId: string;
  onOpenPage: (slug: string) => void;
}

/** Find the tree node for a folder path, or the root when it no longer exists. */
function findFolder(root: WikiFolderNode, folderPath: string): WikiFolderNode {
  if (!folderPath) return root;
  let node = root;
  for (const segment of folderPath.split('/')) {
    const next = node.folders.find((f) => f.name === segment);
    if (!next) return node;
    node = next;
  }
  return node;
}

/**
 * Mobile Files view of the wiki: browse folders, upload documents (their text
 * is indexed into a linked wiki page for agent search/RAG), share, move, delete.
 */
export default function WikiFilesView(props: Props) {
  // One instance per project: switching projects remounts, so callbacks still
  // running for the old project (an upload batch, its refresh) cannot write
  // into the new project's list, selection, or busy state.
  return <WikiFilesForProject key={props.projectId} {...props} />;
}

function WikiFilesForProject({ projectId, onOpenPage }: Props) {
  // False once this project's view is gone; old callbacks start no new work.
  const live = useLiveRef();

  const [files, setFiles] = useState<WikiFileWire[]>([]);
  const [folder, setFolder] = useState('');
  const [uploadFolder, setUploadFolder] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<WikiFileWire | null>(null);
  const [moveTarget, setMoveTarget] = useState('');

  const [loadError, setLoadError] = useState<string | null>(null);
  // Within this project, only the newest list request may update state.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!live.current) return;
    const seq = ++loadSeq.current;
    try {
      const data = (await api.listWikiFiles(projectId)) || [];
      if (seq !== loadSeq.current) return;
      setFiles(data);
      setLoadError(null);
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      // api.ts throws one Error for HTTP and transport failures alike.
      setLoadError(`Loading files failed: ${err?.message ?? 'unknown error'}`);
    }
  }, [projectId, live]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => setUploadFolder(folder), [folder]);
  useEffect(() => setMoveTarget(selected?.folder ?? ''), [selected]);

  const tree = useMemo(() => buildWikiFolderTree(files), [files]);
  const current = findFolder(tree, folder);

  // One batch at a time: `busy` is only set after the picker returns, so a
  // quick second tap could otherwise start an overlapping batch.
  const batchInFlight = useRef(false);

  const pickAndUpload = async () => {
    if (batchInFlight.current) return;
    batchInFlight.current = true;
    try {
      await runUploadBatch();
    } finally {
      batchInFlight.current = false;
    }
  };

  const runUploadBatch = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const target = normalizeWikiFolderInput(uploadFolder);
    const failures: string[] = [];
    for (const asset of result.assets || []) {
      setBusy(`Uploading ${asset.name}…`);
      try {
        await uploadWikiFile(projectId, target, { uri: asset.uri, name: asset.name });
      } catch (err: any) {
        failures.push(`${asset.name}: ${err.message}`);
      }
    }
    setBusy(null);
    setFolder(target);
    load();
    if (failures.length) Alert.alert('Some uploads failed', failures.join('\n'));
  };

  const move = async (file: WikiFileWire) => {
    try {
      const moved = await api.moveWikiFile(
        projectId,
        file.id,
        normalizeWikiFolderInput(moveTarget),
      );
      setSelected(null);
      setFolder(moved.folder ?? '');
      load();
    } catch (err: any) {
      Alert.alert('Move failed', err.message);
    }
  };

  const remove = (file: WikiFileWire) => {
    Alert.alert('Delete file', `Delete "${file.filename}" and its indexed text?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteWikiFile(projectId, file.id);
            setSelected(null);
            load();
          } catch (err: any) {
            Alert.alert('Delete failed', err.message);
          }
        },
      },
    ]);
  };

  const share = async (file: WikiFileWire) => {
    try {
      setBusy('Downloading…');
      await shareWikiFile(projectId, file);
    } catch (err: any) {
      Alert.alert('Download failed', err.message);
    } finally {
      setBusy(null);
    }
  };

  const crumbs = folder ? folder.split('/') : [];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
      <View style={styles.crumbs}>
        <TouchableOpacity onPress={() => setFolder('')}>
          <Text style={styles.crumb}>All files</Text>
        </TouchableOpacity>
        {crumbs.map((c, i) => (
          <TouchableOpacity key={i} onPress={() => setFolder(crumbs.slice(0, i + 1).join('/'))}>
            <Text style={styles.crumb}> / {c}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {current.folders.map((f) => (
        <TouchableOpacity key={f.path} style={styles.row} onPress={() => setFolder(f.path)}>
          <Text style={styles.folderIcon}>{'\u{1F4C1}'}</Text>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {f.name}
          </Text>
          <Text style={styles.meta}>{f.totalFiles}</Text>
        </TouchableOpacity>
      ))}

      {current.files.map((f) => (
        <View key={f.id}>
          <TouchableOpacity
            style={[styles.row, selected?.id === f.id && styles.rowSelected]}
            onPress={() => setSelected(selected?.id === f.id ? null : f)}
          >
            <Text style={styles.folderIcon}>{'\u{1F4C4}'}</Text>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {f.filename}
            </Text>
            <Text style={styles.meta}>{formatWikiFileSize(f.size_bytes)}</Text>
          </TouchableOpacity>
          {selected?.id === f.id && (
            <View style={styles.detail}>
              <Text style={styles.meta}>
                {f.page_slug
                  ? `${f.extracted_chars.toLocaleString()} chars indexed${f.truncated ? ' (truncated)' : ''}`
                  : 'Not indexed. Re-upload to index it again.'}
              </Text>
              <View style={styles.actions}>
                {f.page_slug && (
                  <TouchableOpacity style={styles.button} onPress={() => onOpenPage(f.page_slug!)}>
                    <Text style={styles.buttonText}>View text</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.button} onPress={() => share(f)}>
                  <Text style={styles.buttonText}>Share</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.button} onPress={() => remove(f)}>
                  <Text style={[styles.buttonText, { color: colors.red400 }]}>Delete</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.actions}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={moveTarget}
                  onChangeText={setMoveTarget}
                  placeholder="Move to folder (blank for root)"
                  placeholderTextColor={colors.gray600}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  style={styles.button}
                  onPress={() => move(f)}
                  disabled={normalizeWikiFolderInput(moveTarget) === f.folder}
                >
                  <Text style={styles.buttonText}>Move</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      ))}

      {loadError && <Text style={styles.error}>{loadError}</Text>}

      {files.length === 0 && !loadError && (
        <Text style={styles.empty}>
          No files yet. Upload SOPs, runbooks, and reference docs; agents find them through wiki
          search.
        </Text>
      )}

      <View style={styles.uploadBox}>
        <Text style={styles.uploadTitle}>Upload documents</Text>
        <Text style={styles.meta}>
          PDF, DOCX, Markdown, HTML, text, CSV, JSON, YAML. Same name in the same folder replaces
          the file.
        </Text>
        <TextInput
          style={styles.input}
          value={uploadFolder}
          onChangeText={setUploadFolder}
          placeholder="Folder, e.g. SOPs/Safety (blank for root)"
          placeholderTextColor={colors.gray600}
          autoCapitalize="none"
        />
        <TouchableOpacity
          style={[styles.primary, busy ? { opacity: 0.6 } : null]}
          onPress={pickAndUpload}
          disabled={!!busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Text style={styles.primaryText}>Choose files</Text>
          )}
        </TouchableOpacity>
        {busy && <Text style={styles.meta}>{busy}</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  crumbs: { flexDirection: 'row', flexWrap: 'wrap' },
  crumb: { color: colors.blue400, fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.gray900,
    borderRadius: 8,
  },
  rowSelected: { backgroundColor: colors.gray800 },
  folderIcon: { fontSize: 16 },
  rowTitle: { flex: 1, color: colors.gray200, fontSize: 15 },
  meta: { color: colors.gray500, fontSize: 12 },
  detail: { padding: 12, gap: 8, backgroundColor: colors.gray900, borderRadius: 8, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  button: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.gray800,
    borderRadius: 8,
  },
  buttonText: { color: colors.gray200, fontSize: 13 },
  input: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.gray200,
    fontSize: 14,
  },
  error: { color: colors.red400, fontSize: 13 },
  empty: { color: colors.gray500, fontSize: 14, textAlign: 'center', paddingVertical: 16 },
  uploadBox: {
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderStyle: 'dashed',
    borderRadius: 10,
  },
  uploadTitle: { color: colors.white, fontSize: 15, fontWeight: '600' },
  primary: {
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryText: { color: colors.white, fontWeight: '600' },
});
