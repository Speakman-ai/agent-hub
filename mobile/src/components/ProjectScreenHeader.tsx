import React, { useContext } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SidebarContext } from '../context/SidebarContext';
import { colors } from '../theme/colors';
/**
 * Shared top bar for project-scoped screens.
 */
export default function ProjectScreenHeader({ title, project, onBack, right, testID, }: any) {
    const { openSidebar } = useContext(SidebarContext);
    return (<View style={styles.topBar} testID={testID}>
      {onBack ? (<TouchableOpacity onPress={onBack} style={styles.menuButton}>
          <Text style={styles.backIcon}>{'\u2190'}</Text>
        </TouchableOpacity>) : (<TouchableOpacity onPress={openSidebar} style={styles.menuButton}>
          <Text style={styles.menuIcon}>{'\u2630'}</Text>
        </TouchableOpacity>)}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {project ? (<Text style={styles.projectLabel} numberOfLines={1}>
          {project.name}
        </Text>) : null}
      {right || null}
    </View>);
}
const styles = StyleSheet.create({
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.gray800,
        gap: 8,
    },
    menuButton: { padding: 4 },
    menuIcon: { fontSize: 22, color: colors.gray400 },
    backIcon: { fontSize: 22, color: colors.gray400 },
    title: { fontSize: 17, fontWeight: '600', color: colors.white, flexShrink: 1 },
    projectLabel: {
        marginLeft: 'auto',
        fontSize: 12,
        color: colors.gray500,
        maxWidth: 120,
    },
});
