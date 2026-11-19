import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useApp } from '../context/AppContext';
import { getOrgs, getActiveOrg } from '../utils/orgs';
import { colors } from '../theme/colors';

/**
 * Saved-server switcher: the active server's dot and name, opening a list of
 * every saved server. Each mobile "org" is a server connection, so choosing one
 * runs `handleSwitchOrg`, which repoints the app at that server and reconnects.
 *
 * `hideWhenSingle` renders nothing when only one server is saved (the simple
 * view); the drawer keeps its header regardless.
 */
export default function ServerPicker({
  variant = 'drawer',
  hideWhenSingle = false,
  onManage,
}: {
  variant?: 'drawer' | 'simple';
  hideWhenSingle?: boolean;
  onManage?: () => void;
}) {
  const { handleSwitchOrg } = useApp();
  const [open, setOpen] = useState(false);
  const orgs: any[] = getOrgs()?.orgs || [];
  const activeOrg = getActiveOrg();
  if (hideWhenSingle && orgs.length <= 1) return null;
  const simple = variant === 'simple';
  return (
    <View testID="server-picker">
      <TouchableOpacity
        testID="server-picker-toggle"
        accessibilityRole="button"
        accessibilityLabel={`Server: ${activeOrg?.name || 'Agent Hub'}`}
        accessibilityState={{ expanded: open }}
        style={simple ? styles.simpleHeader : styles.header}
        onPress={() => setOpen(!open)}
      >
        <View
          style={[
            simple ? styles.simpleDot : styles.dot,
            { backgroundColor: activeOrg?.color || '#6366f1' },
          ]}
        />
        <Text style={simple ? styles.simpleTitle : styles.title} numberOfLines={1}>
          {activeOrg?.name || 'Agent Hub'}
        </Text>
        <Text style={styles.chevron}>{open ? '▴' : '▾'}</Text>
      </TouchableOpacity>

      {open && (
        <View style={styles.dropdown}>
          {orgs.map((org: any) => (
            <TouchableOpacity
              key={org.id}
              testID={`server-picker-item-${org.id}`}
              accessibilityRole="button"
              accessibilityLabel={org.name}
              accessibilityState={{ selected: org.id === activeOrg?.id }}
              style={[styles.item, org.id === activeOrg?.id && styles.itemActive]}
              onPress={async () => {
                if (org.id !== activeOrg?.id) {
                  await handleSwitchOrg(org.id);
                }
                setOpen(false);
              }}
            >
              <View style={[styles.itemDot, { backgroundColor: org.color }]} />
              <Text style={styles.itemName} numberOfLines={1}>
                {org.name}
              </Text>
              <Text style={styles.mode}>{'☁'}</Text>
              {org.id === activeOrg?.id && <Text style={styles.check}>{'✓'}</Text>}
            </TouchableOpacity>
          ))}
          {onManage && (
            <TouchableOpacity
              style={styles.manage}
              onPress={() => {
                setOpen(false);
                onManage();
              }}
            >
              <Text style={styles.manageText}>Manage Servers</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.white,
  },
  dot: {
    width: 20,
    height: 20,
    borderRadius: 6,
  },
  simpleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  simpleTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
  },
  simpleDot: {
    width: 14,
    height: 14,
    borderRadius: 4,
  },
  chevron: {
    color: colors.gray500,
    fontSize: 12,
  },
  dropdown: {
    backgroundColor: colors.gray800,
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  itemActive: {
    backgroundColor: colors.gray700,
  },
  itemDot: {
    width: 14,
    height: 14,
    borderRadius: 4,
  },
  itemName: {
    flex: 1,
    fontSize: 13,
    color: colors.gray300,
  },
  mode: {
    fontSize: 12,
  },
  check: {
    color: colors.emerald400,
    fontSize: 14,
    fontWeight: 'bold',
  },
  manage: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  manageText: {
    fontSize: 12,
    color: colors.gray500,
  },
});
