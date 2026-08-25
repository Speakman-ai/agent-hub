import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Linking, Image, ScrollView, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
/**
 * Mobile mirror of `client/src/components/PreviewAttachment.jsx`.
 *
 * Three render variants driven by the broadcast event payload:
 *   - `preview`            — shows route + port + screenshot + "Open in browser"
 *   - `preview_unavailable`— teach moment + "Configure preview" deep-link
 *   - `preview_failed`     — log tail + "Retry" handler
 *
 * The web variant uses an iframe; mobile defers to the system browser via
 * `Linking.openURL` until react-native-webview is added to the Expo build
 * (out of scope for this card — that's the WebView parity follow-up).
 */
export default function PreviewAttachment({ event, onRetry, onTouch }: any) {
  const [showLogs, setShowLogs] = useState(false);
  if (!event || typeof event !== 'object') return null;
  const { kind } = event;
  if (kind === 'preview_unavailable') {
    const headline =
      event.unavailableReason === 'preview-disabled'
        ? 'Preview is disabled for this project'
        : 'Preview is not configured for this project';
    return (
      <View style={styles.unavailable}>
        <Text style={styles.unavailableTitle}>{headline}</Text>
        {event.agentReason ? (
          <Text style={styles.unavailableReason}>The agent asked for: {event.agentReason}</Text>
        ) : null}
        {event.wizardUrl ? (
          <TouchableOpacity
            style={styles.button}
            onPress={() => Linking.openURL(event.wizardUrl).catch(() => {})}
          >
            <Text style={styles.buttonText}>Configure preview</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  if (kind === 'preview_failed') {
    return (
      <View style={styles.failed}>
        <Text style={styles.failedTitle}>Preview failed to boot</Text>
        {event.error ? <Text style={styles.failedError}>{event.error}</Text> : null}
        {Array.isArray(event.logTail) && event.logTail.length > 0 ? (
          <View>
            <TouchableOpacity onPress={() => setShowLogs((v: any) => !v)}>
              <Text style={styles.toggle}>{showLogs ? 'Hide logs' : 'Show logs'}</Text>
            </TouchableOpacity>
            {showLogs ? (
              <ScrollView horizontal style={styles.logBox}>
                <Text style={styles.logText}>{event.logTail.join('\n')}</Text>
              </ScrollView>
            ) : null}
          </View>
        ) : null}
        {onRetry ? (
          <TouchableOpacity style={styles.button} onPress={() => onRetry(event)}>
            <Text style={styles.buttonText}>Retry</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  // Default: preview ready.
  const renderUrl = event.fullUrl || event.previewUrl || '';
  return (
    <View style={styles.ready}>
      <View style={styles.chipRow}>
        <Chip label="Preview ready" tone="emerald" />
        {event.route ? <Chip label={event.route} tone="mono" /> : null}
        {typeof event.port === 'number' ? <Chip label={`:${event.port}`} tone="mono" /> : null}
        {event.target ? <Chip label={event.target.toUpperCase()} tone="muted" /> : null}
      </View>
      {event.agentReason ? <Text style={styles.reason}>{event.agentReason}</Text> : null}
      {event.screenshotPath ? (
        <Image
          source={{ uri: event.screenshotPath }}
          style={styles.screenshot}
          resizeMode="contain"
        />
      ) : null}
      <View style={styles.chipRow}>
        {renderUrl ? (
          <TouchableOpacity
            style={styles.button}
            onPress={() => Linking.openURL(renderUrl).catch(() => {})}
          >
            <Text style={styles.buttonText}>Open in browser</Text>
          </TouchableOpacity>
        ) : null}
        {onTouch ? (
          <TouchableOpacity style={styles.buttonSecondary} onPress={() => onTouch(event)}>
            <Text style={styles.buttonText}>Refresh</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}
function Chip({ label, tone }: any) {
  const palette: Record<string, any> = {
    emerald: { bg: colors.emerald800 || '#065f46', fg: colors.emerald400 || '#34d399' },
    mono: { bg: colors.gray800, fg: colors.gray300 },
    muted: { bg: colors.gray800, fg: colors.gray400 },
  };
  const p = palette[tone] || palette.mono;
  return (
    <View style={[styles.chip, { backgroundColor: p.bg }]}>
      <Text style={[styles.chipText, { color: p.fg }]}>{label}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  ready: {
    backgroundColor: colors.gray900,
    borderColor: colors.gray700,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  unavailable: {
    backgroundColor: '#3a2d1f',
    borderColor: '#92400e',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  failed: {
    backgroundColor: '#3a1f1f',
    borderColor: '#991b1b',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
  },
  unavailableTitle: { color: '#fde68a', fontWeight: '600', marginBottom: 4 },
  unavailableReason: { color: '#fcd34d', fontSize: 12, marginBottom: 8 },
  failedTitle: { color: '#fca5a5', fontWeight: '600', marginBottom: 4 },
  failedError: { color: '#fecaca', fontFamily: 'monospace', fontSize: 12, marginBottom: 6 },
  toggle: { color: colors.blue400, marginBottom: 4 },
  logBox: {
    backgroundColor: '#000000',
    borderRadius: 4,
    padding: 6,
    maxHeight: 160,
    marginBottom: 8,
  },
  logText: { color: '#fecaca', fontFamily: 'monospace', fontSize: 11 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  chipText: { fontSize: 11, fontFamily: 'monospace' },
  reason: { color: colors.gray400, fontStyle: 'italic', fontSize: 12, marginBottom: 8 },
  screenshot: {
    width: '100%',
    height: 180,
    backgroundColor: colors.white,
    borderRadius: 4,
    marginBottom: 8,
  },
  button: {
    backgroundColor: colors.blue700 || '#1d4ed8',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  buttonSecondary: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  buttonText: { color: '#ffffff', fontSize: 12, fontWeight: '500' },
});
