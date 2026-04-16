import React, { useState, useCallback } from 'react';
import { TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { captureScreenshot } from '../utils/bugReport';
import BugReportModal from './BugReportModal';

/**
 * Icon button that captures a screenshot, then opens the bug report modal.
 * Uses Ionicons (@expo/vector-icons) since the mobile app does not depend
 * on lucide-react-native — matches existing TopBar icons.
 */
export default function BugReportButton({ projectId, agentId, sourceUrl }) {
  const [visible, setVisible] = useState(false);
  const [screenshotUri, setScreenshotUri] = useState(null);
  const [capturing, setCapturing] = useState(false);

  const openWithScreenshot = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const uri = await captureScreenshot();
      setScreenshotUri(uri);
      setVisible(true);
    } catch (e) {
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

  const handleRetake = useCallback(async () => {
    // Briefly hide the modal so it isn't included in the capture.
    setVisible(false);
    // Give RN a tick to unmount the Modal overlay before capturing.
    await new Promise((r) => setTimeout(r, 250));
    let uri = null;
    try {
      uri = await captureScreenshot();
      setScreenshotUri(uri);
    } finally {
      setVisible(true);
    }
    return uri;
  }, []);

  return (
    <>
      <TouchableOpacity
        style={styles.button}
        onPress={openWithScreenshot}
        disabled={capturing}
        accessibilityLabel="Report a bug"
      >
        <Ionicons name="bug-outline" size={20} color={colors.gray400} />
      </TouchableOpacity>
      <BugReportModal
        visible={visible}
        onClose={() => setVisible(false)}
        screenshotUri={screenshotUri}
        onRetakeScreenshot={handleRetake}
        projectId={projectId}
        agentId={agentId}
        sourceUrl={sourceUrl || ''}
      />
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 8,
    marginRight: 2,
  },
});
