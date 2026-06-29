import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api } from '../../utils/api';
import { copyToClipboard } from '../../utils/clipboard';
import { getServerBaseUrl } from '../../utils/config';
import { colors } from '../../theme/colors';

export function isValidInviteEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export function inviteRoleOptionsFor(callerRole: any) {
  if (callerRole === 'Owner' || callerRole === 'Admin') return ['Admin', 'User'];
  return [];
}

export function absoluteInviteUrl(invite: any) {
  const raw = invite?.url || (invite?.token ? `/invite/${invite.token}` : '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const serverBase = getServerBaseUrl();
  return serverBase ? `${serverBase}${raw.startsWith('/') ? raw : `/${raw}`}` : raw;
}

export async function loadMemberInvites(apiClient: any) {
  const meBody = await apiClient.getMe();
  const me = meBody?.user || null;
  const role = me?.role;
  if (role !== 'Owner' && role !== 'Admin') {
    return { me, invites: [] };
  }
  const inviteBody = await apiClient.getInvites();
  return { me, invites: inviteBody?.invites || [] };
}

export async function createInviteAndCopyLink({
  apiClient,
  clipboard,
  email,
  role,
  inviteUrl = absoluteInviteUrl,
}: any) {
  const nextEmail = String(email || '').trim();
  if (!isValidInviteEmail(nextEmail)) {
    return { ok: false, status: { type: 'error', message: 'Enter a valid email address.' } };
  }
  const created = await apiClient.createInvite({ email: nextEmail, role });
  const copied = await clipboard(inviteUrl(created));
  return {
    ok: true,
    created,
    copied,
    status: {
      type: copied ? 'success' : 'warning',
      message: copied ? 'Invite created and link copied.' : 'Invite created.',
    },
  };
}

export async function copyMemberInvite({ clipboard, invite, inviteUrl = absoluteInviteUrl }: any) {
  const copied = await clipboard(inviteUrl(invite));
  return {
    copied,
    status: {
      type: copied ? 'success' : 'error',
      message: copied ? 'Invite link copied.' : 'Copy failed.',
    },
  };
}

export async function revokeMemberInvite({ apiClient, invite }: any) {
  await apiClient.revokeInvite(invite.token);
  return { type: 'success', message: 'Invite revoked.' };
}

export default function MembersSection() {
  const [me, setMe] = useState<any>(null);
  const [invites, setInvites] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('User');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const options = inviteRoleOptionsFor(me?.role);

  const load = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const nextState = await loadMemberInvites(api);
      setMe(nextState.me);
      setInvites(nextState.invites);
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
      setInvites([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!options.includes(role)) setRole(options[options.length - 1] || 'User');
  }, [options, role]);

  const createInvite = async () => {
    const nextEmail = email.trim();
    setStatus(null);
    if (!isValidInviteEmail(nextEmail)) {
      setStatus({ type: 'error', message: 'Enter a valid email address.' });
      return;
    }
    setBusy(true);
    try {
      const result = await createInviteAndCopyLink({
        apiClient: api,
        clipboard: copyToClipboard,
        email: nextEmail,
        role,
      });
      if (!result.ok) {
        setStatus(result.status);
        return;
      }
      setEmail('');
      await load();
      setStatus(result.status);
    } catch (err: any) {
      setStatus({ type: 'error', message: err.message || String(err) });
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (invite: any) => {
    Alert.alert('Revoke invite', `Revoke invite for ${invite.email || invite.role}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          try {
            const nextStatus = await revokeMemberInvite({ apiClient: api, invite });
            await load();
            setStatus(nextStatus);
          } catch (err: any) {
            setStatus({ type: 'error', message: err.message || String(err) });
          }
        },
      },
    ]);
  };

  const copyInvite = async (invite: any) => {
    const result = await copyMemberInvite({ clipboard: copyToClipboard, invite });
    setStatus(result.status);
  };

  if (loading) return <Text style={styles.emptyText}>Loading members...</Text>;
  if (options.length === 0) return null;

  return (
    <View style={[styles.accountCard, { marginTop: 16 }]}>
      <Text style={styles.accountCardTitle}>Members</Text>
      <Text style={styles.sectionDesc}>
        Invite links create Admin or User accounts. Promote a member to Owner after they accept.
      </Text>

      <Text style={styles.inputLabel}>Email</Text>
      <TextInput
        style={styles.textInput}
        value={email}
        onChangeText={(value: any) => {
          setEmail(value);
          setStatus(null);
        }}
        placeholder="teammate@example.com"
        placeholderTextColor={colors.gray600}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />

      <Text style={[styles.inputLabel, { marginTop: 12 }]}>Role</Text>
      <View style={styles.inviteRoleRow}>
        {options.map((option: any) => (
          <TouchableOpacity
            key={option}
            style={[styles.inviteRoleBtn, role === option && styles.inviteRoleBtnActive]}
            onPress={() => setRole(option)}
          >
            <Text style={[styles.inviteRoleText, role === option && styles.inviteRoleTextActive]}>
              {option}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={[styles.saveBtn, (!isValidInviteEmail(email) || busy) && { opacity: 0.4 }]}
        onPress={createInvite}
        disabled={!isValidInviteEmail(email) || busy}
      >
        <Text style={styles.saveBtnText}>{busy ? 'Inviting...' : 'Invite Member'}</Text>
      </TouchableOpacity>

      {status && (
        <Text
          style={[
            styles.accountStatusNote,
            {
              color:
                status.type === 'success'
                  ? colors.emerald400
                  : status.type === 'warning'
                    ? colors.yellow400
                    : colors.red400,
            },
          ]}
        >
          {status.message}
        </Text>
      )}

      <Text style={[styles.inputLabel, { marginTop: 16 }]}>Active invites</Text>
      {invites?.length ? (
        invites.map((invite: any) => (
          <View key={invite.token} style={styles.inviteCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.pluginKeyTitle}>{invite.email || 'Open invite'}</Text>
              <Text style={styles.accountMutedText}>{invite.role} · expires {invite.expiresAt}</Text>
              <Text style={styles.inviteUrl} numberOfLines={1}>
                {absoluteInviteUrl(invite)}
              </Text>
            </View>
            <View style={styles.inviteActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => copyInvite(invite)}>
                <Text style={styles.cancelBtnText}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.accountDangerBtn} onPress={() => revokeInvite(invite)}>
                <Text style={styles.accountDangerBtnText}>Revoke</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>No active invites.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  accountCard: {
    backgroundColor: colors.gray800,
    borderRadius: 12,
    padding: 16,
  },
  accountCardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.white,
    marginBottom: 8,
  },
  sectionDesc: {
    fontSize: 13,
    color: colors.gray500,
    marginBottom: 16,
  },
  inputLabel: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: colors.gray900,
    color: colors.white,
    borderColor: colors.gray700,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  saveBtn: {
    backgroundColor: colors.indigo600,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  cancelBtn: {
    backgroundColor: colors.gray700,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  cancelBtnText: {
    color: colors.gray200,
    fontSize: 13,
    fontWeight: '600',
  },
  accountDangerBtn: {
    backgroundColor: colors.red600,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  accountDangerBtnText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '600',
  },
  accountStatusNote: {
    fontSize: 13,
    marginTop: 12,
  },
  accountMutedText: {
    fontSize: 13,
    color: colors.gray500,
  },
  pluginKeyTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.gray200,
    marginBottom: 4,
  },
  emptyText: {
    fontSize: 14,
    color: colors.gray500,
  },
  inviteRoleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  inviteRoleBtn: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  inviteRoleBtnActive: {
    borderColor: colors.indigo500,
    backgroundColor: colors.indigo900_40,
  },
  inviteRoleText: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
  },
  inviteRoleTextActive: {
    color: colors.white,
  },
  inviteCard: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    gap: 10,
  },
  inviteUrl: {
    color: colors.gray500,
    fontSize: 11,
    marginTop: 4,
  },
  inviteActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
