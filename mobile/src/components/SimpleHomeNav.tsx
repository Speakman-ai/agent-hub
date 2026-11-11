import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import HubIcon from './HubIcon';
import { colors } from '../theme/colors';
import { useGoogleChatAvailable } from '../hooks/useGoogleChatAvailable';
import { simpleHomeLinks, type SimpleHomeTarget } from '../utils/simpleShell';

/**
 * The simple shell's top toolbar. It stays on the Chats list and on every Hub
 * pane opened from it, with the open screen highlighted.
 */
export default function SimpleHomeNav({
  active,
  onSelect,
}: {
  active: SimpleHomeTarget | null;
  onSelect: (target: SimpleHomeTarget) => void;
}) {
  const googleChatAvailable = useGoogleChatAvailable();
  return (
    <View style={styles.nav} testID="simple-home-nav">
      {simpleHomeLinks(googleChatAvailable).map((item) => {
        const selected = item.target === active;
        return (
          <Pressable
            key={item.target}
            testID={`simple-home-${item.target}`}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ selected }}
            onPress={() => onSelect(item.target)}
            style={[styles.icon, selected && styles.iconSelected]}
          >
            <HubIcon name={item.icon} size={18} color={selected ? colors.sky300 : colors.gray400} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  icon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  iconSelected: { backgroundColor: colors.gray800 },
});
