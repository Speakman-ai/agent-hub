import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { PRE_PUSH_HOOK_EXAMPLE } from '@shared/utils/prePushHookExample';
import { colors } from '../../theme/colors';

interface Props {
  project: any;
  saving: boolean;
  saveField: (patch: Record<string, unknown>) => Promise<void>;
}

/**
 * Project setting: a shell command Finalize runs right before it pushes to
 * GitHub. Hidden for Agent Hub-hosted repos; the server refuses changes from
 * anyone below Admin.
 */
export default function PrePushHookSection({ project, saving, saveField }: Props) {
  const enabled = project?.prePushHook?.enabled === true;
  const storedCommand: string = project?.prePushHook?.command ?? '';
  const [command, setCommand] = useState(storedCommand);

  useEffect(() => {
    setCommand(storedCommand);
  }, [project?.id, storedCommand]);

  if (!project || project.gitHost === 'agenthub') return null;

  return (
    <View>
      <View style={styles.toggleRow}>
        <View style={styles.toggleTextCol}>
          <Text style={styles.toggleTitle}>Pre-push hook</Text>
          <Text style={styles.toggleDesc}>
            Shell command Finalize runs in the checkout right before it pushes to GitHub, with the
            push&apos;s GitHub token. It can rename the branch (Finalize pushes the new name) or add
            text to the PR body by writing to $AGENT_HUB_PR_BODY_APPEND. A non-zero exit stops the
            push. Requires the Admin role.
          </Text>
        </View>
        <Switch
          testID={`project-pre-push-hook-enabled-${project.id}`}
          value={enabled}
          disabled={saving}
          onValueChange={(next: boolean) => saveField({ prePushHook: { enabled: next } })}
          trackColor={{ true: colors.emerald600, false: colors.gray600 }}
        />
      </View>
      {enabled && (
        <View>
          <TextInput
            testID={`project-pre-push-hook-command-${project.id}`}
            style={styles.commandInput}
            value={command}
            onChangeText={setCommand}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="gh issue create ... && git branch -m ..."
            placeholderTextColor={colors.gray500}
          />
          <TouchableOpacity
            testID={`project-pre-push-hook-save-${project.id}`}
            style={[
              styles.saveBtn,
              (saving || command === storedCommand) && styles.saveBtnDisabled,
            ]}
            disabled={saving || command === storedCommand}
            onPress={() => saveField({ prePushHook: { command } })}
          >
            <Text style={styles.saveBtnText}>Save hook</Text>
          </TouchableOpacity>
          {!command && (
            <TouchableOpacity
              testID={`project-pre-push-hook-example-${project.id}`}
              style={[styles.saveBtn, styles.exampleBtn]}
              onPress={() => setCommand(PRE_PUSH_HOOK_EXAMPLE)}
            >
              <Text style={styles.saveBtnText}>Use issue + branch example</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 16,
  },
  toggleTextCol: { flex: 1 },
  toggleTitle: { fontSize: 14, color: colors.gray200 },
  toggleDesc: { fontSize: 12, color: colors.gray500, marginTop: 2 },
  commandInput: {
    backgroundColor: colors.gray900,
    color: colors.gray200,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.gray800,
    padding: 10,
    marginTop: 8,
    minHeight: 120,
    fontFamily: 'monospace',
    fontSize: 12,
    textAlignVertical: 'top',
  },
  saveBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.blue600,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.5 },
  exampleBtn: { backgroundColor: colors.gray700 },
  saveBtnText: { color: colors.white, fontSize: 12, fontWeight: '600' },
});
