/**
 * SessionModePicker — the `session_mode` segmented control (Chat | Design) for
 * mobile, mirroring the web `client/src/components/SessionModePicker.jsx`. It
 * lives in the FinalizeBar action row alongside the Build/Finalize controls.
 *
 * Selecting `Design` puts the session into design mode (the server loads the
 * design skill; the agent writes HTML/CSS/JS into the worktree `design/` dir).
 * Mobile has no in-app iframe canvas, so instead of a live canvas the design
 * artifacts surface as a "files produced" list (SessionDesignFilesPanel) plus
 * an open-in-browser link.
 *
 * Design mode requires an isolated worktree — the server rejects `PUT /mode`
 * with `design_mode_requires_worktree` for a worktree-less session. We mirror
 * that by disabling the Design button when `canDesign` is false, so the control
 * never offers a mode the session can't run.
 *
 * Purely presentational / controlled: the parent owns the value and persists
 * the change (api.setSessionMode) in `onChange`.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import AppIcon from './AppIcon';
import { colors } from '../theme/colors';

export default function SessionModePicker({
  mode = 'chat',
  canDesign = false,
  disabled = false,
  onChange,
}) {
  const current = mode === 'design' ? 'design' : 'chat';

  const select = (next) => {
    if (disabled) return;
    if (next === current) return;
    if (next === 'design' && !canDesign) return;
    onChange?.(next);
  };

  const designDisabled = disabled || !canDesign;

  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="Session mode">
      <TouchableOpacity
        style={[styles.btn, current === 'chat' ? styles.btnActive : styles.btnIdle]}
        onPress={() => select('chat')}
        disabled={disabled}
        accessibilityRole="radio"
        accessibilityState={{ selected: current === 'chat', disabled }}
        accessibilityLabel="Chat / build mode"
        testID="session-mode-chat"
      >
        <AppIcon
          name="chatbubble-outline"
          size={11}
          color={current === 'chat' ? colors.white : colors.gray400}
        />
        <Text style={[styles.label, current === 'chat' ? styles.labelActive : styles.labelIdle]}>
          Chat
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.btn,
          current === 'design' ? styles.btnActive : styles.btnIdle,
          designDisabled && styles.btnDisabled,
        ]}
        onPress={() => select('design')}
        disabled={designDisabled}
        accessibilityRole="radio"
        accessibilityState={{ selected: current === 'design', disabled: designDisabled }}
        accessibilityLabel={
          canDesign
            ? 'Design mode — iterate on artifacts, they carry over to build'
            : 'Design mode needs a session with an isolated worktree'
        }
        testID="session-mode-design"
      >
        <AppIcon
          name="color-palette-outline"
          size={11}
          color={current === 'design' ? colors.white : colors.gray400}
        />
        <Text style={[styles.label, current === 'design' ? styles.labelActive : styles.labelIdle]}>
          Design
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: 'rgba(17,24,39,0.6)',
    padding: 2,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  btnActive: {
    backgroundColor: colors.gray800,
    borderColor: colors.gray700 || colors.gray600,
  },
  btnIdle: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
  },
  labelActive: {
    color: colors.white,
  },
  labelIdle: {
    color: colors.gray400,
  },
});
