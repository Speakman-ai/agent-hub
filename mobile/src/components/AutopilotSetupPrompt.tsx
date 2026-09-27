import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { api } from '../utils/api';
import {
  AUTOPILOT_MAINLINE_UNAVAILABLE_MESSAGE,
  autopilotStartRequestBody,
  validateAutopilotSetupInput,
  type AutopilotEscalation,
  type AutopilotTarget,
} from '@shared/utils/sessionAutopilot';
import { colors } from '../theme/colors';

type PendingFile = { uri: string; name: string; type: string; size?: number };

const ESCALATION: AutopilotEscalation[] = ['none', 'low', 'medium', 'high'];

const TARGETS: { value: AutopilotTarget; label: string }[] = [
  { value: 'branch', label: 'Isolated branch' },
  { value: 'mainline', label: 'Default branch + deploy' },
];

export default function AutopilotSetupPrompt({
  sessionId,
  onStarted,
  onError,
  mainlineAvailable = false,
}: {
  sessionId: string;
  onStarted?: (session: unknown) => void;
  onError?: (message: string) => void;
  /** The session's `can_autopilot_mainline`: whether the server accepts "Default branch + deploy". */
  mainlineAvailable?: boolean;
}) {
  const [durationHours, setDurationHours] = useState('4');
  const [brief, setBrief] = useState('');
  const [goal, setGoal] = useState('');
  const [escalation, setEscalation] = useState<AutopilotEscalation>('medium');
  const [target, setTarget] = useState<AutopilotTarget>('branch');
  const [branch, setBranch] = useState('autopilot/');
  const [deployEnvironment, setDeployEnvironment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [picking, setPicking] = useState(false);

  const preview = useMemo(
    () =>
      validateAutopilotSetupInput({
        durationHours: Number(durationHours),
        brief,
        goal,
        escalation,
        target,
        branch,
        deployEnvironment,
      }),
    [durationHours, brief, goal, escalation, target, branch, deployEnvironment],
  );

  async function pickAttachments(photos: boolean) {
    if (saving || picking) return;
    setPicking(true);
    setError('');
    try {
      if (photos) {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images', 'videos'],
          allowsMultipleSelection: true,
        });
        if (!result.canceled) {
          setFiles((current) => [
            ...current,
            ...result.assets.map((asset) => ({
              uri: asset.uri,
              name: asset.fileName || asset.uri.split('/').pop() || 'photo.jpg',
              type: asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
              size: asset.fileSize,
            })),
          ]);
        }
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (!result.canceled) {
          setFiles((current) => [
            ...current,
            ...result.assets.map((asset) => ({
              uri: asset.uri,
              name: asset.name,
              type: asset.mimeType || 'application/octet-stream',
              size: asset.size,
            })),
          ]);
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Could not select attachments.');
    } finally {
      setPicking(false);
    }
  }

  async function handleSubmit() {
    if (!preview.ok || saving || picking) return;
    setSaving(true);
    setError('');
    try {
      const images = await Promise.all(files.map((file) => api.uploadFile(file)));
      const updated = await api.startSessionAutopilot(sessionId, {
        ...autopilotStartRequestBody(preview.value),
        ...(images.length ? { images } : {}),
      });
      onStarted?.(updated);
    } catch (err: any) {
      const message = err?.message || 'Could not start Autopilot.';
      setError(message);
      onError?.(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View testID="autopilot-setup-prompt" style={styles.card}>
      <Text style={styles.title}>Autopilot</Text>
      <Text testID="autopilot-setup-summary" style={styles.hint}>
        {target === 'mainline'
          ? 'Pushes each validated change to the default branch, deploys it, and verifies on the live environment. Every change goes live.'
          : 'Pushes a named branch, verifies in preview, and waits for you to merge. Never ships to main.'}
      </Text>
      <Text style={styles.label}>Where to ship</Text>
      <View style={styles.row}>
        {TARGETS.map((opt) => {
          const unavailable = opt.value === 'mainline' && !mainlineAvailable;
          return (
            <Pressable
              key={opt.value}
              testID={`autopilot-setup-target-${opt.value}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: target === opt.value, disabled: unavailable }}
              disabled={saving || unavailable}
              onPress={() => setTarget(opt.value)}
              style={[
                styles.chip,
                target === opt.value && styles.chipOn,
                unavailable && styles.chipDisabled,
              ]}
            >
              <Text style={styles.chipText}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {!mainlineAvailable ? (
        <Text style={styles.hint}>{AUTOPILOT_MAINLINE_UNAVAILABLE_MESSAGE}</Text>
      ) : null}
      <Text style={styles.label}>How long (hours; 0 = no limit)</Text>
      <TextInput
        testID="autopilot-setup-duration"
        value={durationHours}
        onChangeText={setDurationHours}
        keyboardType="number-pad"
        editable={!saving}
        style={styles.input}
      />
      <Text style={styles.label}>What you want it to do</Text>
      <TextInput
        testID="autopilot-setup-brief"
        value={brief}
        onChangeText={setBrief}
        editable={!saving}
        multiline
        style={[styles.input, styles.multiline]}
      />
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach photos or videos"
          disabled={saving || picking}
          onPress={() => pickAttachments(true)}
          style={styles.chip}
        >
          <Text style={styles.chipText}>Photos / videos</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach files"
          disabled={saving || picking}
          onPress={() => pickAttachments(false)}
          style={styles.chip}
        >
          <Text style={styles.chipText}>Attach files</Text>
        </Pressable>
      </View>
      {files.map((file, index) => (
        <View key={index} style={styles.row}>
          <Text style={styles.chipText}>{file.name}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${file.name}`}
            disabled={saving}
            onPress={() => setFiles((current) => current.filter((_, i) => i !== index))}
          >
            <Text style={styles.chipText}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <Text style={styles.label}>Goal to check for</Text>
      <TextInput
        testID="autopilot-setup-goal"
        value={goal}
        onChangeText={setGoal}
        editable={!saving}
        multiline
        style={[styles.input, styles.multiline]}
      />
      <Text style={styles.label}>Escalation</Text>
      <View style={styles.row}>
        {ESCALATION.map((level) => (
          <Pressable
            key={level}
            onPress={() => setEscalation(level)}
            style={[styles.chip, escalation === level && styles.chipOn]}
          >
            <Text style={styles.chipText}>{level}</Text>
          </Pressable>
        ))}
      </View>
      {target === 'mainline' ? (
        <>
          <Text style={styles.label}>Deploy environment (from .agent-hub/deploy.yaml)</Text>
          <TextInput
            testID="autopilot-setup-deploy-env"
            value={deployEnvironment}
            onChangeText={setDeployEnvironment}
            editable={!saving}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="staging"
            placeholderTextColor={colors.gray500}
            style={styles.input}
          />
        </>
      ) : (
        <>
          <Text style={styles.label}>Branch name</Text>
          <TextInput
            testID="autopilot-setup-branch"
            value={branch}
            onChangeText={setBranch}
            editable={!saving}
            autoCapitalize="none"
            style={styles.input}
          />
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        testID="autopilot-setup-start"
        onPress={handleSubmit}
        disabled={!preview.ok || saving || picking}
        style={[styles.button, (!preview.ok || saving || picking) && styles.buttonOff]}
      >
        <Text style={styles.buttonText}>{saving ? 'Starting…' : 'Start Autopilot'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.gray900,
    borderColor: colors.emerald700,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 6,
    width: '100%',
  },
  title: { color: colors.emerald300, fontWeight: '600' },
  hint: { color: colors.gray400, fontSize: 12 },
  label: { color: colors.gray300, fontSize: 12, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    color: colors.white,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipOn: { borderColor: colors.emerald500, backgroundColor: colors.emerald800 },
  chipDisabled: { opacity: 0.5 },
  chipText: { color: colors.gray200, fontSize: 12 },
  error: { color: colors.rose400, fontSize: 12 },
  button: {
    marginTop: 8,
    backgroundColor: colors.emerald600,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  buttonOff: { backgroundColor: colors.gray700 },
  buttonText: { color: colors.white, fontWeight: '600' },
});
