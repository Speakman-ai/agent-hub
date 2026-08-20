import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    SafeAreaView,
    ScrollView,
    Text,
    TextInput,
    TouchableOpacity,
    View,
    StyleSheet,
} from 'react-native';
import { api } from '../utils/api';
import { setToken } from '../utils/auth';
import { colors } from '../theme/colors';

export function isValidInviteEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export function inviteStateMessage(error: any) {
    const message = String(error?.message || error || '');
    if (message.includes('410'))
        return 'This invite has expired or was already used.';
    if (message.includes('404'))
        return 'This invite link was not found.';
    return message || 'Unable to load invite.';
}

export function buildAcceptInviteBody(email: string, password: string) {
    const nextEmail = String(email || '').trim();
    return { email: nextEmail, username: nextEmail, password };
}

export async function acceptInviteAndEnterApp({
    token,
    email,
    password,
    acceptInvite,
    persistToken,
    onAccepted,
    navigation,
}: any) {
    const body = buildAcceptInviteBody(email, password);
    const response = await acceptInvite(token, body);
    await persistToken(response);
    if (onAccepted) {
        onAccepted();
        return response;
    }
    navigation?.reset?.({ index: 0, routes: [{ name: 'Hub' }] });
    return response;
}

export default function InviteAcceptScreen({ route, navigation, onAccepted }: any) {
    const token = route?.params?.token;
    const [invite, setInvite] = useState<any>(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<any>(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const body = await api.previewInvite(token);
                if (cancelled)
                    return;
                setInvite(body);
                setEmail(body?.email || '');
                if (body?.accepted)
                    setError('This invite has already been accepted.');
            }
            catch (err: any) {
                if (!cancelled)
                    setError(inviteStateMessage(err));
            }
            finally {
                if (!cancelled)
                    setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token]);
    const accept = async () => {
        const nextEmail = email.trim();
        setError(null);
        if (!isValidInviteEmail(nextEmail)) {
            setError('Enter a valid email address.');
            return;
        }
        if (!password) {
            setError('Enter a password.');
            return;
        }
        setSubmitting(true);
        try {
            await acceptInviteAndEnterApp({
                token,
                email: nextEmail,
                password,
                acceptInvite: api.acceptInvite,
                persistToken: setToken,
                onAccepted,
                navigation,
            });
        }
        catch (err: any) {
            setError(inviteStateMessage(err));
        }
        finally {
            setSubmitting(false);
        }
    };
    return (<SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.title}>Join Agent Hub</Text>
            {loading ? (<View style={styles.loadingRow}>
                <ActivityIndicator color={colors.indigo500}/>
                <Text style={styles.muted}>Loading invite...</Text>
              </View>) : invite ? (<>
                <View style={styles.preview}>
                  <Text style={styles.previewText}>
                    You were invited to <Text style={styles.strong}>{invite.orgName}</Text> as{' '}
                    <Text style={styles.strong}>{invite.role}</Text>.
                  </Text>
                  <Text style={styles.muted}>Expires {invite.expiresAt}</Text>
                </View>
                <Text style={styles.label}>Email</Text>
                <TextInput style={[styles.input, invite.email && { opacity: 0.7 }]} value={email} onChangeText={setEmail} editable={!invite.email && !submitting} placeholder="teammate@example.com" placeholderTextColor={colors.gray600} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"/>
                <Text style={styles.label}>Password</Text>
                <TextInput style={styles.input} value={password} onChangeText={setPassword} editable={!submitting} placeholder="Create a password" placeholderTextColor={colors.gray600} secureTextEntry autoCapitalize="none" autoCorrect={false}/>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <TouchableOpacity style={[styles.button, (submitting || invite.accepted || !isValidInviteEmail(email) || !password) && { opacity: 0.4 }]} onPress={accept} disabled={submitting || invite.accepted || !isValidInviteEmail(email) || !password}>
                  <Text style={styles.buttonText}>{submitting ? 'Accepting...' : 'Accept Invite'}</Text>
                </TouchableOpacity>
              </>) : (<Text style={styles.error}>{error || 'Unable to load invite.'}</Text>)}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>);
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.gray950 },
    content: { flexGrow: 1, justifyContent: 'center', padding: 20 },
    card: { backgroundColor: colors.gray900, borderRadius: 14, padding: 18, borderWidth: 1, borderColor: colors.gray700 },
    title: { color: colors.white, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 18 },
    loadingRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
    preview: { backgroundColor: colors.gray800, borderRadius: 10, padding: 12, marginBottom: 16 },
    previewText: { color: colors.gray300, fontSize: 14, marginBottom: 4 },
    strong: { color: colors.white, fontWeight: '700' },
    muted: { color: colors.gray500, fontSize: 13 },
    label: { color: colors.gray400, fontSize: 13, fontWeight: '600', marginBottom: 6 },
    input: { backgroundColor: colors.gray800, color: colors.white, borderColor: colors.gray700, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
    error: { color: colors.red400, fontSize: 13, marginBottom: 12 },
    button: { backgroundColor: colors.indigo600, borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
    buttonText: { color: colors.white, fontSize: 14, fontWeight: '700' },
});
