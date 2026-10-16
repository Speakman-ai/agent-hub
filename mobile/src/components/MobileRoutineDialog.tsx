import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { X } from 'lucide-react-native';
import humanCron from '@shared/utils/humanCron';
import {
  ROUTINE_DEFAULT_SCHEDULE,
  ROUTINE_SCHEDULE_PRESETS,
  localTimezone,
  looksLikeCronExpression,
  routineCronCreateBody,
  routineSkillCreateBody,
  routineSkillProblems,
  type RoutineDraftWire,
} from '@shared/utils/routineFromRecording';
import { colors } from '../theme/colors';
import { api } from '../utils/api';

export interface MobileRoutineDialogApi {
  draftRoutineFromRecording: (
    sessionId: string,
    body: { artifactId: string; goal?: string },
  ) => Promise<RoutineDraftWire>;
  createProjectSkill: (projectId: string, body: unknown) => Promise<unknown>;
  createCron: (body: unknown) => Promise<unknown>;
}

type Step = 'goal' | 'drafting' | 'edit' | 'saving' | 'schedule' | 'scheduling' | 'done';

/**
 * Mobile twin of the web `RoutineFromRecordingDialog`: the agent drafts a
 * project skill from the last browser demo recording, the human edits and
 * saves it, then can schedule it as a routine.
 */
export default function MobileRoutineDialog({
  sessionId,
  artifactId,
  onClose,
  client = api as unknown as MobileRoutineDialogApi,
}: {
  sessionId: string;
  artifactId: string;
  onClose: () => void;
  client?: MobileRoutineDialogApi;
}) {
  const [step, setStep] = useState<Step>('goal');
  const [error, setError] = useState('');
  const [goal, setGoal] = useState('');
  const [meta, setMeta] = useState<RoutineDraftWire | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [savedName, setSavedName] = useState('');
  const [schedule, setSchedule] = useState(ROUTINE_DEFAULT_SCHEDULE);
  const [notes, setNotes] = useState('');

  const busy = step === 'drafting' || step === 'saving' || step === 'scheduling';
  const problems = routineSkillProblems({ name, description, body });

  const requestDraft = async () => {
    setError('');
    setStep('drafting');
    try {
      const res = await client.draftRoutineFromRecording(sessionId, {
        artifactId,
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      });
      setMeta(res);
      setName(res.draft.name);
      setDescription(res.draft.description);
      setBody(res.draft.body);
      setStep('edit');
    } catch (err) {
      setError((err as Error).message || 'Drafting failed');
      setStep('goal');
    }
  };

  const saveSkill = async () => {
    if (!meta || problems.length > 0) return;
    setError('');
    setStep('saving');
    try {
      await client.createProjectSkill(
        meta.projectId,
        routineSkillCreateBody({ name, description, body }),
      );
      setSavedName(name.trim());
      setStep('schedule');
    } catch (err) {
      setError((err as Error).message || 'Saving the skill failed');
      setStep('edit');
    }
  };

  const attachSchedule = async () => {
    if (!meta || !looksLikeCronExpression(schedule)) return;
    setError('');
    setStep('scheduling');
    try {
      await client.createCron(
        routineCronCreateBody({
          projectId: meta.projectId,
          agentId: meta.agentId,
          skillName: savedName,
          schedule,
          timezone: localTimezone(),
          notes,
        }),
      );
      setStep('done');
    } catch (err) {
      setError((err as Error).message || 'Scheduling failed');
      setStep('schedule');
    }
  };

  const primary = (label: string, onPress: () => void, testID: string, disabled = false) => (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy || disabled}
      style={[styles.primary, (busy || disabled) && styles.disabled]}
      testID={testID}
      accessibilityRole="button"
    >
      {busy ? <ActivityIndicator size="small" color={colors.gray100} /> : null}
      <Text style={styles.primaryText}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <Modal visible animationType="slide" transparent onRequestClose={busy ? undefined : onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="mobile-routine-dialog">
          <View style={styles.header}>
            <Text style={styles.title}>Make routine</Text>
            <TouchableOpacity onPress={onClose} disabled={busy} accessibilityLabel="Close">
              <X size={18} color={colors.gray400} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {error ? (
              <Text style={styles.error} testID="mobile-routine-error">
                {error}
              </Text>
            ) : null}

            {step === 'goal' || step === 'drafting' ? (
              <>
                <Text style={styles.hint}>
                  The agent turns your recording into a skill with steps and success checks. You
                  review it before anything is saved.
                </Text>
                <Text style={styles.label}>What does this routine do? (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={goal}
                  onChangeText={setGoal}
                  maxLength={500}
                  placeholder="Export the weekly sales report"
                  placeholderTextColor={colors.gray500}
                  editable={!busy}
                  testID="mobile-routine-goal"
                />
                {primary(
                  step === 'drafting' ? 'Asking the agent…' : 'Draft skill',
                  requestDraft,
                  'mobile-routine-draft',
                )}
              </>
            ) : null}

            {(step === 'edit' || step === 'saving') && meta ? (
              <>
                <Text style={styles.hint}>
                  {meta.agentName} drafted this from {meta.steps} recorded step
                  {meta.steps === 1 ? '' : 's'}. Edit anything, then save it.
                </Text>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  style={[styles.input, styles.mono]}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="none"
                  editable={!busy}
                  testID="mobile-routine-name"
                />
                <Text style={styles.label}>Description</Text>
                <TextInput
                  style={styles.input}
                  value={description}
                  onChangeText={setDescription}
                  editable={!busy}
                  testID="mobile-routine-description"
                />
                <Text style={styles.label}>Steps (SKILL.md)</Text>
                <TextInput
                  style={[styles.input, styles.mono, styles.multiline]}
                  value={body}
                  onChangeText={setBody}
                  multiline
                  editable={!busy}
                  testID="mobile-routine-body"
                />
                {problems.length > 0 ? (
                  <Text style={styles.warn}>{problems.join('. ')}.</Text>
                ) : null}
                {primary('Save skill', saveSkill, 'mobile-routine-save', problems.length > 0)}
              </>
            ) : null}

            {step === 'schedule' || step === 'scheduling' ? (
              <>
                <Text style={styles.ok} testID="mobile-routine-saved">
                  Saved skill {savedName}.
                </Text>
                <Text style={styles.hint}>
                  Attach it to a schedule. Each run uses your browser logins and asks you before
                  anything irreversible. Results arrive in your notifications.
                </Text>
                <View style={styles.presets}>
                  {ROUTINE_SCHEDULE_PRESETS.map((p) => (
                    <TouchableOpacity
                      key={p.id}
                      onPress={() => setSchedule(p.cron)}
                      style={[styles.preset, schedule === p.cron && styles.presetOn]}
                      testID={`mobile-routine-preset-${p.id}`}
                    >
                      <Text style={styles.presetText}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>Cron expression</Text>
                <TextInput
                  style={[styles.input, styles.mono]}
                  value={schedule}
                  onChangeText={setSchedule}
                  autoCapitalize="none"
                  editable={!busy}
                  testID="mobile-routine-cron"
                />
                <Text style={styles.hint}>{humanCron(schedule)}</Text>
                <Text style={styles.label}>Notes for each run (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={notes}
                  onChangeText={setNotes}
                  editable={!busy}
                  testID="mobile-routine-notes"
                />
                {primary(
                  'Schedule routine',
                  attachSchedule,
                  'mobile-routine-schedule',
                  !looksLikeCronExpression(schedule),
                )}
                <TouchableOpacity onPress={onClose} disabled={busy} style={styles.secondary}>
                  <Text style={styles.secondaryText}>Not now</Text>
                </TouchableOpacity>
              </>
            ) : null}

            {step === 'done' ? (
              <>
                <Text style={styles.ok} testID="mobile-routine-done">
                  Scheduled {savedName}: {humanCron(schedule)}. Results arrive in your
                  notifications.
                </Text>
                <TouchableOpacity onPress={onClose} style={styles.secondary}>
                  <Text style={styles.secondaryText}>Done</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.gray900,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderWidth: 1,
    borderColor: colors.gray700,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  title: { color: colors.gray100, fontSize: 15, fontWeight: '600' },
  body: { padding: 16, gap: 8 },
  hint: { color: colors.gray400, fontSize: 12 },
  label: { color: colors.gray400, fontSize: 12, marginTop: 4 },
  input: {
    backgroundColor: colors.gray950,
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.gray100,
    fontSize: 14,
  },
  mono: { fontFamily: 'Menlo', fontSize: 12 },
  multiline: { minHeight: 200, textAlignVertical: 'top' },
  warn: { color: colors.amber400, fontSize: 12 },
  error: { color: colors.red400, fontSize: 12 },
  ok: { color: colors.emerald300, fontSize: 12 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.blue600,
  },
  primaryText: { color: colors.gray100, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  secondary: { alignItems: 'center', paddingVertical: 10 },
  secondaryText: { color: colors.gray300, fontSize: 14 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  preset: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  presetOn: { borderColor: colors.sky400, backgroundColor: colors.sky500_15 },
  presetText: { color: colors.gray200, fontSize: 12 },
});
