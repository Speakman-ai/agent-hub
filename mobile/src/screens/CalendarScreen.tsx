import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  addMonths,
  defaultCalendarRange,
  monthGridRange,
  startOfMonth,
  eventTimeLabel,
  localTimeZone,
  type CalendarEventLike,
} from '@shared/utils/calendarEvents';
import {
  CALENDAR_HIDDEN_ACCOUNTS_KEY,
  defaultGoogleAccount,
  effectiveHiddenAccounts,
  fetchAcrossGoogleAccounts,
  googleAccountColor,
  googleAccountParam,
  linkedGoogleAccounts,
  mergeAccountEvents,
  parseHiddenAccounts,
  toggleHiddenAccount,
  withoutHiddenAccounts,
  type AccountTagged,
  type GoogleAccountFetchFailure,
  type LinkedGoogleAccount,
} from '@shared/utils/googleAccounts';
import { buildCalendarTodoDraft } from '@shared/utils/captureTodo';
import { buildCalendarCardDraft, type CaptureCardDraft } from '@shared/utils/captureCard';
import CaptureToTicketModal from '../components/CaptureToTicketModal';
import CalendarMonthView from '../components/CalendarMonthView';

export { defaultCalendarRange };

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const AGENDA_MAX_RESULTS = 100;
// A busy six-week grid can exceed the agenda's cap; Google allows up to 2500.
export const MONTH_MAX_RESULTS = 500;

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
      : {
          dateTime: withSeconds(form.startDateTime),
          timeZone: String(form.timeZone || '').trim() || 'UTC',
        },
    end: form.allDay
      ? { date: form.endDate }
      : {
          dateTime: withSeconds(form.endDateTime),
          timeZone: String(form.timeZone || '').trim() || 'UTC',
        },
  };
}

export function calendarReturnTo() {
  // Calendar is a global, per-user surface — the return hash carries no project.
  return '/#/calendar';
}

export async function openCalendarOAuth({ apiClient, openURL, accountId }: any) {
  const body = await apiClient.startGoogleOAuth({
    returnTo: calendarReturnTo(),
    scopes: [CALENDAR_EVENTS_SCOPE],
    ...(accountId ? { accountId } : {}),
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

type CalendarEvent = AccountTagged<CalendarEventLike>;

/**
 * Read events from every account in parallel, tag them by account, and merge
 * them onto one timeline. Exported so the fan-out is testable without a
 * native runtime.
 */
export async function loadCalendarEventsAcrossAccounts(
  apiClient: any,
  accounts: LinkedGoogleAccount[],
  query: { timeMin: string; timeMax: string; maxResults: number },
): Promise<{ events: CalendarEvent[]; failures: GoogleAccountFetchFailure[] }> {
  const { items, failures } = await fetchAcrossGoogleAccounts<CalendarEventLike>(
    accounts,
    async (account) => {
      const body = await apiClient.listGoogleCalendarEvents({
        ...query,
        timeZone: localTimeZone(),
        account: googleAccountParam(account),
      });
      return body?.events || [];
    },
  );
  return { events: mergeAccountEvents(items), failures };
}

function failureText(failures: GoogleAccountFetchFailure[]) {
  return failures.map((f) => `${f.account.email || 'Google account'}: ${f.error}`).join('; ');
}

export function hasCalendarScope(status: any) {
  const scopes = status?.grantedScopes || [];
  return (
    scopes.includes(CALENDAR_EVENTS_SCOPE) ||
    scopes.includes('https://www.googleapis.com/auth/calendar')
  );
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
  onCapture,
  onTicket,
  capturingId,
  capturedId,
  monthView,
  hiddenAccounts = [],
  failedAccountIds = [],
  onToggleAccount,
  onEnableAccount,
}: any) {
  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const accounts = linkedGoogleAccounts(status);
  const calendarEnabled = accounts.some((a) => hasCalendarScope(a));
  const multiAccount = accounts.length > 1;
  // With one account left the toggles are gone, so a stored hide must not apply.
  const hidden = effectiveHiddenAccounts(hiddenAccounts, accounts);
  const visibleEvents = withoutHiddenAccounts<any>(events || [], hidden);

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
    empty = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Calendar can connect.',
      action: 'Open Account settings',
      onAction: onOpenSettings,
    };
  } else if (!connected) {
    empty = {
      title: 'Connect Google to use Calendar',
      body: 'Calendar events stay server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: onConnect,
    };
  } else if (!calendarEnabled) {
    empty = {
      title: 'Enable Calendar access',
      body: `Connected as ${status?.email || 'Google account'}, but Calendar access has not been granted yet.`,
      action: 'Enable Calendar',
      onAction: onConnect,
    };
  } else if (events?.length && !visibleEvents.length && !eventsLoading) {
    empty = {
      title: 'All accounts hidden',
      body: 'Turn an account back on above to see its events.',
      action: null,
    };
  } else if (!events?.length && !eventsLoading) {
    empty = {
      title: 'No events this week',
      body: 'Create an event or refresh after adding one in Google Calendar.',
      action: 'Create event',
      onAction: onCreate,
    };
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
            <Text style={styles.secondaryButtonText}>
              {eventsLoading ? 'Refreshing' : 'Refresh'}
            </Text>
          </TouchableOpacity>
          {connected && calendarEnabled ? (
            <TouchableOpacity onPress={onCreate} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Create</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {connected && multiAccount ? (
        <CalendarAccountBar
          accounts={accounts}
          hiddenAccounts={hidden}
          failedAccountIds={failedAccountIds}
          onToggle={onToggleAccount}
          onEnable={onEnableAccount}
        />
      ) : null}

      {empty ? (
        <ScrollView>
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{empty.title}</Text>
            <Text style={styles.emptyBody}>{empty.body}</Text>
            {empty.action ? (
              <TouchableOpacity onPress={empty.onAction} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>{empty.action}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {calendarEnabled && connected ? monthView : null}
        </ScrollView>
      ) : (
        <FlatList
          data={visibleEvents}
          ListFooterComponent={monthView || null}
          keyExtractor={(item: any, index) =>
            `${item.accountId ?? ''}:${item.id || `${item.summary}-${index}`}`
          }
          renderItem={({ item }: any) => {
            const key = item.id || item.summary || '';
            const isCaptured = capturedId === key;
            return (
              <TouchableOpacity
                onPress={() => onEdit(item)}
                style={[
                  styles.eventCard,
                  multiAccount
                    ? {
                        borderLeftWidth: 3,
                        borderLeftColor: googleAccountColor(accounts, item.accountId),
                      }
                    : null,
                ]}
              >
                <Text style={styles.eventTime}>{eventTimeLabel(item)}</Text>
                {multiAccount && item.accountEmail ? (
                  <Text style={styles.eventMeta}>{item.accountEmail}</Text>
                ) : null}
                <Text style={styles.eventTitle}>{item.summary || '(no title)'}</Text>
                {item.location ? <Text style={styles.eventMeta}>{item.location}</Text> : null}
                {item.description ? (
                  <Text style={styles.eventDescription}>{item.description}</Text>
                ) : null}
                <View style={styles.captureRow}>
                  <TouchableOpacity
                    onPress={() => onCapture(item)}
                    disabled={capturingId === key}
                    style={styles.captureButton}
                    accessibilityLabel="Add to todos"
                  >
                    <Text style={styles.captureButtonText}>
                      {capturingId === key
                        ? 'Adding…'
                        : isCaptured
                          ? '✓ Added to todos'
                          : '+ Add to todos'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => onTicket(item)}
                    style={styles.captureButton}
                    accessibilityLabel="Create ticket"
                  >
                    <Text style={styles.captureButtonText}>+ Ticket</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

/**
 * One chip per linked account: tap to show or hide its events, or to grant
 * Calendar access to an account that hasn't.
 */
export function CalendarAccountBar({
  accounts,
  hiddenAccounts = [],
  failedAccountIds = [],
  onToggle,
  onEnable,
}: {
  accounts: LinkedGoogleAccount[];
  hiddenAccounts?: string[];
  failedAccountIds?: string[];
  onToggle?: (accountId: string) => void;
  onEnable?: (accountId: string) => void;
}) {
  return (
    <View style={styles.accountBar}>
      {accounts.map((account) => {
        const enabled = hasCalendarScope(account);
        const visible = enabled && !hiddenAccounts.includes(account.accountId);
        const failed = failedAccountIds.includes(account.accountId);
        return (
          <TouchableOpacity
            key={account.accountId}
            onPress={() =>
              enabled ? onToggle?.(account.accountId) : onEnable?.(account.accountId)
            }
            style={[styles.accountChip, !visible && styles.accountChipOff]}
            accessibilityRole={enabled ? 'switch' : 'button'}
            accessibilityState={enabled ? { checked: visible } : undefined}
            accessibilityLabel={
              enabled ? `Show ${account.email}` : `Enable Calendar for ${account.email}`
            }
          >
            <View
              style={[
                styles.accountDot,
                {
                  backgroundColor: visible
                    ? googleAccountColor(accounts, account.accountId)
                    : colors.gray600,
                },
              ]}
            />
            <Text style={styles.accountChipText} numberOfLines={1}>
              {account.email}
            </Text>
            {!enabled ? <Text style={styles.accountChipAction}>Enable</Text> : null}
            {failed ? <Text style={styles.accountChipError}>!</Text> : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function EventModal({ event, accounts = [], saving, error, onClose, onSave }: any) {
  const [form, setForm] = useState(() => (event ? formFromEvent(event) : defaultFormState()));
  const [accountId, setAccountId] = useState<string>(
    () => event?.accountId ?? defaultGoogleAccount(accounts)?.accountId ?? '',
  );
  const setField = (field: string, value: any) =>
    setForm((current: any) => ({ ...current, [field]: value }));
  const valid =
    String(form.summary || '').trim() &&
    (form.allDay ? form.startDate && form.endDate : form.startDateTime && form.endDateTime);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <ScrollView>
            <Text style={styles.modalTitle}>{event ? 'Edit event' : 'Create event'}</Text>
            {event?.accountEmail ? (
              <Text style={styles.eventMeta}>Calendar: {event.accountEmail}</Text>
            ) : null}
            {!event && accounts.length > 1 ? (
              <>
                <Text style={styles.inputLabel}>Account</Text>
                <View style={styles.accountBar}>
                  {accounts.map((a: LinkedGoogleAccount) => (
                    <TouchableOpacity
                      key={a.accountId}
                      onPress={() => setAccountId(a.accountId)}
                      style={[
                        styles.accountChip,
                        accountId !== a.accountId && styles.accountChipOff,
                      ]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: accountId === a.accountId }}
                      accessibilityLabel={`Create in ${a.email}`}
                    >
                      <Text style={styles.accountChipText}>
                        {a.email}
                        {a.isDefault ? ' (default)' : ''}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
            <Text style={styles.inputLabel}>Title</Text>
            <TextInput
              value={form.summary}
              onChangeText={(v: any) => setField('summary', v)}
              style={styles.input}
              placeholderTextColor={colors.gray500}
            />
            <View style={styles.switchRow}>
              <Text style={styles.inputLabel}>All day</Text>
              <Switch value={form.allDay} onValueChange={(v: any) => setField('allDay', v)} />
            </View>
            {form.allDay ? (
              <>
                <Text style={styles.inputLabel}>Start date</Text>
                <TextInput
                  value={form.startDate}
                  onChangeText={(v: any) => setField('startDate', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.gray500}
                />
                <Text style={styles.inputLabel}>End date</Text>
                <TextInput
                  value={form.endDate}
                  onChangeText={(v: any) => setField('endDate', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.gray500}
                />
              </>
            ) : (
              <>
                <Text style={styles.inputLabel}>Starts</Text>
                <TextInput
                  value={form.startDateTime}
                  onChangeText={(v: any) => setField('startDateTime', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DDTHH:mm"
                  placeholderTextColor={colors.gray500}
                />
                <Text style={styles.inputLabel}>Ends</Text>
                <TextInput
                  value={form.endDateTime}
                  onChangeText={(v: any) => setField('endDateTime', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DDTHH:mm"
                  placeholderTextColor={colors.gray500}
                />
                <Text style={styles.inputLabel}>Time zone</Text>
                <TextInput
                  value={form.timeZone}
                  onChangeText={(v: any) => setField('timeZone', v)}
                  style={styles.input}
                  placeholderTextColor={colors.gray500}
                />
              </>
            )}
            <Text style={styles.inputLabel}>Location</Text>
            <TextInput
              value={form.location}
              onChangeText={(v: any) => setField('location', v)}
              style={styles.input}
              placeholderTextColor={colors.gray500}
            />
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput
              value={form.description}
              onChangeText={(v: any) => setField('description', v)}
              style={[styles.input, styles.textArea]}
              multiline
              placeholderTextColor={colors.gray500}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={!valid || saving}
                onPress={() => onSave(form, accountId)}
                style={[styles.primaryButton, (!valid || saving) && styles.disabledButton]}
              >
                <Text style={styles.primaryButtonText}>
                  {saving ? 'Saving' : event ? 'Save' : 'Create'}
                </Text>
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
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [capturedId, setCapturedId] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
  const range = useMemo(() => defaultCalendarRange(), []);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [monthEvents, setMonthEvents] = useState<any[]>([]);
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthError, setMonthError] = useState<string | null>(null);
  const [monthReload, setMonthReload] = useState(0);
  const [hiddenAccounts, setHiddenAccounts] = useState<string[]>([]);
  const [failedAccountIds, setFailedAccountIds] = useState<string[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(CALENDAR_HIDDEN_ACCOUNTS_KEY)
      .then((raw) => setHiddenAccounts(parseHiddenAccounts(raw)))
      .catch(() => {});
  }, []);

  const accounts = useMemo(() => linkedGoogleAccounts(status), [status]);
  const calendarAccounts = useMemo(() => accounts.filter((a) => hasCalendarScope(a)), [accounts]);
  const calendarAccountKey = calendarAccounts.map((a) => a.accountId).join(',');

  // Only the newest agenda load and the modal session a save started in may
  // commit state; an overlapping refresh or a reopened modal must not be
  // overwritten by a slower, older completion.
  const loadSeq = useRef(0);
  const modalSession = useRef(0);
  const showModal = (event: any) => {
    modalSession.current += 1;
    setModalError(null);
    setSaving(false);
    setModalEvent(event);
  };

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    setError(null);
    setEventsLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      if (!current()) return;
      setStatus(nextStatus);
      const readable = linkedGoogleAccounts(nextStatus).filter((a) => hasCalendarScope(a));
      if (nextStatus.connected && readable.length) {
        const { events: merged, failures } = await loadCalendarEventsAcrossAccounts(api, readable, {
          ...range,
          maxResults: AGENDA_MAX_RESULTS,
        });
        if (!current()) return;
        setEvents(merged);
        setFailedAccountIds(failures.map((f) => f.account.accountId));
        if (failures.length === readable.length) setError(failureText(failures));
      } else {
        setEvents([]);
        setFailedAccountIds([]);
      }
    } catch (err: any) {
      if (!current()) return;
      setError(err.message || 'Failed to load Calendar');
      setEvents([]);
    } finally {
      if (current()) {
        setLoading(false);
        setEventsLoading(false);
      }
    }
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const calendarReady = !!status?.connected && calendarAccounts.length > 0;

  useEffect(() => {
    if (!calendarReady) {
      setMonthEvents([]);
      setMonthError(null);
      return;
    }
    let cancelled = false;
    setMonthLoading(true);
    setMonthError(null);
    loadCalendarEventsAcrossAccounts(api, calendarAccounts, {
      ...monthGridRange(month),
      maxResults: MONTH_MAX_RESULTS,
    })
      .then(({ events: merged, failures }) => {
        if (cancelled) return;
        setMonthEvents(merged);
        // Keep the error on the grid itself: month navigation only fires this
        // request, so the agenda banner above never sees the failure.
        setMonthError(failures.length ? failureText(failures) : null);
      })
      .finally(() => {
        if (!cancelled) setMonthLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // calendarAccountKey tracks calendarAccounts by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarReady, calendarAccountKey, month, monthReload]);

  const toggleAccount = (accountId: string) => {
    setHiddenAccounts((current) => {
      const next = toggleHiddenAccount(current, accountId);
      AsyncStorage.setItem(CALENDAR_HIDDEN_ACCOUNTS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const refresh = () => {
    setMonthReload((n) => n + 1);
    return load();
  };

  const connect = async (accountId?: string) => {
    try {
      await openCalendarOAuth({ apiClient: api, openURL: Linking.openURL, accountId });
    } catch (err: any) {
      Alert.alert('Google Calendar', err.message || 'Failed to start Google consent');
    }
  };

  const capture = async (event: any) => {
    const key = event.id || event.summary || '';
    setCapturingId(key);
    try {
      await api.createTodo(buildCalendarTodoDraft(event));
      setCapturedId(key);
      setTimeout(() => setCapturedId((cur) => (cur === key ? null : cur)), 2000);
    } catch (err: any) {
      Alert.alert('Todos', err.message || 'Failed to add to todos');
    } finally {
      setCapturingId((cur) => (cur === key ? null : cur));
    }
  };

  const save = async (form: any, accountId: string) => {
    const session = modalSession.current;
    const current = () => session === modalSession.current;
    setSaving(true);
    setModalError(null);
    try {
      const event = buildCalendarEventInput(form);
      // An edit stays on the account that owns the event; a new one goes to
      // the account picked in the modal.
      const account = (modalEvent?.id ? modalEvent.accountId : accountId) || undefined;
      if (modalEvent?.id) {
        await api.updateGoogleCalendarEvent(
          modalEvent.id,
          { calendarId: 'primary', event },
          { account },
        );
      } else {
        await api.createGoogleCalendarEvent({ calendarId: 'primary', event }, { account });
      }
      // The event is saved either way; only close the modal it was saved from.
      if (current()) showModal(undefined);
      await refresh();
    } catch (err: any) {
      if (current()) setModalError(err.message || 'Failed to save event');
    } finally {
      if (current()) setSaving(false);
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
        onRefresh={refresh}
        onConnect={() => connect(defaultGoogleAccount(accounts)?.accountId || undefined)}
        hiddenAccounts={hiddenAccounts}
        failedAccountIds={failedAccountIds}
        onToggleAccount={toggleAccount}
        onEnableAccount={(accountId: string) => connect(accountId)}
        onOpenSettings={() => navigation.navigate('Settings', { tab: 'account' })}
        onCreate={() => showModal(null)}
        onEdit={(event: any) => showModal(event)}
        onCapture={capture}
        onTicket={(event: any) => setTicketDraft(buildCalendarCardDraft(event))}
        capturingId={capturingId}
        capturedId={capturedId}
        monthView={
          calendarReady ? (
            <CalendarMonthView
              month={month}
              events={withoutHiddenAccounts<CalendarEvent>(
                monthEvents,
                effectiveHiddenAccounts(hiddenAccounts, accounts),
              )}
              eventColor={
                accounts.length > 1
                  ? (event) => googleAccountColor(accounts, (event as CalendarEvent).accountId)
                  : undefined
              }
              loading={monthLoading}
              error={monthError}
              onRetry={() => setMonthReload((n) => n + 1)}
              onPrev={() => setMonth((m) => addMonths(m, -1))}
              onNext={() => setMonth((m) => addMonths(m, 1))}
              onToday={() => setMonth(startOfMonth(new Date()))}
              onSelectEvent={(event: any) => showModal(event)}
            />
          ) : null
        }
      />
      {modalEvent !== undefined ? (
        <EventModal
          event={modalEvent}
          accounts={calendarAccounts}
          saving={saving}
          error={modalError}
          onClose={() => showModal(undefined)}
          onSave={save}
        />
      ) : null}
      {ticketDraft ? (
        <CaptureToTicketModal draft={ticketDraft} onClose={() => setTicketDraft(null)} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  accountBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  accountChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray900,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '100%',
  },
  accountChipOff: { opacity: 0.55 },
  accountDot: { width: 8, height: 8, borderRadius: 4 },
  accountChipText: { color: colors.gray300, fontSize: 12, flexShrink: 1 },
  accountChipAction: { color: colors.blue300, fontSize: 12, fontWeight: '600' },
  accountChipError: { color: colors.red400, fontSize: 12, fontWeight: '700' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.gray800,
  },
  menuButton: { padding: 8, marginRight: 8 },
  menuButtonText: { color: colors.gray300, fontSize: 20 },
  topBarTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  content: { flex: 1, padding: 16 },
  centerCard: {
    margin: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
  },
  muted: { color: colors.gray400, fontSize: 13 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  kicker: { color: colors.blue300, fontSize: 11, textTransform: 'uppercase', fontWeight: '700' },
  title: { color: colors.white, fontSize: 26, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: 8 },
  primaryButton: {
    backgroundColor: colors.blue600,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  primaryButtonText: { color: colors.white, fontSize: 13, fontWeight: '700' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
  },
  secondaryButtonText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  disabledButton: { opacity: 0.5 },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 10 },
  emptyCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 18,
    gap: 10,
  },
  emptyTitle: { color: colors.white, fontSize: 18, fontWeight: '700' },
  emptyBody: { color: colors.gray400, fontSize: 13, lineHeight: 19 },
  eventCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  eventTime: { color: colors.blue300, fontSize: 12, fontWeight: '700', marginBottom: 6 },
  eventTitle: { color: colors.white, fontSize: 16, fontWeight: '700' },
  eventMeta: { color: colors.gray400, fontSize: 12, marginTop: 4 },
  eventDescription: { color: colors.gray300, fontSize: 13, marginTop: 8, lineHeight: 18 },
  captureRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  captureButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  captureButtonText: { color: colors.blue300, fontSize: 12, fontWeight: '600' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.black60,
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    maxHeight: '90%',
    borderRadius: 8,
    backgroundColor: colors.gray900,
    borderWidth: 1,
    borderColor: colors.gray700,
    padding: 16,
  },
  modalTitle: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 14 },
  inputLabel: { color: colors.gray400, fontSize: 12, marginBottom: 6, marginTop: 8 },
  input: {
    color: colors.white,
    borderWidth: 1,
    borderColor: colors.gray700,
    backgroundColor: colors.gray950,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  textArea: { minHeight: 80, textAlignVertical: 'top' },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 8,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
});
