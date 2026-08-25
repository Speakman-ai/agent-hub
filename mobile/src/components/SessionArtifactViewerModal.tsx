import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PdfView } from '@kishannareshpal/expo-pdf';
import Markdown from 'react-native-markdown-display';
import { artifactRenderKind } from '@shared/utils/artifactView';
import AppIcon from './AppIcon';
import { loadArtifactPreview, shareArtifact } from '../utils/artifactContent';
import { colors } from '../theme/colors';

function rendererErrorMessage(kind: 'image' | 'pdf', event: any) {
  const detail = kind === 'image' ? event?.nativeEvent?.error : event?.message;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  return kind === 'pdf' ? 'Failed to display PDF.' : 'Failed to display image.';
}

export function SessionArtifactViewerContent({
  artifact,
  kind,
  resource,
  loading,
  error,
  onRenderError,
}: any) {
  if (loading) {
    return (
      <View style={styles.center} testID="session-artifact-viewer-loading">
        <ActivityIndicator color={colors.purple400} />
        <Text style={styles.muted}>Loading document…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.center} testID="session-artifact-viewer-error">
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (kind === 'image') {
    return (
      <Image
        source={{ uri: resource?.uri }}
        resizeMode="contain"
        style={styles.image}
        accessibilityLabel={artifact?.filename || 'Artifact image'}
        testID="session-artifact-viewer-image"
        onError={(event) => onRenderError?.(rendererErrorMessage('image', event))}
      />
    );
  }
  if (kind === 'pdf') {
    return (
      <PdfView
        uri={resource?.uri}
        style={styles.pdf}
        fitMode="width"
        doubleTapToZoom
        testID="session-artifact-viewer-pdf"
        onError={(event) => onRenderError?.(rendererErrorMessage('pdf', event))}
      />
    );
  }
  if (kind === 'markdown') {
    return (
      <ScrollView style={styles.document} contentContainerStyle={styles.documentContent}>
        <Markdown style={markdownStyles}>{resource?.text || ''}</Markdown>
      </ScrollView>
    );
  }
  return (
    <ScrollView style={styles.document} contentContainerStyle={styles.documentContent}>
      <Text selectable style={styles.plainText} testID="session-artifact-viewer-text">
        {resource?.text || ''}
      </Text>
    </ScrollView>
  );
}

export default function SessionArtifactViewerModal({ sessionId, artifact, onClose }: any) {
  const kind = artifactRenderKind(artifact?.contentType, artifact?.filename);
  const [state, setState] = useState<any>({ loading: false, resource: null, error: '' });

  const handleRenderError = useCallback((message: string) => {
    setState((prev: any) => ({
      ...prev,
      loading: false,
      error: message || 'Failed to display artifact.',
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!artifact?.id || !kind) {
      setState({ loading: false, resource: null, error: '' });
      return () => undefined;
    }
    setState({ loading: true, resource: null, error: '' });
    loadArtifactPreview(sessionId, artifact)
      .then((resource) => {
        if (!cancelled) setState({ loading: false, resource, error: '' });
      })
      .catch((err: any) => {
        if (!cancelled) {
          setState({
            loading: false,
            resource: null,
            error: err?.message || 'Failed to open artifact',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifact, kind, sessionId]);

  const handleDownload = async () => {
    try {
      await shareArtifact(sessionId, artifact, { download: true });
    } catch (err: any) {
      setState((prev: any) => ({ ...prev, error: err?.message || 'Failed to download artifact' }));
    }
  };

  return (
    <Modal visible={Boolean(artifact)} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close artifact viewer"
            testID="session-artifact-viewer-close"
            style={styles.headerButton}
          >
            <AppIcon name="arrow-back-outline" size={20} color={colors.gray200} />
          </TouchableOpacity>
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {artifact?.filename || 'Artifact'}
            </Text>
            <Text style={styles.subtitle}>Artifact preview</Text>
          </View>
          <TouchableOpacity
            onPress={handleDownload}
            accessibilityRole="button"
            accessibilityLabel={`Download ${artifact?.filename || 'artifact'}`}
            style={styles.headerButton}
          >
            <AppIcon name="download-outline" size={20} color={colors.purple400} />
          </TouchableOpacity>
        </View>
        <View style={styles.body}>
          <SessionArtifactViewerContent
            artifact={artifact}
            kind={kind}
            {...state}
            onRenderError={handleRenderError}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.gray950 },
  header: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  headerButton: { padding: 10 },
  titleWrap: { flex: 1 },
  title: { color: colors.gray100, fontSize: 14, fontWeight: '700' },
  subtitle: { color: colors.gray500, fontSize: 10, marginTop: 1 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  muted: { color: colors.gray400, fontSize: 13 },
  error: { color: colors.red400, fontSize: 13, textAlign: 'center' },
  image: { flex: 1, width: '100%', backgroundColor: colors.gray950 },
  pdf: { flex: 1, backgroundColor: colors.gray950 },
  document: { flex: 1 },
  documentContent: { padding: 18 },
  plainText: { color: colors.gray200, fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
});

const markdownStyles = {
  body: { color: colors.gray200, fontSize: 14, lineHeight: 21 },
  heading1: { color: colors.gray100 },
  heading2: { color: colors.gray100 },
  heading3: { color: colors.gray100 },
  code_inline: { color: colors.purple400, backgroundColor: colors.gray900 },
  fence: { color: colors.gray200, backgroundColor: colors.gray900 },
  link: { color: colors.purple400 },
};
