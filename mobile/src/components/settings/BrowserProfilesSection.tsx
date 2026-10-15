import React from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { formatLastUsed, type BrowserProfileWire } from '@shared/utils/browserProfiles';
import { useBrowserProfiles } from '../../hooks/useBrowserProfiles';
import { colors } from '../../theme/colors';

/**
 * Mobile parity for the web Settings → Browser Profiles pane: the sites the
 * caller's agents are signed into, grouped by agent, with clear-domain and
 * delete-profile actions. Backed by /api/me/browser-profiles.
 */
export default function BrowserProfilesSection() {
  const { profiles, groups, error, busy, clearDomain, deleteProfile } = useBrowserProfiles();

  function confirmClear(profile: BrowserProfileWire, domain: string) {
    Alert.alert(
      `Clear ${domain}?`,
      `Sign ${profile.agentName} out of ${domain}? Its cookies and site storage for that domain are removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => clearDomain(profile, domain) },
      ],
    );
  }

  function confirmDelete(profile: BrowserProfileWire) {
    Alert.alert(
      'Delete browser profile?',
      `Delete ${profile.agentName}'s browser profile for ${profile.projectName}? Every saved sign-in is removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteProfile(profile) },
      ],
    );
  }

  return (
    <View style={styles.container} testID="browser-profiles">
      <Text style={styles.title}>Browser Profiles</Text>
      <Text style={styles.subtitle}>
        Sites your agents are signed into on your behalf. Only you can see these; clearing a domain
        signs the agent out of it.
      </Text>

      {error ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {profiles === null ? (
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.gray400} />
          <Text style={styles.muted}> Loading browser profiles…</Text>
        </View>
      ) : null}

      {profiles !== null && profiles.length === 0 && !error ? (
        <Text style={styles.muted} testID="browser-profiles-empty">
          No saved browser profiles yet. One is created the first time an agent signs into a site
          for you.
        </Text>
      ) : null}

      {groups.map((group) => (
        <View
          key={group.agentId}
          style={styles.card}
          testID={`browser-profiles-agent-${group.agentId}`}
        >
          <Text style={styles.agentName}>{group.agentName}</Text>
          {group.profiles.map((profile) => (
            <View key={profile.id} style={styles.profile} testID={`browser-profile-${profile.id}`}>
              <View style={styles.profileHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.projectName}>{profile.projectName}</Text>
                  <Text style={styles.small}>Last used {formatLastUsed(profile.lastUsedAt)}</Text>
                  {profile.inUse ? (
                    <Text style={styles.inUse}>In use by a running session</Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  style={[styles.deleteBtn, busy !== null && styles.disabled]}
                  onPress={() => confirmDelete(profile)}
                  disabled={busy !== null}
                  accessibilityLabel={`Delete browser profile for ${profile.agentName} in ${profile.projectName}`}
                >
                  {busy === profile.id ? (
                    <ActivityIndicator size="small" color={colors.red400} />
                  ) : (
                    <Text style={styles.deleteText}>Delete</Text>
                  )}
                </TouchableOpacity>
              </View>
              {profile.domains.length === 0 ? (
                <Text style={styles.small}>Not signed into any sites.</Text>
              ) : (
                <View style={styles.chips}>
                  {profile.domains.map((domain) => {
                    const disabled = busy !== null || profile.inUse;
                    return (
                      <View key={domain} style={styles.chip}>
                        <Text style={styles.chipText}>{domain}</Text>
                        <TouchableOpacity
                          onPress={() => confirmClear(profile, domain)}
                          disabled={disabled}
                          style={[styles.chipClear, disabled && styles.disabled]}
                          accessibilityLabel={`Clear ${domain} from ${profile.agentName}`}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          {busy === `${profile.id}:${domain}` ? (
                            <ActivityIndicator size="small" color={colors.gray400} />
                          ) : (
                            <Text style={styles.chipClearText}>{'✕'}</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}
              {profile.inUse && profile.domains.length > 0 ? (
                <Text style={styles.small}>
                  Close the running session browser before clearing a domain.
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  title: { fontSize: 18, fontWeight: '600', color: colors.white },
  subtitle: { fontSize: 13, color: colors.gray400 },
  row: { flexDirection: 'row', alignItems: 'center' },
  muted: { fontSize: 13, color: colors.gray500 },
  small: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  errorBox: {
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: { fontSize: 13, color: colors.red400 },
  card: {
    borderWidth: 1,
    borderColor: colors.gray800,
    borderRadius: 8,
    backgroundColor: colors.gray900,
  },
  agentName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  profile: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  profileHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  projectName: { fontSize: 14, color: colors.gray200 },
  inUse: { fontSize: 12, color: colors.amber400, marginTop: 2 },
  deleteBtn: {
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 64,
    alignItems: 'center',
  },
  deleteText: { fontSize: 12, color: colors.red400 },
  disabled: { opacity: 0.45 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 3,
    gap: 4,
  },
  chipText: { fontSize: 12, color: colors.gray300 },
  chipClear: { paddingHorizontal: 4 },
  chipClearText: { fontSize: 11, color: colors.gray400 },
});
