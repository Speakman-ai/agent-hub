/**
 * Login-screen escape hatch for the mobile app.
 *
 * Mirrors the web `LoginServerPicker`: lets the user swap to another saved
 * organization or edit the current server URL *before* signing in, so
 * targeting an org they have no password for never locks them out.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { colors } from '../theme/colors';
import { getOrgs, updateOrg } from '../utils/orgs';
import { clearToken } from '../utils/auth';
import {
  isServerOriginChange,
  loginOrgUrl,
  normalizeServerUrl,
  resolveActiveOrgLoginServer,
  validateServerUrl,
} from '@shared/utils/loginServerPicker';

interface Props {
  /** Switch the active org (AppContext.handleSwitchOrg). */
  onSwitchOrg: (orgId: string) => Promise<void> | void;
  /**
   * Called synchronously before any switch work. The login screen owns the
   * transition: returning false (a sign-in is in flight) cancels the switch,
   * returning true blocks sign-in until `onServerChangeEnd`.
   */
  onServerChangeStart: () => boolean;
  /** Called once the transition settles (success or failure) so the login
   *  screen re-probes whatever server the connection now points at. */
  onServerChangeEnd: () => void;
  /** Lock the picker, e.g. while the login form is submitting. */
  disabled?: boolean;
}

export default function LoginServerPicker({
  onSwitchOrg,
  onServerChangeStart,
  onServerChangeEnd,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a save so the picker re-reads the orgs cache.
  const [, setVersion] = useState(0);

  const locked = busy || disabled;
  const resolved = resolveActiveOrgLoginServer(getOrgs());
  if (!resolved) return null;
  const { current, others } = resolved;
  const currentId = resolved.currentOrg.id;
  const currentUrl = current.url;

  const finish = () => {
    setEditing(false);
    setOpen(false);
  };

  /** Run one server transition, bracketed by the login screen's start/end. */
  const runTransition = async (work: () => Promise<void>, failMessage: string) => {
    if (locked || !onServerChangeStart()) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      finish();
    } catch (err: any) {
      setError(err?.message || failMessage);
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
      onServerChangeEnd();
    }
  };

  // The cached JWT was issued by the current server; it must not be sent to a
  // different one. Nothing is lost: the login screen is up because it is
  // missing, expired, or rejected.
  const dropTokenIfLeaving = async (nextUrl: string) => {
    if (isServerOriginChange(currentUrl, nextUrl)) await clearToken();
  };

  const handleSwitch = (org: (typeof others)[number]) =>
    runTransition(async () => {
      await dropTokenIfLeaving(loginOrgUrl(org));
      await onSwitchOrg(org.id);
    }, 'Failed to switch organization');

  const handleSaveUrl = async () => {
    if (locked) return;
    const problem = validateServerUrl(urlDraft);
    if (problem) {
      setError(problem);
      return;
    }
    const nextUrl = normalizeServerUrl(urlDraft);
    // The org's API key belongs to the server that issued it; a new origin
    // gets no key rather than the old server's.
    const keepKey = !isServerOriginChange(currentUrl, nextUrl);
    await runTransition(async () => {
      await dropTokenIfLeaving(nextUrl);
      await updateOrg(
        currentId,
        keepKey ? { remoteUrl: nextUrl } : { remoteUrl: nextUrl, apiKey: '' },
      );
      // Re-run the switch so AppContext resets state and reconnects against
      // the new URL (switching to the already-active id is a no-op otherwise).
      await onSwitchOrg(currentId);
    }, 'Failed to save server URL');
  };

  return (
    <View style={styles.box} testID="login-server-picker">
      <View style={styles.headerRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.caption}>Signing in to</Text>
          <Text style={styles.name} numberOfLines={1} testID="login-server-name">
            {current.name}
          </Text>
          {currentUrl ? (
            <Text style={styles.url} numberOfLines={1} testID="login-server-url">
              {currentUrl}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => {
            setOpen((v) => !v);
            setError(null);
          }}
          disabled={locked}
          style={styles.changeBtn}
          testID="login-server-change"
        >
          <Text style={styles.changeText}>{open ? 'Close' : 'Change'}</Text>
        </TouchableOpacity>
      </View>

      {open ? (
        <View style={styles.body}>
          {editing ? (
            <>
              <Text style={styles.caption}>Server URL</Text>
              <TextInput
                style={styles.input}
                value={urlDraft}
                onChangeText={(v) => {
                  setUrlDraft(v);
                  setError(null);
                }}
                placeholder="https://my-server.example.com"
                placeholderTextColor={colors.gray500}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                autoFocus
                onSubmitEditing={() => void handleSaveUrl()}
                testID="login-server-url-input"
              />
              <View style={styles.actionRow}>
                <TouchableOpacity
                  onPress={() => void handleSaveUrl()}
                  disabled={locked || !urlDraft.trim()}
                  style={[styles.primaryBtn, (locked || !urlDraft.trim()) && styles.btnDisabled]}
                  testID="login-server-save"
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.white} />
                  ) : (
                    <Text style={styles.primaryText}>Save & connect</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    setEditing(false);
                    setError(null);
                  }}
                  disabled={locked}
                  style={styles.ghostBtn}
                  testID="login-server-cancel"
                >
                  <Text style={styles.ghostText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              {others.length > 0 ? (
                <>
                  <Text style={styles.caption}>Other organizations</Text>
                  {others.map((org) => (
                    <TouchableOpacity
                      key={org.id}
                      onPress={() => void handleSwitch(org)}
                      disabled={locked}
                      style={styles.orgRow}
                      testID={`login-server-org-${org.id}`}
                    >
                      <View style={[styles.dot, { backgroundColor: org.color || '#6366f1' }]} />
                      <Text style={styles.orgName} numberOfLines={1}>
                        {org.name}
                      </Text>
                      <Text style={styles.orgUrl} numberOfLines={1}>
                        {loginOrgUrl(org)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </>
              ) : null}
              <TouchableOpacity
                onPress={() => {
                  setUrlDraft(currentUrl);
                  setError(null);
                  setEditing(true);
                }}
                disabled={locked}
                style={styles.outlineBtn}
                testID="login-server-edit"
              >
                <Text style={styles.outlineText}>Edit server URL</Text>
              </TouchableOpacity>
            </>
          )}
          {error ? (
            <Text style={styles.error} testID="login-server-error">
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 10,
    backgroundColor: 'rgba(3, 7, 18, 0.5)',
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  caption: {
    fontSize: 11,
    color: colors.gray400,
    marginBottom: 2,
  },
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.white,
  },
  url: {
    fontSize: 11,
    color: colors.gray500,
  },
  changeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: colors.gray800,
  },
  changeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.gray200,
  },
  body: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  input: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.white,
    fontSize: 13,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  primaryBtn: {
    backgroundColor: colors.emerald500,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    backgroundColor: colors.gray700,
  },
  primaryText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '600',
  },
  ghostBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  ghostText: {
    color: colors.gray400,
    fontSize: 12,
    fontWeight: '600',
  },
  orgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  orgName: {
    flex: 1,
    color: colors.gray200,
    fontSize: 13,
  },
  orgUrl: {
    maxWidth: '45%',
    color: colors.gray500,
    fontSize: 11,
  },
  outlineBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  outlineText: {
    color: colors.gray300,
    fontSize: 12,
    fontWeight: '600',
  },
  error: {
    color: colors.red400,
    fontSize: 12,
  },
});
