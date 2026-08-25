import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../../utils/api';
import { colors } from '../../theme/colors';
import { getApiBaseUrl, getAuthHeaders } from '../../utils/config';
import { hasRole } from '../../utils/auth';

interface ProjectEmailLogo {
  filename: string;
  contentType: string;
  size: number;
  updatedAt: string;
}

/**
 * Mobile mirror of the web `ProjectEmailLogoSection`. Admin-gated control to
 * upload a per-project logo that overrides the global Agent Hub logo in this
 * project's release/deployment notification emails.
 */
export default function ProjectEmailLogoSection({ projectId }: { projectId?: string | null }) {
  const [logo, setLogo] = useState<ProjectEmailLogo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const canEdit = hasRole('Admin');
  // Monotonic request generation. Every intent that changes the displayed logo
  // (project switch, load, upload, remove) claims a new value; async results
  // commit only while their generation is still latest, so out-of-order
  // completions (even for the same project) can never win.
  const requestRef = useRef(0);

  // ── One root cause: this component instance is reused across projects (the
  // `projectId` prop changes on navigation), so it must (1) never render a
  // previous project's state and (2) never let a previous project's async op
  // write into the current one. Both are handled synchronously against the
  // rendered prop.

  // (1) Reset ALL project-bound state synchronously when the identity changes —
  // during render, before commit — so project B never shows project A's logo or
  // controls while B's request is still pending. React's supported "adjust
  // state when a prop changes" pattern (the extra render is discarded). Clearing
  // `logo` also clears the derived preview (previewUri below).
  const [boundProjectId, setBoundProjectId] = useState<string | null | undefined>(projectId);
  if (projectId !== boundProjectId) {
    setBoundProjectId(projectId);
    setLogo(null);
    setBusy(false);
    setError(null);
    setLoading(false);
    setPreviewHtml(null);
    setPreviewLoading(false);
    requestRef.current += 1; // invalidate any in-flight load for the old project
  }

  // (2) The current identity, updated synchronously during render, so an async
  // completion can check whether it is still current before writing state.
  const activeProjectRef = useRef<string | null | undefined>(projectId);
  activeProjectRef.current = projectId;
  const isActive = useCallback(
    (id: string | null | undefined) => activeProjectRef.current === id,
    [],
  );

  useEffect(() => {
    if (!projectId) return undefined;
    const gen = (requestRef.current += 1);
    setLoading(true);
    api
      .getProjectEmailLogo(projectId)
      .then((res: any) => {
        if (gen === requestRef.current) setLogo(res?.emailLogo ?? null);
      })
      .catch((err: any) => {
        if (gen === requestRef.current) setError(err?.message || 'Failed to load logo.');
      })
      .finally(() => {
        if (gen === requestRef.current) setLoading(false);
      });
    return undefined;
  }, [projectId]);

  const handlePick = useCallback(async () => {
    const id = projectId;
    if (!id || busy) return;
    // Claim the generation at intent start (before ANY await, matching web), so
    // an ABA switch (p1 -> p2 -> p1) during the interactive picker can't let
    // this stale interaction pass a later identity check and upload/commit over
    // newer state. Require BOTH the generation and the identity to remain
    // current after every await.
    const gen = (requestRef.current += 1);
    setError(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (gen !== requestRef.current || !isActive(id)) return;
    if (!perm.granted) {
      setError('Photo library permission is required.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 1,
    });
    if (gen !== requestRef.current || !isActive(id)) return;
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    const mime = asset.mimeType || 'image/png';
    setBusy(true);
    try {
      const res = await api.updateProjectEmailLogo(id, `data:${mime};base64,${asset.base64}`);
      if (gen === requestRef.current && isActive(id)) setLogo(res.emailLogo);
    } catch (err: any) {
      if (gen === requestRef.current && isActive(id))
        setError(err?.message || 'Failed to upload logo.');
    } finally {
      if (gen === requestRef.current && isActive(id)) setBusy(false);
    }
  }, [projectId, busy, isActive]);

  const handleRemove = useCallback(async () => {
    const id = projectId;
    if (!id || busy) return;
    // Claim the generation before the async work (see handlePick).
    const gen = (requestRef.current += 1);
    setBusy(true);
    setError(null);
    try {
      await api.deleteProjectEmailLogo(id);
      if (gen === requestRef.current && isActive(id)) setLogo(null);
    } catch (err: any) {
      if (gen === requestRef.current && isActive(id))
        setError(err?.message || 'Failed to remove logo.');
    } finally {
      if (gen === requestRef.current && isActive(id)) setBusy(false);
    }
  }, [projectId, busy, isActive]);

  const handlePreview = useCallback(async () => {
    const id = projectId;
    if (!id || previewLoading) return;
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await api.getReleaseEmailPreview(id);
      if (isActive(id)) setPreviewHtml(res.html);
    } catch (err: any) {
      if (isActive(id)) setError(err?.message || 'Failed to load email preview.');
    } finally {
      if (isActive(id)) setPreviewLoading(false);
    }
  }, [projectId, previewLoading, isActive]);

  const previewUri = logo
    ? `${getApiBaseUrl()}/projects/${projectId}/email-logo/raw?v=${encodeURIComponent(logo.updatedAt)}`
    : null;

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Email logo</Text>
        {(loading || busy) && <ActivityIndicator color={colors.gray400} size="small" />}
      </View>
      <Text style={styles.subtitle}>
        Overrides the default Agent Hub logo in this project's release and deployment notification
        emails. PNG, JPEG, GIF, or WebP, up to 2MB.
      </Text>

      <View style={styles.previewBox}>
        {previewUri ? (
          <Image
            source={{ uri: previewUri, headers: getAuthHeaders() as Record<string, string> }}
            style={styles.preview}
            resizeMode="contain"
          />
        ) : (
          <Text style={styles.placeholder}>Default logo</Text>
        )}
      </View>

      {canEdit ? (
        <View style={styles.buttonRow}>
          <TouchableOpacity
            testID="project-email-logo-upload"
            style={styles.primaryBtn}
            onPress={handlePick}
            disabled={busy}
          >
            <Text style={styles.primaryBtnText}>{logo ? 'Replace' : 'Upload'}</Text>
          </TouchableOpacity>
          {logo && (
            <TouchableOpacity
              testID="project-email-logo-remove"
              style={styles.secondaryBtn}
              onPress={handleRemove}
              disabled={busy}
            >
              <Text style={styles.secondaryBtnText}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <Text style={styles.note}>Admin role required to change the email logo.</Text>
      )}

      <TouchableOpacity
        testID="project-email-logo-preview"
        style={[styles.secondaryBtn, styles.previewBtn]}
        onPress={handlePreview}
        disabled={previewLoading || !projectId}
      >
        {previewLoading ? (
          <ActivityIndicator color={colors.gray300} size="small" />
        ) : (
          <Text style={styles.secondaryBtnText}>Preview email</Text>
        )}
      </TouchableOpacity>

      {error && <Text style={styles.error}>{error}</Text>}

      <Modal
        visible={previewHtml !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setPreviewHtml(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Email preview</Text>
              <TouchableOpacity onPress={() => setPreviewHtml(null)}>
                <Text style={styles.modalClose}>Close</Text>
              </TouchableOpacity>
            </View>
            {previewHtml !== null && (
              <WebView
                originWhitelist={['*']}
                source={{ html: previewHtml }}
                style={styles.webview}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 14, color: colors.gray200, fontWeight: '600' },
  subtitle: { fontSize: 12, color: colors.gray500, marginTop: 4, marginBottom: 10, lineHeight: 16 },
  previewBox: {
    width: 160,
    height: 64,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  preview: { width: '100%', height: '100%' },
  placeholder: { fontSize: 11, color: colors.gray600 },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  primaryBtn: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  primaryBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  secondaryBtnText: { color: colors.gray300, fontSize: 13 },
  previewBtn: { alignSelf: 'flex-start', marginTop: 10 },
  note: { fontSize: 12, color: colors.gray600, marginTop: 8 },
  error: { fontSize: 12, color: '#fca5a5', marginTop: 8 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    flex: 1,
    marginVertical: 40,
    backgroundColor: colors.gray900,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.gray700,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray700,
  },
  modalTitle: { fontSize: 14, color: colors.gray200, fontWeight: '600' },
  modalClose: { fontSize: 14, color: colors.blue400 },
  webview: { flex: 1, backgroundColor: '#fff' },
});
