import Ionicons from '@expo/vector-icons/Ionicons';
import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

/**
 * Font map for `useFonts` / `Font.loadAsync`.
 * Ionicons uses the per-family default import — required on Expo SDK 54+.
 */
export function iconFontMap() {
  return {
    ...Ionicons.font,
    ...Feather.font,
    ...MaterialCommunityIcons.font,
  };
}
