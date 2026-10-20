import React from 'react';
import { Folder } from 'lucide-react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export default function ProjectIcon({
  style,
}: {
  project?: { icon?: string | null; color?: string | null } | null;
  style?: StyleProp<ViewStyle>;
}) {
  return <Folder testID="project-icon" size={16} color="#e5e7eb" style={style} />;
}
