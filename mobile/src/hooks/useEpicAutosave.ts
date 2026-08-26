import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../utils/api';
import { epicFormToUpdateBody } from '../utils/epics';

export type EpicAutosaveState = 'idle' | 'saving' | 'saved' | 'error';

type PendingEdit = { epicId: string; form: any; epicName: string };

/**
 * Debounced, serialized persistence for existing epic edit forms.
 * Creation remains explicit because an incomplete draft is not an epic yet.
 *
 * The pending edit is captured at schedule() time (epic id + form snapshot +
 * last stored name) rather than read from live refs at flush time. Refs
 * advance to the next epic during render, so reading them at teardown would
 * either target the wrong epic or lose the edit entirely. Capturing up front
 * lets every teardown path — epic switch or unmount — flush the correct
 * outgoing edit instead of silently dropping it (there is no Save button).
 */
export function useEpicAutosave({ projectId, epic, form, onSaved }: any) {
  const [state, setState] = useState<EpicAutosaveState>('idle');
  const formRef = useRef(form);
  const epicRef = useRef(epic);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef(Promise.resolve());
  const pendingRef = useRef<PendingEdit | null>(null);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const epicId = epic?.id || null;

  formRef.current = form;
  epicRef.current = epic;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    // A temporarily empty name is a valid editing state but not a valid server
    // value. Preserve the last stored epic name so the other fields (color,
    // branch, schedule, …) still autosave, matching the web implementation.
    const effectiveName = pending.form.name?.trim() || pending.epicName || '';
    if (!effectiveName) return;
    const payload = epicFormToUpdateBody({ ...pending.form, name: effectiveName });
    const targetEpicId = pending.epicId;

    const revision = revisionRef.current;
    pendingRef.current = null;
    if (mountedRef.current) setState('saving');
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        const updated = await api.updateEpic(projectId, targetEpicId, payload);
        onSaved?.(updated);
        if (mountedRef.current && revision === revisionRef.current && !pendingRef.current) {
          setState('saved');
          savedTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setState('idle');
          }, 1600);
        }
      })
      .catch(() => {
        if (mountedRef.current && revision === revisionRef.current && !pendingRef.current) {
          setState('error');
        }
      });
  }, [onSaved, projectId]);

  // Always invoke the latest flush from teardown effects without making those
  // effects depend on it (which would re-run them on every keystroke).
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const schedule = useCallback(
    (nextForm: any, immediate = false) => {
      formRef.current = nextForm;
      if (!epicId) return;
      pendingRef.current = { epicId, form: nextForm, epicName: epicRef.current?.name || '' };
      revisionRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flushRef.current(), immediate ? 0 : 500);
    },
    [epicId],
  );

  // Reset UI state for the incoming epic; on the way out (epic switch OR
  // unmount) flush any pending edit before the debounce timer is torn down.
  useEffect(() => {
    revisionRef.current += 1;
    if (mountedRef.current) setState('idle');
    return () => {
      flushRef.current();
    };
  }, [epicId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  return { state, schedule, flush };
}

export function epicAutosaveLabel(state: EpicAutosaveState): string {
  if (state === 'saving') return 'Saving changes…';
  if (state === 'saved') return 'Saved';
  if (state === 'error') return 'Could not save changes. Edit a field to retry.';
  return 'Changes save automatically';
}
