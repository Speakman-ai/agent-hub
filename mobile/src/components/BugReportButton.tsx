import React, { useState, useCallback } from 'react';
import { TouchableOpacity, StyleSheet, Alert, Text } from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';
import { captureScreenshot, BUG_REPORT_ENABLED } from '../utils/bugReport';
import BugReportModal from './BugReportModal';
/**
 * Icon button that captures a screenshot, then opens the bug report modal.
 * Uses Ionicons (@expo/vector-icons) since the mobile app does not depend
 * on lucide-react-native — matches existing TopBar icons.
 */
export default function BugReportButton({
  projectId,
  agentId,
  sourceUrl,
  buttonStyle,
  descriptionPrefix,
  label,
}: any) {
  const [visible, setVisible] = useState(false);
  const [screenshotUri, setScreenshotUri] = useState<any>(null);
  const [capturing, setCapturing] = useState(false);
  // Hides the native Modal during a capture without closing the report, so
  // the draft (title, description, attachments) survives.
  const [hiddenForCapture, setHiddenForCapture] = useState(false);
  const openWithScreenshot = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const uri = await captureScreenshot();
      setScreenshotUri(uri);
      setVisible(true);
    } catch (e: any) {
      // Still allow reporting without a screenshot if capture fails.
      setScreenshotUri(null);
      setVisible(true);
      Alert.alert(
        'Screenshot unavailable',
        e?.message || 'Could not capture the screen. You can still submit the report.',
      );
    } finally {
      setCapturing(false);
    }
  }, [capturing]);
  const captureWithModalHidden = useCallback(async () => {
    // Briefly hide the modal so it isn't included in the capture.
    setHiddenForCapture(true);
    // Give RN a tick to unmount the Modal overlay before capturing.
    await new Promise((r: any) => setTimeout(r, 250));
    try {
      return await captureScreenshot();
    } finally {
      setHiddenForCapture(false);
    }
  }, []);
  const handleRetake = useCallback(async () => {
    const uri = await captureWithModalHidden();
    setScreenshotUri(uri);
    return uri;
  }, [captureWithModalHidden]);
  // Self-hosted builds without a configured intake endpoint don't phone home,
  // so there's no "Report a bug" control to offer. Checked after the hooks
  // above (a module constant, so hook order stays stable across renders).
  if (!BUG_REPORT_ENABLED) return null;
  return (
    <>
      <TouchableOpacity
        style={[styles.button, buttonStyle, label ? styles.labeled : null]}
        onPress={openWithScreenshot}
        disabled={capturing}
        accessibilityLabel={label || 'Report a bug'}
      >
        <AppIcon
          name="bug-outline"
          size={label ? 16 : 20}
          color={label ? colors.rose400 || colors.gray400 : colors.gray400}
        />
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </TouchableOpacity>
      <BugReportModal
        visible={visible}
        hidden={hiddenForCapture}
        onClose={() => setVisible(false)}
        screenshotUri={screenshotUri}
        onRetakeScreenshot={handleRetake}
        onAddScreenshot={captureWithModalHidden}
        projectId={projectId}
        agentId={agentId}
        sourceUrl={sourceUrl || ''}
        descriptionPrefix={descriptionPrefix || ''}
      />
    </>
  );
}
const styles = StyleSheet.create({
  button: {
    padding: 8,
    marginRight: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  labeled: {
    borderWidth: 1,
    borderColor: colors.rose900_40,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.rose900_40,
  },
  label: {
    color: colors.rose400,
    fontSize: 12,
    fontWeight: '600',
  },
});
