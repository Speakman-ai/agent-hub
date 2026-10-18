import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

export default function ProjectIcon({
  project,
  style,
}: {
  project?: { icon?: string | null; color?: string | null } | null;
  style?: StyleProp<ViewStyle>;
}) {
  const icon = project?.icon?.trim();
  return icon ? (
    <Text
      testID="project-icon"
      accessible={false}
      style={{ color: '#e5e7eb', fontSize: 16, lineHeight: 20, flexShrink: 0 }}
    >
      {icon}
    </Text>
  ) : (
    <View
      testID="project-icon"
      accessible={false}
      style={[
        { width: 12, height: 12, borderRadius: 3, backgroundColor: project?.color || '#6366f1' },
        style,
      ]}
    />
  );
}
