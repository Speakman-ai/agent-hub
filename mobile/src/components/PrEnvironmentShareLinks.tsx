import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api } from '../utils/api';
import { copyToClipboard } from '../utils/clipboard';
import { colors } from '../theme/colors';
import {
  DEFAULT_SHARE_LINK_HOURS,
  SHARE_LINK_EXPIRY_OPTIONS,
  SHARE_LIST_RETRY_MS,
  initialShareListState,
  sharePanelKey,
  shareListReducer,
  shouldScheduleShareRetry,
  shareLinkStatusLabel,
  sortShareLinks,
  type PrEnvironmentShareList,
} from '@shared/utils/prEnvironmentShare';

interface Props {
  projectId: string;
  prNumber: number;
  onMessage?: (msg: string) => void;
  /**
   * False where the environment panel itself is hidden (e.g. a closed PR whose
   * environment stopped): show only when links exist, so they can still be
   * inspected and revoked without an empty row on every PR.
   */
  showWhenEmpty?: boolean;
}

/**
 * Share links for a PR environment (web parity with
 * client/src/components/PrEnvironmentShareLinks.tsx). Renders nothing only
 * when the server says share links cannot exist here; other load failures
 * keep what was shown, offer Retry, and retry on their own.
 */
export default function PrEnvironmentShareLinks({
  projectId,
  prNumber,
  onMessage,
  showWhenEmpty = true,
}: Props) {
  const key = sharePanelKey(projectId, prNumber);
  const [list, dispatch] = useReducer(shareListReducer, initialShareListState);
  const retryArmed = shouldScheduleShareRetry(list);
  const seqRef = useRef(0);
  // The PR currently shown. Async work compares against it when it finishes:
  // a mutation started on another PR must not reload, message, or reset the form.
  const keyRef = useRef(key);
  keyRef.current = key;
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(DEFAULT_SHARE_LINK_HOURS);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const busy = busyFor === key;

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    dispatch({ type: 'start', key, seq });
    try {
      const data = (await api.listPrEnvironmentShareLinks(
        projectId,
        prNumber,
      )) as PrEnvironmentShareList;
      dispatch({ type: 'loaded', key, seq, data });
    } catch (error) {
      dispatch({ type: 'failed', key, seq, error });
    }
  }, [key, projectId, prNumber]);

  useEffect(() => {
    dispatch({ type: 'reset', key, seq: ++seqRef.current });
    setLabel('');
    setPassword('');
    setHours(DEFAULT_SHARE_LINK_HOURS);
    void load();
  }, [key, load]);

  useEffect(() => {
    // Armed only once the failed request has settled: a retry never
    // overlaps (and so never discards) a slow request still in flight.
    if (!retryArmed) return undefined;
    const timer = setTimeout(() => void load(), SHARE_LIST_RETRY_MS);
    return () => clearTimeout(timer);
  }, [retryArmed, load]);

  const copy = async (url: string) => {
    const ok = await copyToClipboard(url);
    onMessage?.(ok ? 'Share link copied' : 'Could not copy the link');
  };

  /**
   * Run a mutation for the PR shown now. Its follow-up (form reset, message,
   * reload) runs only if that PR is still shown when it finishes.
   */
  const mutate = async <T,>(
    work: () => Promise<T>,
    after: (result: T) => void | Promise<void>,
    failure: string,
  ) => {
    const startedFor = key;
    setBusyFor(startedFor);
    try {
      const result = await work();
      if (keyRef.current !== startedFor) return;
      await after(result);
      await load();
    } catch (e: any) {
      if (keyRef.current === startedFor) onMessage?.(e?.message || failure);
    } finally {
      setBusyFor((cur) => (cur === startedFor ? null : cur));
    }
  };

  const errorRow = (prefix: string) => (
    <View style={styles.row} accessibilityLabel="Share links error">
      <Text style={styles.error}>
        {prefix}: {list.error}
      </Text>
      <TouchableOpacity
        onPress={() => void load()}
        disabled={list.inFlight}
        accessibilityLabel="Retry share links"
      >
        <Text style={styles.action}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
  // Until the reset for a new PR lands, the reducer still holds the previous
  // PR's list; never render it (its link ids would hit this PR's routes).
  if (list.key !== key) return null;
  const data = list.data;
  if (list.status === 'unsupported') return null;
  if (!showWhenEmpty && (!data || data.links.length === 0)) return null;
  if (!data) {
    return list.status === 'error' ? (
      <View style={styles.wrap}>{errorRow('Share links did not load')}</View>
    ) : null;
  }
  const links = sortShareLinks(data.links);
  const active = links.filter((l) => l.status === 'active').length;

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        accessibilityLabel="Share links"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.summary}>
          {open ? '▾' : '▸'} Share links{active > 0 ? ` (${active} active)` : ''}
          {data.passwordRequired ? ' · password required' : ''}
        </Text>
      </TouchableOpacity>
      {list.status === 'error' ? errorRow('Could not refresh') : null}
      {open ? (
        <View style={styles.body}>
          {data.canManage ? (
            <View style={styles.block}>
              <TextInput
                value={label}
                onChangeText={setLabel}
                placeholder="Who is it for? (optional)"
                placeholderTextColor={colors.gray500}
                maxLength={120}
                style={styles.input}
                accessibilityLabel="Share link label"
              />
              <View style={styles.row}>
                {SHARE_LINK_EXPIRY_OPTIONS.map((o) => (
                  <TouchableOpacity
                    key={o.hours}
                    onPress={() => setHours(o.hours)}
                    style={[styles.chip, hours === o.hours && styles.chipOn]}
                    accessibilityLabel={`Expires in ${o.label}`}
                    accessibilityState={{ selected: hours === o.hours }}
                  >
                    <Text style={styles.chipText}>{o.label}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  disabled={busy}
                  onPress={() =>
                    mutate(
                      () =>
                        api.createPrEnvironmentShareLink(projectId, prNumber, {
                          expiresInHours: hours,
                          label: label.trim() || undefined,
                        }) as Promise<{ link: { url: string | null } }>,
                      async (res) => {
                        setLabel('');
                        if (res.link.url) await copy(res.link.url);
                      },
                      'Failed to create share link',
                    )
                  }
                  accessibilityLabel="Create and copy share link"
                >
                  <Text style={styles.action}>Create and copy</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {links.length === 0 ? (
            <Text style={styles.muted}>
              No share links yet. A share link lets someone without an Agent Hub account open this
              environment.
            </Text>
          ) : (
            links.map((l) => (
              <View key={l.id} style={styles.row} accessibilityLabel="Share link">
                <Text style={l.status === 'active' ? styles.text : styles.muted}>
                  {l.label || 'Untitled link'}
                </Text>
                <Text style={styles.muted}>{shareLinkStatusLabel(l)}</Text>
                {l.url ? (
                  <TouchableOpacity
                    onPress={() => copy(l.url!)}
                    accessibilityLabel="Copy share link"
                  >
                    <Text style={styles.action}>Copy</Text>
                  </TouchableOpacity>
                ) : null}
                {l.canRevoke ? (
                  <TouchableOpacity
                    disabled={busy}
                    onPress={() =>
                      mutate(
                        () => api.revokePrEnvironmentShareLink(projectId, prNumber, l.id),
                        () => undefined,
                        'Failed to revoke share link',
                      )
                    }
                    accessibilityLabel="Revoke share link"
                  >
                    <Text style={styles.danger}>Revoke</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))
          )}

          {data.canSetPassword ? (
            <View style={[styles.block, styles.divider]}>
              <Text style={styles.muted}>
                Project password {data.passwordRequired ? 'is set' : 'is off'}
              </Text>
              <View style={styles.row}>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  placeholder={data.passwordRequired ? 'New password' : 'Require a password'}
                  placeholderTextColor={colors.gray500}
                  style={[styles.input, styles.flex]}
                  accessibilityLabel="Share password"
                />
                <TouchableOpacity
                  disabled={busy || password.length < 4}
                  onPress={() =>
                    mutate(
                      () => api.setPrEnvironmentSharePassword(projectId, password),
                      () => setPassword(''),
                      'Failed to save the password',
                    )
                  }
                  accessibilityLabel="Save share password"
                >
                  <Text style={styles.action}>Save</Text>
                </TouchableOpacity>
                {data.passwordRequired ? (
                  <TouchableOpacity
                    disabled={busy}
                    onPress={() =>
                      mutate(
                        () => api.setPrEnvironmentSharePassword(projectId, null),
                        () => undefined,
                        'Failed to remove the password',
                      )
                    }
                    accessibilityLabel="Remove share password"
                  >
                    <Text style={styles.muted}>Remove</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  summary: { color: colors.gray400, fontSize: 13 },
  body: { marginTop: 6, gap: 8 },
  block: { gap: 6 },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray700,
    paddingTop: 8,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    color: colors.gray200,
    fontSize: 13,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipOn: { borderColor: colors.sky400 },
  chipText: { color: colors.gray200, fontSize: 12 },
  text: { color: colors.gray200, fontSize: 13 },
  muted: { color: colors.gray500, fontSize: 12 },
  action: { color: colors.sky300, fontSize: 13 },
  danger: { color: colors.rose400, fontSize: 13 },
  error: { color: colors.rose400, fontSize: 12 },
});
