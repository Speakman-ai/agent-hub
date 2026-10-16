import { createElement, type ComponentType } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';

type PdfViewProps = {
  uri?: string;
  style?: StyleProp<ViewStyle>;
  fitMode?: string;
  doubleTapToZoom?: boolean;
  onError?: (event: unknown) => void;
  testID?: string;
};

let cached: ComponentType<PdfViewProps> | null | undefined;

/**
 * `@kishannareshpal/expo-pdf` calls `requireNativeModule('KJExpoPdf')` as soon
 * as it is imported. Expo Go does not include that module, and evaluating the
 * import while the JS runtime is still starting crashes the app
 * (`[runtime not ready]: Cannot find native module 'KJExpoPdf'`). Require it
 * only when a PDF is actually shown.
 */
export function loadNativePdfView(): ComponentType<PdfViewProps> | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require('@kishannareshpal/expo-pdf') as { PdfView?: ComponentType<PdfViewProps> };
    cached = mod.PdfView ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** iOS WKWebView can display a local PDF. Android's WebView cannot. */
export function IosPdfWebView({ uri, style }: { uri: string; style?: StyleProp<ViewStyle> }) {
  if (Platform.OS !== 'ios') return null;
  return createElement(WebView, {
    source: { uri },
    style,
    originWhitelist: ['*'],
    allowFileAccess: true,
    testID: 'session-artifact-viewer-pdf',
  });
}
