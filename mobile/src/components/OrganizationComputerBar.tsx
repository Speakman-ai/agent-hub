import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  computerToolErrorMessage,
  computerToolResetLabel,
  computerToolSourceLabel,
} from '@shared/utils/computerTool';
import {
  organizationComputerOwnerLabel,
  organizationComputerStatus,
  type DesktopRuntimeInfo,
  type OrganizationComputerState,
} from '@shared/utils/organizationComputer';
import type { OrganizationAgent } from '@shared/utils/organization-agents';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

const STATE_COLOR: Record<OrganizationComputerState, string> = {
  ready: colors.emerald300,
  off: colors.gray300,
  unavailable: colors.amber400,
  'not-permitted': colors.amber400,
  'agent-inactive': colors.amber400,
};

/**
 * Mobile twin of the web `OrganizationComputerBar`: whose desktop this chat
 * drives, whether Computer is on and where that came from, and why it can't
 * run. A failed change shows inline and never blocks the chat.
 */
export default function OrganizationComputerBar({
  agent,
  organizationName,
  user,
  sessionValue,
  onChange,
  onOpenViewer,
  loadRuntime = api.getDesktopRuntime,
}: {
  agent: Partial<OrganizationAgent> & { name?: string };
  organizationName: string | null | undefined;
  user: { name?: string | null; email?: string | null } | null | undefined;
  sessionValue: unknown;
  /** `null` drops the chat override so the agent default applies. */
  onChange: (enabled: boolean | null) => Promise<unknown>;
  onOpenViewer?: () => void;
  loadRuntime?: () => Promise<DesktopRuntimeInfo>;
}) {
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    loadRuntime()
      .then((r) => {
        if (live && r && typeof r.available === 'boolean') setRuntime(r);
      })
      .catch(() => {
        // Unknown backend status is not the same as unavailable; say nothing.
      });
    return () => {
      live = false;
    };
  }, [loadRuntime]);

  const status = organizationComputerStatus({ agent, sessionValue, runtime });
  const { setting } = status;
  const change = async (value: boolean | null) => {
    setSaving(true);
    setError('');
    try {
      await onChange(value);
    } catch (err) {
      setError(computerToolErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.bar} testID="organization-computer-bar">
      <View style={styles.row}>
        <Text style={styles.label}>Computer</Text>
        <Text
          style={[styles.state, { color: STATE_COLOR[status.state] }]}
          testID="organization-computer-state"
        >
          {status.title}
        </Text>
        {status.canToggle && (
          <Text style={styles.muted} testID="organization-computer-source">
            {computerToolSourceLabel(setting)}
          </Text>
        )}
      </View>
      <Text style={styles.muted} numberOfLines={1} testID="organization-computer-owner">
        {organizationComputerOwnerLabel({ organizationName, agentName: agent.name, user })}
      </Text>
      <Text style={styles.muted} testID="organization-computer-detail">
        {status.detail}
      </Text>
      <View style={styles.row}>
        {status.canToggle && (
          <Action disabled={saving} onPress={() => void change(!setting.enabled)}>
            {setting.enabled ? 'Turn off for this chat' : 'Turn on for this chat'}
          </Action>
        )}
        {status.canToggle && setting.overridden && (
          <Action disabled={saving} onPress={() => void change(null)}>
            {computerToolResetLabel(setting)}
          </Action>
        )}
        {onOpenViewer && (status.state === 'ready' || status.state === 'unavailable') && (
          <Action onPress={onOpenViewer}>Open Computer</Action>
        )}
      </View>
      {!!error && (
        <Text style={styles.error} accessibilityRole="alert" testID="organization-computer-error">
          {error}
        </Text>
      )}
    </View>
  );
}

function Action({
  children,
  onPress,
  disabled = false,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={children}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.buttonText}>{children}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
    backgroundColor: colors.gray900,
  },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  label: { color: colors.gray200, fontSize: 13, fontWeight: '600' },
  state: { fontSize: 13 },
  muted: { color: colors.gray400, fontSize: 12 },
  error: { color: colors.rose400, fontSize: 12 },
  button: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  buttonText: { color: colors.gray200, fontSize: 12 },
});
