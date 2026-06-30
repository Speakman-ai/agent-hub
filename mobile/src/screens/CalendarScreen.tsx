import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTime(date: Date) {
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseEventDateTime(value: any) {
  if (!value) return '';
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return raw.slice(0, 16);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw.slice(0, 16) : localDateTime(d);
}

export function defaultCalendarRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { timeMin: start.toISOString(), timeMax: addDays(start, 7).toISOString() };
}

function defaultFormState() {
  const now = new Date();
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);
  return {
    summary: '',
    location: '',
    description: '',
    allDay: false,
    startDate: localDate(now),
    endDate: localDate(addDays(now, 1)),
    startDateTime: localDateTime(start),
    endDateTime: localDateTime(end),
    timeZone: localTimeZone(),
  };
}

function formFromEvent(event: any) {
  const base = defaultFormState();
  const allDay = !!event?.start?.date;
  return {
    ...base,
    summary: event?.summary || '',
    location: event?.location || '',
    description: event?.description || '',
    allDay,
    startDate: event?.start?.date || base.startDate,
    endDate: event?.end?.date || base.endDate,
    startDateTime: parseEventDateTime(event?.start?.dateTime) || base.startDateTime,
    endDateTime: parseEventDateTime(event?.end?.dateTime) || base.endDateTime,
    timeZone: event?.start?.timeZone || event?.end?.timeZone || base.timeZone,
  };
}

function withSeconds(value: string) {
  return value.length === 16 ? `${value}:00` : value;
}

export function buildCalendarEventInput(form: any) {
  return {
    summary: String(form.summary || '').trim(),
    location: String(form.location || '').trim() || undefined,
    description: String(form.description || '').trim() || undefined,
    start: form.allDay
      ? { date: form.startDate }
      : { dateTime: withSeconds(form.startDateTime), timeZone: String(form.timeZone || '').trim() || 'UTC' },
    end: form.allDay
      ? { date: form.endDate }
      : { dateTime: withSeconds(form.endDateTime), timeZone: String(form.timeZone || '').trim() || 'UTC' },
  };
}

export function calendarReturnTo() {
  // Calendar is a global, per-user surface — the return hash carries no project.
  return '/#/calendar';
}

export async function openCalendarOAuth({ apiClient, openURL }: any) {
  const body = await apiClient.startGoogleOAuth({
    returnTo: calendarReturnTo(),
    scopes: [CALENDAR_EVENTS_SCOPE],
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

function hasCalendarScope(status: any) {
  const scopes = status?.grantedScopes || [];
  return scopes.includes(CALENDAR_EVENTS_SCOPE) || scopes.includes('https://www.googleapis.com/auth/calendar');
}

function eventStartMillis(event: any) {
  const raw = event?.start?.dateTime || event?.start?.date;
  if (!raw) return 0;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function eventTimeLabel(event: any) {
  if (event?.start?.date) {
    const d = new Date(`${event.start.date}T00:00:00`);
    return Number.isNaN(d.getTime()) ? event.start.date : d.toLocaleDateString();
  }
  const start = event?.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event?.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start || Number.isNaN(start.getTime())) return 'Time not set';
  const startText = start.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const endText = end && !Number.isNaN(end.getTime()) ? end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  return `${startText}${endText ? ` to ${endText}` : ''}`;
}

export function CalendarAgendaContent({
  loading,
  eventsLoading,
  error,
  status,
  events,
  onRefresh,
  onConnect,
  onOpenSettings,
  onCreate,
  onEdit,
}: any) {
  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const calendarEnabled = hasCalendarScope(status);

  if (loading) {
    return (
      <View style={styles.centerCard}>
        <ActivityIndicator color={colors.blue400} />
        <Text style={styles.muted}>Loading Calendar...</Text>
      </View>
    );
  }

  let empty: any = null;
  if (!configured && !connected) {
    empty = { title: 'Google is not configured', body: 'An Admin needs to add the Google OAuth app before Calendar can connect.', action: 'Open Account settings', onAction: onOpenSettings };
  } else if (!connected) {
    empty = { title: 'Connect Google to use Calendar', body: 'Calendar events stay server-side through the Google proxy. Connect your account to continue.', action: 'Connect Google', onAction: onConnect };
  } else if (!calendarEnabled) {
    empty = { title: 'Enable Calendar access', body: `Connected as ${status?.email || 'Google account'}, but Calendar access has not been granted yet.`, action: 'Enable Calendar', onAction: onConnect };
  } else if (!events?.length && !eventsLoading) {
    empty = { title: 'No events this week', body: 'Create an event or refresh after adding one in Google Calendar.', action: 'Create event', onAction: onCreate };
  }

  return (
    <View style={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Calendar</Text>
          <Text style={styles.title}>Agenda</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={onRefresh} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{eventsLoading ? 'Refreshing' : 'Refresh'}</Text>
          </TouchableOpacity>
          {connected && calendarEnabled ? (
            <TouchableOpacity onPress={onCreate} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Create</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {empty ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>{empty.title}</Text>
          <Text style={styles.emptyBody}>{empty.body}</Text>
          {empty.action ? (
            <TouchableOpacity onPress={empty.onAction} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{empty.action}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item: any, index) => item.id || `${item.summary}-${index}`}
          renderItem={({ item }: any) => (
            <TouchableOpacity onPress={() => onEdit(item)} style={styles.eventCard}>
              <Text style={styles.eventTime}>{eventTimeLabel(item)}</Text>
              <Text style={styles.eventTitle}>{item.summary || '(no title)'}</Text>
              {item.location ? <Text style={styles.eventMeta}>{item.location}</Text> : null}
              {item.description ? <Text style={styles.eventDescription}>{item.description}</Text> : null}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

function EventModal({ event, saving, error, onClose, onSave }: any) {
  const [form, setForm] = useState(() => (event ? formFromEvent(event) : defaultFormState()));
  const setField = (field: string, value: any) => setForm((current: any) => ({ ...current, [field]: value }));
  const valid = String(form.summary || '').trim() && (form.allDay ? form.startDate && form.endDate : form.startDateTime && form.endDateTime);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <ScrollView>
            <Text style={styles.modalTitle}>{event ? 'Edit event' : 'Create event'}</Text>
            <Text style={styles.inputLabel}>Title</Text>
            <TextInput value={form.summary} onChangeText={(v: any) => setField('summary', v)} style={styles.input} placeholderTextColor={colors.gray500} />
            <View style={styles.switchRow}>
              <Text style={styles.inputLabel}>All day</Text>
              <Switch value={form.allDay} onValueChange={(v: any) => setField('allDay', v)} />
            </View>
            {form.allDay ? (
              <>
                <Text style={styles.inputLabel}>Start date</Text>
                <TextInput value={form.startDate} onChangeText={(v: any) => setField('startDate', v)} style={styles.input} placeholder="YYYY-MM-DD" placeholderTextColor={colors.gray500} />
                <Text style={styles.inputLabel}>End date</Text>
                <TextInput value={form.endDate} onChangeText={(v: any) => setField('endDate', v)} style={styles.input} placeholder="YYYY-MM-DD" placeholderTextColor={colors.gray500} />
              </>
            ) : (
              <>
                <Text style={styles.inputLabel}>Starts</Text>
                <TextInput value={form.startDateTime} onChangeText={(v: any) => setField('startDateTime', v)} style={styles.input} placeholder="YYYY-MM-DDTHH:mm" placeholderTextColor={colors.gray500} />
                <Text style={styles.inputLabel}>Ends</Text>
                <TextInput value={form.endDateTime} onChangeText={(v: any) => setField('endDateTime', v)} style={styles.input} placeholder="YYYY-MM-DDTHH:mm" placeholderTextColor={colors.gray500} />
                <Text style={styles.inputLabel}>Time zone</Text>
                <TextInput value={form.timeZone} onChangeText={(v: any) => setField('timeZone', v)} style={styles.input} placeholderTextColor={colors.gray500} />
              </>
            )}
            <Text style={styles.inputLabel}>Location</Text>
            <TextInput value={form.location} onChangeText={(v: any) => setField('location', v)} style={styles.input} placeholderTextColor={colors.gray500} />
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput value={form.description} onChangeText={(v: any) => setField('description', v)} style={[styles.input, styles.textArea]} multiline placeholderTextColor={colors.gray500} />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity disabled={!valid || saving} onPress={() => onSave(form)} style={[styles.primaryButton, (!valid || saving) && styles.disabledButton]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving' : event ? 'Save' : 'Create'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function CalendarScreen({ navigation }: any) {
  const sidebar = React.useContext(SidebarContext);
  const [status, setStatus] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [modalEvent, setModalEvent] = useState<any>(undefined);
  const [modalError, setModalError] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const range = useMemo(() => defaultCalendarRange(), []);

  const load = useCallback(async () => {
    setError(null);
    setEventsLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasCalendarScope(nextStatus)) {
        const body = await api.listGoogleCalendarEvents({ ...range, timeZone: localTimeZone(), maxResults: 100 });
        setEvents([...(body.events || [])].sort((a, b) => eventStartMillis(a) - eventStartMillis(b)));
      } else {
        setEvents([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Calendar');
      setEvents([]);
    } finally {
      setLoading(false);
      setEventsLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const connect = async () => {
    try {
      await openCalendarOAuth({ apiClient: api, openURL: Linking.openURL });
    } catch (err: any) {
      Alert.alert('Google Calendar', err.message || 'Failed to start Google consent');
    }
  };

  const save = async (form: any) => {
    setSaving(true);
    setModalError(null);
    try {
      const event = buildCalendarEventInput(form);
      if (modalEvent?.id) {
        await api.updateGoogleCalendarEvent(modalEvent.id, { calendarId: 'primary', event });
      } else {
        await api.createGoogleCalendarEvent({ calendarId: 'primary', event });
      }
      setModalEvent(undefined);
      await load();
    } catch (err: any) {
      setModalError(err.message || 'Failed to save event');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={sidebar?.toggleSidebar} style={styles.menuButton}>
          <Text style={styles.menuButtonText}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Calendar</Text>
      </View>
      <CalendarAgendaContent
        loading={loading}
        eventsLoading={eventsLoading}
        error={error}
        status={status}
        events={events}
        onRefresh={load}
        onConnect={connect}
        onOpenSettings={() => navigation.navigate('Settings', { tab: 'account' })}
        onCreate={() => setModalEvent(null)}
        onEdit={(event: any) => setModalEvent(event)}
      />
      {modalEvent !== undefined ? (
        <EventModal event={modalEvent} saving={saving} error={modalError} onClose={() => setModalEvent(undefined)} onSave={save} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.gray800 },
  menuButton: { padding: 8, marginRight: 8 },
  menuButtonText: { color: colors.gray300, fontSize: 20 },
  topBarTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  content: { flex: 1, padding: 16 },
  centerCard: { margin: 16, padding: 18, borderWidth: 1, borderColor: colors.gray800, backgroundColor: colors.gray900, borderRadius: 8, alignItems: 'center', gap: 8 },
  muted: { color: colors.gray400, fontSize: 13 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 },
  kicker: { color: colors.blue300, fontSize: 11, textTransform: 'uppercase', fontWeight: '700' },
  title: { color: colors.white, fontSize: 26, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 8 },
  primaryButton: { backgroundColor: colors.blue600, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, alignSelf: 'flex-start' },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  secondaryButton: { borderWidth: 1, borderColor: colors.gray700, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8 },
  secondaryButtonText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  disabledButton: { opacity: 0.5 },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 10 },
  emptyCard: { borderWidth: 1, borderColor: colors.gray800, backgroundColor: colors.gray900, borderRadius: 8, padding: 18, gap: 10 },
  emptyTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  emptyBody: { color: colors.gray400, fontSize: 13, lineHeight: 19 },
  eventCard: { borderWidth: 1, borderColor: colors.gray800, backgroundColor: colors.gray900, borderRadius: 8, padding: 14, marginBottom: 10 },
  eventTime: { color: colors.blue300, fontSize: 12, fontWeight: '700', marginBottom: 6 },
  eventTitle: { color: colors.white, fontSize: 16, fontWeight: '700' },
  eventMeta: { color: colors.gray400, fontSize: 12, marginTop: 4 },
  eventDescription: { color: colors.gray300, fontSize: 13, marginTop: 8, lineHeight: 18 },
  modalBackdrop: { flex: 1, backgroundColor: colors.black60, justifyContent: 'center', padding: 16 },
  modalCard: { maxHeight: '90%', borderRadius: 8, backgroundColor: colors.gray900, borderWidth: 1, borderColor: colors.gray700, padding: 16 },
  modalTitle: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 14 },
  inputLabel: { color: colors.gray400, fontSize: 12, marginBottom: 6, marginTop: 8 },
  input: { color: colors.white, borderWidth: 1, borderColor: colors.gray700, backgroundColor: colors.gray950, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9 },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 8 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
});
