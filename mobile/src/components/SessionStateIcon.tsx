import React from 'react';
import { ActivityIndicator } from 'react-native';
import AppIcon from './AppIcon';
import { sessionStateMeta } from '@shared/utils/sessionState';
import { colors } from '../theme/colors';
const ICONS: Record<string, any> = {
  MessageCircleQuestion: 'chatbubble-ellipses-outline',
  Loader2: 'sync-outline',
  FlaskConical: 'flask-outline',
  ScanEye: 'eye-outline',
  Clock: 'time-outline',
  ArrowUpCircle: 'arrow-up-circle-outline',
  CloudUpload: 'cloud-upload-outline',
  GitMerge: 'git-merge-outline',
};
const COLOR: Record<string, any> = {
  amber: colors.amber400,
  indigo: colors.indigo400,
  violet: colors.purple400,
  sky: colors.blue400,
  slate: colors.gray400,
  teal: colors.emerald400,
  emerald: colors.emerald400,
};
export default function SessionStateIcon({
  state,
  size = 14,
  style,
  testID = 'session-state-icon',
}: any) {
  const meta = sessionStateMeta(state);
  const color = COLOR[meta.color] || colors.gray400;
  if (meta.anim === 'spin') {
    return <ActivityIndicator size="small" color={color} style={style} testID={testID} />;
  }
  return (
    <AppIcon
      name={ICONS[meta.icon] || ICONS.MessageCircleQuestion}
      size={size}
      color={color}
      style={style}
      testID={testID}
      accessibilityLabel={meta.label}
    />
  );
}
