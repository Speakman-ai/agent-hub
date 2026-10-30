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
  CALENDAR_VIEW_KEY,
  CALENDAR_VIEW_LABELS,
  CALENDAR_VIEW_MODES,
  defaultCalendarRange,
  listViewLabel,
  listViewRange,
  monthGridRange,
  parseCalendarView,
  shiftListAnchor,
  startOfDay,
  startOfMonth,
  eventTimeLabel,
  localTimeZone,
  type CalendarEventLike,
  type CalendarViewMode,
} from '@shared/utils/calendarEvents';
import {
  CALENDAR_HIDDEN_ACCOUNTS_KEY,
  defaultGoogleAccount,
  effectiveHiddenAccounts,
  googleAccountColor,
  googleAccountParam,
  linkedGoogleAccounts,
  mergeAccountEvents,
  parseHiddenAccounts,
  toggleHiddenAccount,
  withoutHiddenAccounts,
  type AccountTagged,
  type LinkedGoogleAccount,
} from '@shared/utils/googleAccounts';
import {
  CALENDAR_LIST_READONLY_SCOPE,
  CALENDAR_VISIBILITY_KEY,
  calendarCount,
  calendarFailureText,
  calendarLoadWarning,
  calendarSourcesKey,
  fetchAcrossCalendars,
  isCalendarVisible,
  loadAccountCalendars,
  parseCalendarVisibility,
  toggleCalendarVisibility,
  withCalendarMeta,
  withoutHiddenCalendars,
  type AccountCalendars,
  type CalendarFetchFailure,
  type CalendarTag,
  type CalendarVisibility,
  type GoogleCalendarEntry,
} from '@shared/utils/googleCalendars';
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
    scopes: [CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_READONLY_SCOPE],
    ...(accountId ? { accountId } : {}),
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

type CalendarEvent = AccountTagged<CalendarEventLike> & Partial<CalendarTag>;

/** Each account's calendars, or its primary alone when they can't be listed. */
export function loadCalendarSources(
  apiClient: any,
  accounts: LinkedGoogleAccount[],
): Promise<AccountCalendars[]> {
  return loadAccountCalendars(accounts, (account) =>
    apiClient.listGoogleCalendars({ account: googleAccountParam(account) }),
  );
}

/**
 * Read every calendar in parallel, tag events by account and calendar, and
 * merge them onto one timeline. Exported so the fan-out is testable without a
 * native runtime.
 */
export async function loadCalendarEventsAcrossCalendars(
  apiClient: any,
  sources: AccountCalendars[],
  query: { timeMin: string; timeMax: string; maxResults: number },
): Promise<{ events: CalendarEvent[]; failures: CalendarFetchFailure[] }> {
  const { items, failures } = await fetchAcrossCalendars<CalendarEventLike>(
    sources,
    async (account, calendar) => {
      const body = await apiClient.listGoogleCalendarEvents({
        ...query,
        timeZone: localTimeZone(),
        account: googleAccountParam(account),
        calendarId: calendar.id === 'primary' ? undefined : calendar.id,
      });
      return body?.events || [];
    },
  );
  return { events: mergeAccountEvents(items), failures };
}

/** Where an event is written: the calendar it came from, else the primary. */
export function eventCalendarId(event: { calendarId?: string | null } | null | undefined) {
  return event?.calendarId || 'primary';
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
  warning = null,
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
  calendarSources = [],
  calendarVisibility = {},
  failedCalendarKeys = [],
  onToggleCalendar,
  onShowOtherCalendars,
  view = 'month',
  onChangeView,
  listLabel = '',
  onListPrev,
  onListNext,
  onListToday,
}: any) {
  const listMode = view === 'day' ? 'day' : 'week';
  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const accounts = linkedGoogleAccounts(status);
  const calendarEnabled = accounts.some((a) => hasCalendarScope(a));
  const multiAccount = accounts.length > 1;
  // With one account left the toggles are gone, so a stored hide must not apply.
  const hidden = effectiveHiddenAccounts(hiddenAccounts, accounts);
  const sources = calendarSources as AccountCalendars[];
  const multiCalendar = calendarCount(sources) > 1;
  const needsListScope = sources.filter((src) => !src.listGranted);
  // Calendar name, color and edit rights come from the current list, so the
  // agenda and the month grid always agree, whichever was fetched last.
  const visibleEvents = withCalendarMeta<any>(
    withoutHiddenCalendars<any>(
      withoutHiddenAccounts<any>(events || [], hidden),
      sources,
      calendarVisibility,
    ),
    sources,
  );
  const accentFor = (item: CalendarEvent) =>
    (multiCalendar && item.calendarColor) || googleAccountColor(accounts, item.accountId);

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
  }
  // Setup states replace every view; the rest only describe the list.
  const setupState = !!empty;
  if (!setupState && !eventsLoading) {
    if (events?.length && !visibleEvents.length) {
      empty = {
        title: multiCalendar ? 'All calendars hidden' : 'All accounts hidden',
        body: multiCalendar
          ? 'Turn a calendar back on above to see its events.'
          : 'Turn an account back on above to see its events.',
        action: null,
      };
    } else if (!events?.length) {
      empty = {
        title: listMode === 'week' ? 'No events this week' : 'No events this day',
        body: 'Create an event or refresh after adding one in Google Calendar.',
        action: 'Create event',
        onAction: onCreate,
      };
    }
  }

  return (
    <View style={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Calendar</Text>
          <Text style={styles.title}>{view === 'month' ? 'Calendar' : 'Agenda'}</Text>
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

      {connected && calendarEnabled ? (
        <View style={styles.viewToggle} accessibilityLabel="Calendar view">
          {CALENDAR_VIEW_MODES.map((mode) => (
            <TouchableOpacity
              key={mode}
              onPress={() => onChangeView?.(mode)}
              style={[styles.viewToggleButton, view === mode && styles.viewToggleButtonOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: view === mode }}
              accessibilityLabel={CALENDAR_VIEW_LABELS[mode as CalendarViewMode]}
            >
              <Text style={[styles.viewToggleText, view === mode && styles.viewToggleTextOn]}>
                {CALENDAR_VIEW_LABELS[mode as CalendarViewMode]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {!error && warning ? (
        <Text style={styles.warningText} accessibilityRole="alert">
          {warning}
        </Text>
      ) : null}

      {connected && multiAccount ? (
        <CalendarAccountBar
          accounts={accounts}
          hiddenAccounts={hidden}
          failedAccountIds={failedAccountIds}
          onToggle={onToggleAccount}
          onEnable={onEnableAccount}
        />
      ) : null}

      {connected && (multiCalendar || needsListScope.length > 0) ? (
        <CalendarListBar
          sources={sources}
          visibility={calendarVisibility}
          multiAccount={multiAccount}
          showToggles={multiCalendar}
          accounts={accounts}
          failedKeys={failedCalendarKeys}
          onToggle={onToggleCalendar}
          onShowOtherCalendars={onShowOtherCalendars}
        />
      ) : null}

      {!setupState && view !== 'month' ? (
        <View style={styles.listNav}>
          <Text style={styles.listNavTitle} numberOfLines={1}>
            {listLabel}
          </Text>
          <View style={styles.listNavButtons}>
            <TouchableOpacity
              onPress={onListPrev}
              style={styles.listNavButton}
              accessibilityLabel={`Previous ${listMode}`}
            >
              <Text style={styles.secondaryButtonText}>‹</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onListToday} style={styles.listNavButton}>
              <Text style={styles.secondaryButtonText}>Today</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onListNext}
              style={styles.listNavButton}
              accessibilityLabel={`Next ${listMode}`}
            >
              <Text style={styles.secondaryButtonText}>›</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {!setupState && view === 'month' ? (
        <ScrollView>{monthView}</ScrollView>
      ) : empty ? (
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
        </ScrollView>
      ) : (
        <FlatList
          data={visibleEvents}
          keyExtractor={(item: any, index) =>
            `${item.accountId ?? ''}:${eventCalendarId(item)}:${item.id || `${item.summary}-${index}`}`
          }
          renderItem={({ item }: any) => {
            const key = item.id || item.summary || '';
            const isCaptured = capturedId === key;
            return (
              <TouchableOpacity
                onPress={() => onEdit(item)}
                style={[
                  styles.eventCard,
                  multiAccount || multiCalendar
                    ? { borderLeftWidth: 3, borderLeftColor: accentFor(item) }
                    : null,
                ]}
              >
                <Text style={styles.eventTime}>{eventTimeLabel(item)}</Text>
                {multiCalendar && item.calendarName ? (
                  <Text style={styles.eventMeta}>{item.calendarName}</Text>
                ) : multiAccount && item.accountEmail ? (
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

/**
 * One chip per calendar (Google's checked calendars start on), plus a prompt
 * for accounts that still need the calendar-list scope.
 */
export function CalendarListBar({
  sources,
  visibility = {},
  multiAccount = false,
  showToggles = true,
  accounts = [],
  failedKeys = [],
  onToggle,
  onShowOtherCalendars,
}: {
  sources: AccountCalendars[];
  visibility?: CalendarVisibility;
  multiAccount?: boolean;
  /** False with a lone calendar: it gets no toggle and is never hidden. */
  showToggles?: boolean;
  accounts?: LinkedGoogleAccount[];
  failedKeys?: string[];
  onToggle?: (accountId: string, calendar: GoogleCalendarEntry) => void;
  onShowOtherCalendars?: (accountId: string) => void;
}) {
  return (
    <View style={styles.accountBar}>
      {(showToggles ? sources : []).map((source) =>
        source.calendars.map((calendar) => {
          const accountId = source.account.accountId;
          const visible = isCalendarVisible(accountId, calendar, visibility);
          const failed = failedKeys.includes(`${accountId}|${calendar.id}`);
          return (
            <TouchableOpacity
              key={`${accountId}|${calendar.id}`}
              onPress={() => onToggle?.(accountId, calendar)}
              style={[styles.accountChip, !visible && styles.accountChipOff]}
              accessibilityRole="switch"
              accessibilityState={{ checked: visible }}
              accessibilityLabel={`Show calendar ${calendar.summary}`}
            >
              <View
                style={[
                  styles.accountDot,
                  {
                    backgroundColor: visible
                      ? calendar.backgroundColor || googleAccountColor(accounts, accountId)
                      : colors.gray600,
                  },
                ]}
              />
              <Text style={styles.accountChipText} numberOfLines={1}>
                {calendar.summary}
              </Text>
              {failed ? <Text style={styles.accountChipError}>!</Text> : null}
            </TouchableOpacity>
          );
        }),
      )}
      {sources
        .filter((source) => !source.listGranted)
        .map((source) => (
          <TouchableOpacity
            key={`list-scope-${source.account.accountId}`}
            onPress={() => onShowOtherCalendars?.(source.account.accountId)}
            style={styles.accountChip}
            accessibilityRole="button"
          >
            <Text style={styles.accountChipAction}>
              {multiAccount
                ? `Show other calendars for ${source.account.email}`
                : 'Show your other calendars'}
            </Text>
          </TouchableOpacity>
        ))}
    </View>
  );
}

export function EventModal({ event, accounts = [], saving, error, onClose, onSave }: any) {
  // Events from calendars shared with read access can be viewed, not saved.
  const readOnly = !!event && event.calendarWritable === false;
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
            <Text style={styles.modalTitle}>
              {readOnly ? 'Event' : event ? 'Edit event' : 'Create event'}
            </Text>
            {event?.accountEmail || event?.calendarName ? (
              <Text style={styles.eventMeta}>
                Calendar: {event.calendarName || event.accountEmail}
                {event.calendarName && event.accountEmail ? ` · ${event.accountEmail}` : ''}
                {readOnly ? ' · read-only' : ''}
              </Text>
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
              editable={!readOnly}
              value={form.summary}
              onChangeText={(v: any) => setField('summary', v)}
              style={styles.input}
              placeholderTextColor={colors.gray500}
            />
            <View style={styles.switchRow}>
              <Text style={styles.inputLabel}>All day</Text>
              <Switch
                value={form.allDay}
                disabled={readOnly}
                onValueChange={(v: any) => setField('allDay', v)}
              />
            </View>
            {form.allDay ? (
              <>
                <Text style={styles.inputLabel}>Start date</Text>
                <TextInput
                  editable={!readOnly}
                  value={form.startDate}
                  onChangeText={(v: any) => setField('startDate', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.gray500}
                />
                <Text style={styles.inputLabel}>End date</Text>
                <TextInput
                  editable={!readOnly}
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
                  editable={!readOnly}
                  value={form.startDateTime}
                  onChangeText={(v: any) => setField('startDateTime', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DDTHH:mm"
                  placeholderTextColor={colors.gray500}
                />
                <Text style={styles.inputLabel}>Ends</Text>
                <TextInput
                  editable={!readOnly}
                  value={form.endDateTime}
                  onChangeText={(v: any) => setField('endDateTime', v)}
                  style={styles.input}
                  placeholder="YYYY-MM-DDTHH:mm"
                  placeholderTextColor={colors.gray500}
                />
                <Text style={styles.inputLabel}>Time zone</Text>
                <TextInput
                  editable={!readOnly}
                  value={form.timeZone}
                  onChangeText={(v: any) => setField('timeZone', v)}
                  style={styles.input}
                  placeholderTextColor={colors.gray500}
                />
              </>
            )}
            <Text style={styles.inputLabel}>Location</Text>
            <TextInput
              editable={!readOnly}
              value={form.location}
              onChangeText={(v: any) => setField('location', v)}
              style={styles.input}
              placeholderTextColor={colors.gray500}
            />
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput
              editable={!readOnly}
              value={form.description}
              onChangeText={(v: any) => setField('description', v)}
              style={[styles.input, styles.textArea]}
              multiline
              placeholderTextColor={colors.gray500}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>{readOnly ? 'Close' : 'Cancel'}</Text>
              </TouchableOpacity>
              {readOnly ? null : (
                <TouchableOpacity
                  disabled={!valid || saving}
                  onPress={() => onSave(form, accountId)}
                  style={[styles.primaryButton, (!valid || saving) && styles.disabledButton]}
                >
                  <Text style={styles.primaryButtonText}>
                    {saving ? 'Saving' : event ? 'Save' : 'Create'}
                  </Text>
                </TouchableOpacity>
              )}
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
  // Partial load: some calendars (or a whole calendar list) are missing.
  const [warning, setWarning] = useState<string | null>(null);
  const [modalEvent, setModalEvent] = useState<any>(undefined);
  const [modalError, setModalError] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [capturedId, setCapturedId] = useState<string | null>(null);
  const [ticketDraft, setTicketDraft] = useState<CaptureCardDraft | null>(null);
  const [view, setViewState] = useState<CalendarViewMode>('month');
  // The week or day the list shows; month mode keeps it for when the list returns.
  const [listAnchor, setListAnchor] = useState(() => startOfDay(new Date()));
  const listMode = view === 'day' ? 'day' : 'week';
  const range = useMemo(() => listViewRange(listMode, listAnchor), [listMode, listAnchor]);
  const rangeRef = useRef(range);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [monthEvents, setMonthEvents] = useState<any[]>([]);
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthError, setMonthError] = useState<string | null>(null);
  const [monthReload, setMonthReload] = useState(0);
  const [hiddenAccounts, setHiddenAccounts] = useState<string[]>([]);
  const [failedAccountIds, setFailedAccountIds] = useState<string[]>([]);
  const [failedCalendarKeys, setFailedCalendarKeys] = useState<string[]>([]);
  // Every readable account's calendars; the month grid reads the same set.
  const [calendarSources, setCalendarSources] = useState<AccountCalendars[]>([]);
  const [calendarVisibility, setCalendarVisibility] = useState<CalendarVisibility>({});

  useEffect(() => {
    AsyncStorage.getItem(CALENDAR_HIDDEN_ACCOUNTS_KEY)
      .then((raw) => setHiddenAccounts(parseHiddenAccounts(raw)))
      .catch(() => {});
    AsyncStorage.getItem(CALENDAR_VISIBILITY_KEY)
      .then((raw) => setCalendarVisibility(parseCalendarVisibility(raw)))
      .catch(() => {});
    AsyncStorage.getItem(CALENDAR_VIEW_KEY)
      .then((raw) => setViewState(parseCalendarView(raw)))
      .catch(() => {});
  }, []);

  const accounts = useMemo(() => linkedGoogleAccounts(status), [status]);
  const calendarAccounts = useMemo(() => accounts.filter((a) => hasCalendarScope(a)), [accounts]);
  const calendarSourceKey = calendarSourcesKey(calendarSources);

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

  // Event requests for the list run on their own sequence, so a page change can
  // replace an in-flight read without cancelling the full load around it.
  const listSeq = useRef(0);
  const loadListEvents = useCallback(
    async (sources: AccountCalendars[], stillWanted: () => boolean = () => true) => {
      const id = ++listSeq.current;
      const latest = () => id === listSeq.current && stillWanted();
      setEventsLoading(true);
      try {
        const { events: merged, failures } = await loadCalendarEventsAcrossCalendars(api, sources, {
          ...rangeRef.current,
          maxResults: AGENDA_MAX_RESULTS,
        });
        if (!latest()) return;
        setEvents(merged);
        setFailedAccountIds(failures.map((f) => f.account.accountId));
        setFailedCalendarKeys(failures.map((f) => `${f.account.accountId}|${f.calendar.id}`));
        if (failures.length && failures.length === calendarCount(sources)) {
          setError(calendarFailureText(failures));
          setWarning(null);
        } else {
          setWarning(calendarLoadWarning(sources, failures));
        }
      } catch (err: any) {
        if (latest()) setError(err.message || 'Failed to load Calendar');
      } finally {
        if (id === listSeq.current) setEventsLoading(false);
      }
    },
    [],
  );

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    const listAtStart = listSeq.current;
    setError(null);
    setEventsLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      if (!current()) return;
      setStatus(nextStatus);
      const readable = linkedGoogleAccounts(nextStatus).filter((a) => hasCalendarScope(a));
      if (nextStatus.connected && readable.length) {
        const sources = await loadCalendarSources(api, readable);
        if (!current()) return;
        setCalendarSources(sources);
        // The page is usable now; the list read keeps its own spinner, and a
        // page change may replace it before it lands.
        setLoading(false);
        await loadListEvents(sources, current);
      } else {
        setWarning(null);
        setCalendarSources([]);
        setEvents([]);
        setFailedAccountIds([]);
        setFailedCalendarKeys([]);
      }
    } catch (err: any) {
      if (!current()) return;
      setError(err.message || 'Failed to load Calendar');
      setEvents([]);
    } finally {
      if (current()) {
        setLoading(false);
        // A list request started since owns the spinner and clears it itself.
        if (listSeq.current === listAtStart) setEventsLoading(false);
      }
    }
  }, [loadListEvents]);

  useEffect(() => {
    load();
  }, [load]);

  // Paging the list re-reads only its events; status and calendars stay put.
  useEffect(() => {
    if (rangeRef.current === range) return;
    rangeRef.current = range;
    if (!calendarSources.length) return;
    setError(null);
    loadListEvents(calendarSources);
    // calendarSources is read at the moment the range changes, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, loadListEvents]);

  const setView = (next: CalendarViewMode) => {
    if (next === view) return;
    const today = new Date();
    if (next === 'month') {
      setMonth(startOfMonth(listAnchor));
    } else if (view === 'month') {
      // Land on the month being browsed: today when it is the current month, else its 1st.
      const sameMonth =
        month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
      setListAnchor(sameMonth ? startOfDay(today) : month);
    }
    setViewState(next);
    AsyncStorage.setItem(CALENDAR_VIEW_KEY, next).catch(() => {});
  };

  const calendarReady = !!status?.connected && calendarAccounts.length > 0;

  useEffect(() => {
    if (!calendarReady || !calendarSources.length) {
      setMonthEvents([]);
      setMonthError(null);
      return;
    }
    let cancelled = false;
    setMonthLoading(true);
    setMonthError(null);
    loadCalendarEventsAcrossCalendars(api, calendarSources, {
      ...monthGridRange(month),
      maxResults: MONTH_MAX_RESULTS,
    })
      .then(({ events: merged, failures }) => {
        if (cancelled) return;
        setMonthEvents(merged);
        // Keep the error on the grid itself: month navigation only fires this
        // request, so the agenda banner above never sees the failure.
        setMonthError(failures.length ? calendarFailureText(failures) : null);
      })
      .finally(() => {
        if (!cancelled) setMonthLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // calendarSourceKey tracks calendarSources by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarReady, calendarSourceKey, month, monthReload]);

  const toggleAccount = (accountId: string) => {
    setHiddenAccounts((current) => {
      const next = toggleHiddenAccount(current, accountId);
      AsyncStorage.setItem(CALENDAR_HIDDEN_ACCOUNTS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const toggleCalendar = (accountId: string, calendar: GoogleCalendarEntry) => {
    setCalendarVisibility((current) => {
      const next = toggleCalendarVisibility(current, accountId, calendar);
      AsyncStorage.setItem(CALENDAR_VISIBILITY_KEY, JSON.stringify(next)).catch(() => {});
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
          { calendarId: eventCalendarId(modalEvent), event },
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
        warning={warning}
        status={status}
        events={events}
        onRefresh={refresh}
        onConnect={() => connect(defaultGoogleAccount(accounts)?.accountId || undefined)}
        hiddenAccounts={hiddenAccounts}
        failedAccountIds={failedAccountIds}
        onToggleAccount={toggleAccount}
        onEnableAccount={(accountId: string) => connect(accountId)}
        calendarSources={calendarSources}
        calendarVisibility={calendarVisibility}
        failedCalendarKeys={failedCalendarKeys}
        onToggleCalendar={toggleCalendar}
        onShowOtherCalendars={(accountId: string) => connect(accountId || undefined)}
        onOpenSettings={() => navigation.navigate('Settings', { tab: 'account' })}
        onCreate={() => showModal(null)}
        onEdit={(event: any) => showModal(event)}
        onCapture={capture}
        onTicket={(event: any) => setTicketDraft(buildCalendarCardDraft(event))}
        capturingId={capturingId}
        capturedId={capturedId}
        view={view}
        onChangeView={setView}
        listLabel={listViewLabel(listMode, listAnchor)}
        onListPrev={() => setListAnchor((a) => shiftListAnchor(listMode, a, -1))}
        onListNext={() => setListAnchor((a) => shiftListAnchor(listMode, a, 1))}
        onListToday={() => setListAnchor(startOfDay(new Date()))}
        monthView={
          calendarReady ? (
            <CalendarMonthView
              month={month}
              events={withCalendarMeta<CalendarEvent>(
                withoutHiddenCalendars<CalendarEvent>(
                  withoutHiddenAccounts<CalendarEvent>(
                    monthEvents,
                    effectiveHiddenAccounts(hiddenAccounts, accounts),
                  ),
                  calendarSources,
                  calendarVisibility,
                ),
                calendarSources,
              )}
              eventColor={
                accounts.length > 1 || calendarCount(calendarSources) > 1
                  ? (event) => {
                      const e = event as CalendarEvent;
                      return (
                        (calendarCount(calendarSources) > 1 && e.calendarColor) ||
                        googleAccountColor(accounts, e.accountId)
                      );
                    }
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
  viewToggle: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 12,
  },
  viewToggleButton: { paddingHorizontal: 14, paddingVertical: 7 },
  viewToggleButtonOn: { backgroundColor: colors.gray700 },
  viewToggleText: { color: colors.gray300, fontSize: 13, fontWeight: '600' },
  viewToggleTextOn: { color: colors.white },
  listNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
  },
  listNavTitle: { color: colors.white, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  listNavButtons: { flexDirection: 'row', gap: 6 },
  listNavButton: {
    borderWidth: 1,
    borderColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  errorText: { color: colors.red400, fontSize: 12, marginBottom: 10 },
  warningText: { color: colors.amber400, fontSize: 12, marginBottom: 10 },
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
