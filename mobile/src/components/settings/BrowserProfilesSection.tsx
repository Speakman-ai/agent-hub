import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  BROWSER_DOMAIN_POLICY_OPTIONS,
  formatLastUsed,
  normalizePolicyDomainInput,
  type BrowserDomainPolicy,
  type BrowserProfileWire,
} from '@shared/utils/browserProfiles';
import { useBrowserProfiles } from '../../hooks/useBrowserProfiles';
import { colors } from '../../theme/colors';

/**
 * Mobile parity for the web Settings → Browser Profiles pane: the sites the
 * caller's agents are signed into, grouped by agent, with clear-domain and
 * delete-profile actions. Backed by /api/me/browser-profiles.
 */
export default function BrowserProfilesSection() {
  const { profiles, groups, error, busy, clearDomain, deleteProfile, setPolicy, removePolicy } =
    useBrowserProfiles();

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
              <SitePolicies
                profile={profile}
                busy={busy}
                onSet={(domain, policy) => setPolicy(profile, domain, policy)}
                onRemove={(domain) => removePolicy(profile, domain)}
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

interface SitePoliciesProps {
  profile: BrowserProfileWire;
  busy: string | null;
  onSet: (domain: string, policy: BrowserDomainPolicy) => Promise<boolean>;
  onRemove: (domain: string) => void;
}

function PolicyPicker({
  value,
  disabled,
  onChange,
  label,
}: {
  value: BrowserDomainPolicy;
  disabled: boolean;
  onChange: (p: BrowserDomainPolicy) => void;
  label: string;
}) {
  return (
    <View style={styles.segment} accessibilityLabel={label}>
      {BROWSER_DOMAIN_POLICY_OPTIONS.map((o) => {
        const selected = o.value === value;
        return (
          <TouchableOpacity
            key={o.value}
            onPress={() => !selected && onChange(o.value)}
            disabled={disabled}
            style={[
              styles.segmentItem,
              selected && styles.segmentSelected,
              disabled && styles.disabled,
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={`${label}: ${o.label}`}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Per-profile allow / ask / block list the host enforces on agent browser ops. */
function SitePolicies({ profile, busy, onSet, onRemove }: SitePoliciesProps) {
  const [draftDomain, setDraftDomain] = useState('');
  const [draftPolicy, setDraftPolicy] = useState<BrowserDomainPolicy>('ask');
  const [draftError, setDraftError] = useState<string | null>(null);
  const policies = profile.domainPolicies ?? [];

  async function add() {
    const domain = normalizePolicyDomainInput(draftDomain);
    if (!domain) {
      setDraftError('Enter a site such as example.com');
      return;
    }
    setDraftError(null);
    if (await onSet(domain, draftPolicy)) setDraftDomain('');
  }

  return (
    <View style={styles.policies} testID={`browser-profile-policies-${profile.id}`}>
      <Text style={styles.policiesTitle}>Site policies</Text>
      <Text style={styles.small}>
        Ask first makes clicks and typing wait for your approval; Block stops the agent opening or
        acting on the site. A policy covers subdomains. Sites not listed are allowed.
      </Text>
      {policies.map(({ domain, policy }) => (
        <View key={domain} style={styles.policyRow}>
          <Text style={styles.policyDomain} numberOfLines={1}>
            {domain}
          </Text>
          <PolicyPicker
            value={policy}
            disabled={busy !== null}
            onChange={(p) => onSet(domain, p)}
            label={`Policy for ${domain}`}
          />
          <TouchableOpacity
            onPress={() => onRemove(domain)}
            disabled={busy !== null}
            style={[styles.chipClear, busy !== null && styles.disabled]}
            accessibilityLabel={`Remove policy for ${domain}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {busy === `${profile.id}:policy:${domain}` ? (
              <ActivityIndicator size="small" color={colors.gray400} />
            ) : (
              <Text style={styles.chipClearText}>{'✕'}</Text>
            )}
          </TouchableOpacity>
        </View>
      ))}
      <TextInput
        value={draftDomain}
        onChangeText={setDraftDomain}
        placeholder="example.com"
        placeholderTextColor={colors.gray500}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
        accessibilityLabel={`New site policy domain for ${profile.agentName}`}
      />
      <View style={styles.policyRow}>
        <PolicyPicker
          value={draftPolicy}
          disabled={busy !== null}
          onChange={setDraftPolicy}
          label="New site policy"
        />
        <TouchableOpacity
          style={[styles.addBtn, (busy !== null || !draftDomain.trim()) && styles.disabled]}
          onPress={add}
          disabled={busy !== null || !draftDomain.trim()}
          accessibilityLabel="Add site policy"
        >
          <Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      {draftError ? (
        <Text style={styles.draftError} accessibilityRole="alert">
          {draftError}
        </Text>
      ) : null}
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
  policies: { gap: 6, paddingTop: 4 },
  policiesTitle: { fontSize: 12, fontWeight: '600', color: colors.gray300 },
  policyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  policyDomain: { flex: 1, fontSize: 12, color: colors.gray300 },
  segment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    overflow: 'hidden',
  },
  segmentItem: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.gray800 },
  segmentSelected: { backgroundColor: colors.gray700 },
  segmentText: { fontSize: 11, color: colors.gray400 },
  segmentTextSelected: { color: colors.white, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray800,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.gray200,
  },
  addBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  addText: { fontSize: 12, color: colors.gray200 },
  draftError: { fontSize: 12, color: colors.red400 },
});
