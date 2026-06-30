import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SidebarContext } from '../context/SidebarContext';
import { api } from '../utils/api';
import { colors } from '../theme/colors';
import {
  GMAIL_SURFACE_SCOPES,
  hasGmailReadScope,
  hasGmailSendScope,
} from '../utils/googleSurface';

export { GMAIL_SURFACE_SCOPES };

/**
 * Split a comma/semicolon/whitespace-separated recipient string into a trimmed,
 * de-duplicated email list. Exported for unit testing the compose flow.
 */
export function parseRecipients(value: any): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(value || '').split(/[,;\s]+/)) {
    const email = raw.trim();
    if (email && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push(email);
    }
  }
  return out;
}

/** Build the POST body for `/api/google/gmail/messages`. Exported for testing. */
export function buildSendBody(form: any) {
  const cc = parseRecipients(form.cc);
  return {
    to: parseRecipients(form.to),
    ...(cc.length ? { cc } : {}),
    subject: String(form.subject || '').trim() || undefined,
    text: String(form.body || ''),
  };
}

export function gmailReturnTo() {
  // Gmail is a global, per-user surface — the return hash carries no project.
  return '/#/gmail';
}

export async function openGmailOAuth({ apiClient, openURL }: any) {
  const body = await apiClient.startGoogleOAuth({
    returnTo: gmailReturnTo(),
    scopes: GMAIL_SURFACE_SCOPES,
  });
  await openURL(body.authorizeUrl);
  return body.authorizeUrl;
}

export function GmailContent({
  loading,
  threadsLoading,
  error,
  status,
  threads,
  onRefresh,
  onConnect,
  onOpenSettings,
  onCompose,
  onOpenThread,
}: any) {
  const connected = !!status?.connected;
  const configured = status?.serverConfigured !== false;
  const gmailEnabled = hasGmailReadScope(status);
  const canSend = hasGmailSendScope(status);

  if (loading) {
    return (
      <View style={styles.centerCard}>
        <ActivityIndicator color={colors.blue400} />
        <Text style={styles.muted}>Loading Gmail...</Text>
      </View>
    );
  }

  let empty: any = null;
  if (!configured && !connected) {
    empty = {
      title: 'Google is not configured',
      body: 'An Admin needs to add the Google OAuth app before Gmail can connect.',
      action: 'Open Account settings',
      onAction: onOpenSettings,
    };
  } else if (!connected) {
    empty = {
      title: 'Connect Google to use Gmail',
      body: 'Mail stays server-side through the Google proxy. Connect your account to continue.',
      action: 'Connect Google',
      onAction: onConnect,
    };
  } else if (!gmailEnabled) {
    empty = {
      title: 'Enable Gmail access',
      body: `Connected as ${status?.email || 'Google account'}, but Gmail access has not been granted yet.`,
      action: 'Enable Gmail',
      onAction: onConnect,
    };
  } else if (!threads?.length && !threadsLoading) {
    empty = {
      title: 'No messages',
      body: 'Your recent threads will appear here. Compose a message or refresh after new mail arrives.',
      action: canSend ? 'Compose' : null,
      onAction: onCompose,
    };
  }

  return (
    <View style={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Gmail</Text>
          <Text style={styles.title}>Mail</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={onRefresh} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>
              {threadsLoading ? 'Refreshing' : 'Refresh'}
            </Text>
          </TouchableOpacity>
          {connected && canSend ? (
            <TouchableOpacity onPress={onCompose} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Compose</Text>
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
          data={threads}
          keyExtractor={(item: any, index) => item.id || `${item.snippet}-${index}`}
          renderItem={({ item }: any) => (
            <TouchableOpacity onPress={() => onOpenThread(item)} style={styles.threadCard}>
              <Text style={styles.threadSnippet} numberOfLines={2}>
                {item.snippet || '(no preview)'}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

function ComposeModal({ saving, error, onClose, onSend }: any) {
  const [form, setForm] = useState({ to: '', cc: '', subject: '', body: '' });
  const setField = (field: string, value: any) =>
    setForm((current: any) => ({ ...current, [field]: value }));
  const valid = parseRecipients(form.to).length > 0 && String(form.body || '').trim().length > 0;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <ScrollView>
            <Text style={styles.modalTitle}>New message</Text>
            <Text style={styles.inputLabel}>To</Text>
            <TextInput
              value={form.to}
              onChangeText={(v: any) => setField('to', v)}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="alice@example.com, bob@example.com"
              placeholderTextColor={colors.gray500}
              style={styles.input}
            />
            <Text style={styles.inputLabel}>Cc</Text>
            <TextInput
              value={form.cc}
              onChangeText={(v: any) => setField('cc', v)}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholderTextColor={colors.gray500}
              style={styles.input}
            />
            <Text style={styles.inputLabel}>Subject</Text>
            <TextInput
              value={form.subject}
              onChangeText={(v: any) => setField('subject', v)}
              placeholderTextColor={colors.gray500}
              style={styles.input}
            />
            <Text style={styles.inputLabel}>Message</Text>
            <TextInput
              value={form.body}
              onChangeText={(v: any) => setField('body', v)}
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
                onPress={() => onSend(form)}
                style={[styles.primaryButton, (!valid || saving) && styles.disabledButton]}
              >
                <Text style={styles.primaryButtonText}>{saving ? 'Sending' : 'Send'}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ThreadModal({ loading, error, subject, messages, onClose }: any) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle} numberOfLines={1}>
            {subject || '(no subject)'}
          </Text>
          <ScrollView>
            {loading ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.blue400} />
                <Text style={styles.muted}>Loading thread...</Text>
              </View>
            ) : error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : (
              (messages || []).map((message: any, index: number) => (
                <View key={message.id || index} style={styles.messageCard}>
                  <Text style={styles.messageFrom} numberOfLines={1}>
                    {message.from || '(unknown sender)'}
                  </Text>
                  {message.date ? <Text style={styles.messageMeta}>{message.date}</Text> : null}
                  <Text style={styles.messageBody}>
                    {message.bodyText || message.snippet || '(no content)'}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onClose} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function GmailScreen({ navigation }: any) {
  const sidebar = React.useContext(SidebarContext);
  const [status, setStatus] = useState<any>(null);
  const [threads, setThreads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeError, setComposeError] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [openThread, setOpenThread] = useState<any>(null);
  const [threadMessages, setThreadMessages] = useState<any[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<any>(null);

  const load = useCallback(async () => {
    setError(null);
    setThreadsLoading(true);
    try {
      const nextStatus = await api.getGoogleStatus();
      setStatus(nextStatus);
      if (nextStatus.connected && hasGmailReadScope(nextStatus)) {
        const body = await api.listGoogleGmailThreads({ maxResults: 25 });
        setThreads(body.threads || []);
      } else {
        setThreads([]);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load Gmail');
      setThreads([]);
    } finally {
      setLoading(false);
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connect = async () => {
    try {
      await openGmailOAuth({ apiClient: api, openURL: Linking.openURL });
    } catch (err: any) {
      Alert.alert('Gmail', err.message || 'Failed to start Google consent');
    }
  };

  const openThreadDetail = async (thread: any) => {
    if (!thread?.id) return;
    setOpenThread({ id: thread.id, subject: '' });
    setThreadMessages([]);
    setThreadError(null);
    setThreadLoading(true);
    try {
      const body = await api.getGoogleGmailThread(thread.id, { format: 'full' });
      const messages = body.messages || [];
      const subject = messages.find((m: any) => m.subject)?.subject || '';
      setThreadMessages(messages);
      setOpenThread({ id: thread.id, subject });
    } catch (err: any) {
      setThreadError(err.message || 'Failed to load thread');
    } finally {
      setThreadLoading(false);
    }
  };

  const send = async (form: any) => {
    setSending(true);
    setComposeError(null);
    try {
      await api.sendGoogleGmailMessage(buildSendBody(form));
      setComposeOpen(false);
      await load();
    } catch (err: any) {
      setComposeError(err.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={sidebar?.toggleSidebar} style={styles.menuButton}>
          <Text style={styles.menuButtonText}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Gmail</Text>
      </View>
      <GmailContent
        loading={loading}
        threadsLoading={threadsLoading}
        error={error}
        status={status}
        threads={threads}
        onRefresh={load}
        onConnect={connect}
        onOpenSettings={() => navigation.navigate('Settings', { tab: 'account' })}
        onCompose={() => setComposeOpen(true)}
        onOpenThread={openThreadDetail}
      />
      {composeOpen ? (
        <ComposeModal
          saving={sending}
          error={composeError}
          onClose={() => setComposeOpen(false)}
          onSend={send}
        />
      ) : null}
      {openThread ? (
        <ThreadModal
          loading={threadLoading}
          error={threadError}
          subject={openThread.subject}
          messages={threadMessages}
          onClose={() => setOpenThread(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
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
  threadCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray900,
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  threadSnippet: { color: colors.gray200, fontSize: 14 },
  messageCard: {
    borderWidth: 1,
    borderColor: colors.gray800,
    backgroundColor: colors.gray950,
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
  },
  messageFrom: { color: colors.gray200, fontSize: 13, fontWeight: '700' },
  messageMeta: { color: colors.gray500, fontSize: 11, marginTop: 2 },
  messageBody: { color: colors.gray200, fontSize: 13, marginTop: 8, lineHeight: 18 },
  modalBackdrop: { flex: 1, backgroundColor: colors.black60, justifyContent: 'center', padding: 16 },
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
  textArea: { minHeight: 120, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
});
