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
    return { me, users: [], invites: [], emailDelivery: { smtpConfigured: false } };
  }
  const [usersBody, inviteBody] = await Promise.all([apiClient.getUsers(), apiClient.getInvites()]);
  return {
    me,
    users: usersBody?.users || [],
    invites: inviteBody?.invites || [],
    emailDelivery: inviteBody?.emailDelivery || { smtpConfigured: false },
  };
}

export async function createInviteAndCopyLink({
  apiClient,
  clipboard,
  email,
  role,
  projectIds = [],
  inviteUrl = absoluteInviteUrl,
}: any) {
  const nextEmail = String(email || '').trim();
  if (!isValidInviteEmail(nextEmail)) {
    return { ok: false, status: { type: 'error', message: 'Enter a valid email address.' } };
  }
  const cleanProjectIds = Array.isArray(projectIds)
    ? [...new Set(projectIds.filter((id: any) => typeof id === 'string' && id))]
    : [];
  const created = await apiClient.createInvite({
    email: nextEmail,
    role,
    // Project pre-assignment is Owner-only (server enforces); only sent when
    // the caller selected projects. Empty list is omitted entirely.
    ...(cleanProjectIds.length > 0 ? { projectIds: cleanProjectIds } : {}),
  });
  const sent = created?.emailDelivery?.sent === true;
  const copied = sent ? false : await clipboard(inviteUrl(created));
  return {
    ok: true,
    created,
    copied,
    status: {
      type: sent || copied ? 'success' : 'warning',
      message: sent
        ? `Invite email sent to ${created.email || nextEmail}.`
        : copied
          ? 'Invite link created and copied.'
          : 'Invite created. Copy the invite link if email delivery is blocked.',
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

export async function sendMemberInviteEmail({ apiClient, invite }: any) {
  await apiClient.sendInviteEmail(invite.token);
  return { type: 'success', message: `Invite email sent to ${invite.email}.` };
}

export async function resetMemberMfa({ apiClient, user }: any) {
  await apiClient.resetUserMfa(user.id);
  return {
    type: 'success',
    message: `MFA cleared for ${user.email || user.username || 'member'}.`,
  };
}

export default function MembersSection() {
  const [me, setMe] = useState<any>(null);
  const [users, setUsers] = useState<any>([]);
  const [invites, setInvites] = useState<any>(null);
  const [emailDelivery, setEmailDelivery] = useState<any>({ smtpConfigured: false });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('User');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const options = inviteRoleOptionsFor(me?.role);
  // Project pre-assignment is an Owner-only ACL (server enforces); only Owners
  // get the picker.
  const canAssignProjects = me?.role === 'Owner';

  const toggleProject = (id: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  const load = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const nextState = await loadMemberInvites(api);
      setMe(nextState.me);
      setUsers(nextState.users || []);
      setInvites(nextState.invites);
      setEmailDelivery(nextState.emailDelivery || { smtpConfigured: false });
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

  useEffect(() => {
    if (!canAssignProjects) {
      setProjects([]);
      setSelectedProjectIds([]);
      return;
    }
    let cancelled = false;
    api
      .getProjects()
      .then((list: any) => {
        if (!cancelled) setProjects(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canAssignProjects]);

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
        projectIds: canAssignProjects ? selectedProjectIds : [],
      });
      if (!result.ok) {
        setStatus(result.status);
        return;
      }
      setEmail('');
      setSelectedProjectIds([]);
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

  const sendInviteEmail = async (invite: any) => {
    setStatus(null);
    setBusy(true);
    try {
      const nextStatus = await sendMemberInviteEmail({ apiClient: api, invite });
      await load();
      setStatus(nextStatus);
    } catch (err: any) {
      setStatus({
        type: 'error',
        message: `${err.message || String(err)} Copy the invite link if delivery is blocked.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const resetMfa = async (user: any) => {
    Alert.alert('Clear MFA', `Clear MFA for ${user.email || user.username || 'this member'}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear MFA',
        style: 'destructive',
        onPress: async () => {
          try {
            const nextStatus = await resetMemberMfa({ apiClient: api, user });
            setUsers((prev: any) =>
              Array.isArray(prev)
                ? prev.map((item: any) =>
                    item.id === user.id ? { ...item, mfaEnabled: false } : item,
                  )
                : prev,
            );
            setStatus(nextStatus);
          } catch (err: any) {
            setStatus({ type: 'error', message: err.message || String(err) });
          }
        },
      },
    ]);
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

      {canAssignProjects && projects.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.inputLabel}>Assign to projects (optional)</Text>
          <View style={styles.projectList}>
            {projects.map((project: any) => {
              const selected = selectedProjectIds.includes(project.id);
              return (
                <TouchableOpacity
                  key={project.id}
                  style={[styles.projectChip, selected && styles.projectChipActive]}
                  onPress={() => toggleProject(project.id)}
                >
                  <Text style={[styles.projectChipText, selected && styles.projectChipTextActive]}>
                    {selected ? '✓ ' : ''}
                    {project.name || project.id}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        style={[
          styles.saveBtn,
          { marginTop: 12 },
          (!isValidInviteEmail(email) || busy) && { opacity: 0.4 },
        ]}
        onPress={createInvite}
        disabled={!isValidInviteEmail(email) || busy}
      >
        <Text style={styles.saveBtnText}>
          {busy
            ? 'Inviting...'
            : emailDelivery?.smtpConfigured
              ? 'Send Invite Email'
              : 'Create Invite Link'}
        </Text>
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

      <Text style={[styles.inputLabel, { marginTop: 16 }]}>Configured users</Text>
      {users?.length ? (
        users.map((user: any) => (
          <View key={user.id || user.email || user.username} style={styles.inviteCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.pluginKeyTitle}>{user.email || user.username || 'Member'}</Text>
              <Text style={styles.accountMutedText}>
                {user.role} - MFA {user.mfaEnabled ? 'on' : 'off'}
              </Text>
            </View>
            {user.id && user.mfaEnabled ? (
              <TouchableOpacity style={styles.accountDangerBtn} onPress={() => resetMfa(user)}>
                <Text style={styles.accountDangerBtnText}>Clear MFA</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))
      ) : (
        <Text style={styles.emptyText}>No configured users.</Text>
      )}

      <Text style={[styles.inputLabel, { marginTop: 16 }]}>Active invites</Text>
      {invites?.length ? (
        invites.map((invite: any) => (
          <View key={invite.token} style={styles.inviteCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.pluginKeyTitle}>{invite.email || 'Open invite'}</Text>
              <Text style={styles.accountMutedText}>
                {invite.role} · expires {invite.expiresAt}
              </Text>
              <Text style={styles.inviteUrl} numberOfLines={1}>
                {absoluteInviteUrl(invite)}
              </Text>
            </View>
            <View style={styles.inviteActions}>
              {emailDelivery?.smtpConfigured && invite.email ? (
                <TouchableOpacity
                  style={[styles.cancelBtn, busy && { opacity: 0.4 }]}
                  onPress={() => sendInviteEmail(invite)}
                  disabled={busy}
                >
                  <Text style={styles.cancelBtnText}>Resend email</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.cancelBtn} onPress={() => copyInvite(invite)}>
                <Text style={styles.cancelBtnText}>Copy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.accountDangerBtn}
                onPress={() => revokeInvite(invite)}
              >
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
  projectList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  projectChip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  projectChipActive: {
    borderColor: colors.indigo500,
    backgroundColor: colors.indigo900_40,
  },
  projectChipText: {
    color: colors.gray400,
    fontSize: 13,
    fontWeight: '600',
  },
  projectChipTextActive: {
    color: colors.white,
  },
  inviteActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
