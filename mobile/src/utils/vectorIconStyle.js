import { Platform } from 'react-native';

/**
 * Layout styles for @expo/vector-icons font glyphs on iOS/Android.
 * Icons render as Text — fixed width/height without matching lineHeight often
 * clips them to invisibility on device (while Expo web still shows them).
 *
 * @param {number} size
 * @param {import('react-native').StyleProp<import('react-native').TextStyle>} [extra]
 */
export function iconTextStyle(size, extra) {
  return [
    {
      width: size,
      height: size,
      lineHeight: size,
      textAlign: 'center',
      ...(Platform.OS === 'android' ? { includeFontPadding: false } : null),
    },
    extra,
  ];
}
