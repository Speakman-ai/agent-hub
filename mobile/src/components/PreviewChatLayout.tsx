import React from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * The session preview and the chat column under it. Both sit in fixed slots,
 * so expanding or restoring the preview only changes layout: neither the
 * preview's WebView (navigation, form input, a typed URL) nor the chat and
 * composer (draft, an active recording or transcription) remount. Fullscreen
 * hides the chat instead of unmounting it.
 */
export default function PreviewChatLayout({
  preview,
  fullscreen,
  children,
}: {
  preview: React.ReactNode;
  fullscreen: boolean;
  children?: React.ReactNode;
}) {
  const hideChat = !!preview && fullscreen;
  return (
    <>
      {preview ?? null}
      <View
        style={[styles.chat, hideChat && styles.hidden]}
        pointerEvents={hideChat ? 'none' : 'auto'}
        accessibilityElementsHidden={hideChat}
        importantForAccessibility={hideChat ? 'no-hide-descendants' : 'auto'}
        testID="preview-chat-column"
      >
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  chat: { flex: 1 },
  hidden: { display: 'none' },
});
