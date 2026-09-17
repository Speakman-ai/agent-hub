import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { api } from '../utils/api';
import {
  validateAutopilotSetupInput,
  type AutopilotEscalation,
} from '@shared/utils/sessionAutopilot';
import { colors } from '../theme/colors';

const ESCALATION: AutopilotEscalation[] = ['none', 'low', 'medium', 'high'];

export default function AutopilotSetupPrompt({
  sessionId,
  onStarted,
  onError,
}: {
  sessionId: string;
  onStarted?: (session: unknown) => void;
  onError?: (message: string) => void;
}) {
  const [durationHours, setDurationHours] = useState('4');
  const [brief, setBrief] = useState('');
  const [goal, setGoal] = useState('');
  const [escalation, setEscalation] = useState<AutopilotEscalation>('medium');
  const [branch, setBranch] = useState('autopilot/');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const preview = useMemo(
    () =>
      validateAutopilotSetupInput({
        durationHours: Number(durationHours),
        brief,
        goal,
        escalation,
        branch,
      }),
    [durationHours, brief, goal, escalation, branch],
  );

  async function handleSubmit() {
    if (!preview.ok || saving) return;
    setSaving(true);
    setError('');
    try {
      const updated = await api.startSessionAutopilot(sessionId, preview.value);
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
      <Text style={styles.hint}>
        Pushes a named branch, verifies in preview, and waits for you to merge. Never ships to main.
      </Text>
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
      <Text style={styles.label}>Branch name</Text>
      <TextInput
        testID="autopilot-setup-branch"
        value={branch}
        onChangeText={setBranch}
        editable={!saving}
        autoCapitalize="none"
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        testID="autopilot-setup-start"
        onPress={handleSubmit}
        disabled={!preview.ok || saving}
        style={[styles.button, (!preview.ok || saving) && styles.buttonOff]}
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
