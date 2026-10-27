import React, { useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { artifactRenderKind, isGenericArtifactType } from '@shared/utils/artifactView';
import { colors } from '../theme/colors';
import { buildArtifactContentUrl } from '../utils/artifactContent';
import { getApiBaseUrl, getAuthHeaders } from '../utils/config';
import {
  orderRunResults,
  VERDICT_COLORS,
  VERDICT_LABELS,
  type QaCase,
  type QaRun,
  type QaScreenshot,
} from '../utils/qa';
import SessionArtifactViewerModal from './SessionArtifactViewerModal';

function ScreenshotThumb({
  sessionId,
  shot,
  onOpen,
}: {
  sessionId: string;
  shot: QaScreenshot;
  onOpen: (contentType: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const base = getApiBaseUrl();
  // Screenshots uploaded from a host without `file` were stored as generic
  // `.dat` blobs; the content route sniffs their bytes, so try those as images
  // too and fall back to the filename tile on error.
  const generic = isGenericArtifactType(shot.contentType);
  const isImage = artifactRenderKind(shot.contentType, shot.filename) === 'image' || generic;
  const uri = base ? buildArtifactContentUrl(base, sessionId, shot.id) : '';
  // The viewer only needs a raster image type to pick its image renderer.
  const openType = generic && loaded ? 'image/png' : shot.contentType;
  return (
    <TouchableOpacity
      onPress={() => onOpen(openType)}
      style={styles.thumb}
      accessibilityLabel={shot.filename}
      testID={`qa-screenshot-${shot.id}`}
    >
      {isImage && uri && !failed ? (
        <Image
          source={{ uri, headers: getAuthHeaders() as Record<string, string> }}
          style={styles.thumbImage}
          resizeMode="cover"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <Text style={styles.thumbName} numberOfLines={2}>
          {shot.filename}
        </Text>
      )}
    </TouchableOpacity>
  );
}

/** Screenshot strip for one result; tapping opens the session artifact viewer. */
export function QaScreenshotGallery({
  sessionId,
  screenshots,
}: {
  sessionId: string | null;
  screenshots: QaScreenshot[];
}) {
  const [open, setOpen] = useState<QaScreenshot | null>(null);
  if (!sessionId || screenshots.length === 0) return null;
  return (
    <>
      <ScrollView horizontal contentContainerStyle={styles.gallery} testID="qa-screenshot-gallery">
        {screenshots.map((shot) => (
          <ScreenshotThumb
            key={shot.id}
            sessionId={sessionId}
            shot={shot}
            onOpen={(contentType) => setOpen({ ...shot, contentType })}
          />
        ))}
      </ScrollView>
      {open && (
        <SessionArtifactViewerModal
          sessionId={sessionId}
          artifact={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function Field({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {text.trim() ? (
        <Text style={styles.fieldText}>{text}</Text>
      ) : (
        <Text style={styles.fieldEmpty}>None recorded</Text>
      )}
    </View>
  );
}

/** Verdicts that get a Troubleshoot button; matches the server's rule. */
export const TROUBLESHOOT_VERDICTS: ReadonlySet<string> = new Set([
  'fail',
  'needs_change',
  'blocked',
]);

export default function QaRunResults({
  run,
  cases,
  onOpenCard,
  onTroubleshoot,
}: {
  run: Pick<QaRun, 'id' | 'sessionId' | 'results'>;
  cases: Pick<QaCase, 'id' | 'title' | 'expected' | 'version'>[];
  onOpenCard?: (cardId: string) => void;
  /** Opens a dev session seeded with this result; rejects with the error to show. */
  onTroubleshoot?: (caseId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const rows = orderRunResults(run.results ?? [], cases);

  const troubleshoot = async (caseId: string) => {
    if (!onTroubleshoot || pending) return;
    setPending(caseId);
    setErrors(({ [caseId]: _drop, ...rest }) => rest);
    try {
      await onTroubleshoot(caseId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to open a troubleshoot session';
      setErrors((cur) => ({ ...cur, [caseId]: message }));
    } finally {
      setPending(null);
    }
  };

  if (rows.length === 0) {
    return (
      <Text style={styles.empty} testID="qa-run-results-empty">
        No results recorded yet.
      </Text>
    );
  }
  return (
    <View testID={`qa-run-results-${run.id}`}>
      {rows.map(({ result, qaCase }) => {
        const canTroubleshoot =
          !!onTroubleshoot && !!qaCase && TROUBLESHOOT_VERDICTS.has(result.verdict);
        return (
          <View key={result.id} style={styles.result} testID={`qa-result-${result.caseId}`}>
            <View style={styles.resultHead}>
              <Text style={styles.resultTitle}>
                {qaCase?.title ?? `Deleted case ${result.caseId}`}
              </Text>
              <Text style={[styles.verdict, { color: VERDICT_COLORS[result.verdict] }]}>
                {VERDICT_LABELS[result.verdict]}
              </Text>
              {qaCase && result.caseVersion !== qaCase.version ? (
                <Text style={styles.muted}>recorded against v{result.caseVersion}</Text>
              ) : null}
              {canTroubleshoot ? (
                <TouchableOpacity
                  testID="qa-result-troubleshoot"
                  accessibilityLabel="Troubleshoot in a dev session"
                  disabled={pending !== null}
                  onPress={() => void troubleshoot(result.caseId)}
                  style={[styles.troubleshootChip, pending !== null && styles.disabled]}
                >
                  <Text style={styles.troubleshootText}>
                    {pending === result.caseId ? 'Opening…' : 'Troubleshoot'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {result.findingCardId ? (
                <TouchableOpacity
                  testID="qa-result-finding"
                  disabled={!onOpenCard}
                  onPress={() => onOpenCard?.(result.findingCardId!)}
                  style={[styles.findingChip, canTroubleshoot && styles.noAutoMargin]}
                >
                  <Text style={styles.findingText}>Finding card</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {errors[result.caseId] ? (
              <Text style={styles.error} testID="qa-result-troubleshoot-error">
                {errors[result.caseId]}
              </Text>
            ) : null}
            <Field label="Expected" text={qaCase?.expected ?? ''} />
            <Field label="Actual" text={result.actual} />
            {result.notes.trim() ? <Field label="Notes" text={result.notes} /> : null}
            <QaScreenshotGallery sessionId={run.sessionId} screenshots={result.screenshots} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 12, color: colors.gray500, paddingHorizontal: 12, paddingVertical: 8 },
  result: {
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.gray800,
  },
  resultHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  resultTitle: { fontSize: 14, color: colors.gray100, flexShrink: 1 },
  verdict: { fontSize: 12 },
  muted: { fontSize: 11, color: colors.gray500 },
  findingChip: {
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: colors.red900_50,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  findingText: { fontSize: 11, color: colors.red400 },
  noAutoMargin: { marginLeft: 0 },
  troubleshootChip: {
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: colors.blue700,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  troubleshootText: { fontSize: 11, color: colors.blue300 },
  disabled: { opacity: 0.6 },
  error: { fontSize: 12, color: colors.red400 },
  field: { gap: 2 },
  fieldLabel: { fontSize: 10, color: colors.gray500, textTransform: 'uppercase' },
  fieldText: { fontSize: 12, color: colors.gray300 },
  fieldEmpty: { fontSize: 12, color: colors.gray600 },
  gallery: { gap: 8, paddingVertical: 2 },
  thumb: {
    width: 112,
    height: 80,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbName: { fontSize: 10, color: colors.gray400, paddingHorizontal: 4, textAlign: 'center' },
});
