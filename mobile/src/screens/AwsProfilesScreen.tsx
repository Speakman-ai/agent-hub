import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Linking, Alert, } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../utils/api';
import { awsProfileBadges } from '../utils/awsProfileBadges';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
export default function AwsProfilesScreen({ route, navigation }: any) {
    const { projectId, project: routeProject } = route.params || {};
    const project = routeProject;
    const [profiles, setProfiles] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<any>(null);
    const [statusByProfile, setStatusByProfile] = useState<any>({});
    const [loginByProfile, setLoginByProfile] = useState<any>({});
    const [defaultProfile, setDefaultProfile] = useState('');
    const [monitoringProfile, setMonitoringProfile] = useState('');
    const [ambientCredentialSource, setAmbientCredentialSource] = useState('');
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const body = await api.getProjectAwsProfiles(projectId);
            const rows = Object.entries(body?.profiles || {})
                .sort(([a]: any, [b]: any) => a.localeCompare(b))
                .map(([name, p]: any) => ({ name, ...p }));
            setProfiles(rows);
            setDefaultProfile(body?.effectiveDefaultProfile || '');
            setMonitoringProfile(body?.effectiveMonitoringProfile || '');
            setAmbientCredentialSource(body?.ambientCredentialSource || '');
        }
        catch (err: any) {
            setError(err?.message || 'Failed to load AWS profiles');
            setProfiles([]);
            setDefaultProfile('');
            setMonitoringProfile('');
            setAmbientCredentialSource('');
        }
        finally {
            setLoading(false);
        }
    }, [projectId]);
    useEffect(() => {
        load();
    }, [load]);
    const checkStatus = async (profileName: any) => {
        setStatusByProfile((s: any) => ({ ...s, [profileName]: { loading: true } }));
        try {
            const st = await api.getProjectAwsSsoStatus(projectId, profileName);
            setStatusByProfile((s: any) => ({ ...s, [profileName]: { loading: false, data: st } }));
        }
        catch (err: any) {
            setStatusByProfile((s: any) => ({
                ...s,
                [profileName]: { loading: false, error: err?.message || 'Status check failed' },
            }));
        }
    };
    const startLogin = async (profileName: any) => {
        setLoginByProfile((s: any) => ({ ...s, [profileName]: { loading: true } }));
        try {
            const data = await api.startProjectAwsSsoLogin(projectId, profileName);
            setLoginByProfile((s: any) => ({
                ...s,
                [profileName]: { loading: false, loginUrl: data.loginUrl, completed: data.completed },
            }));
            if (data.loginUrl) {
                const can = await Linking.canOpenURL(data.loginUrl);
                if (can)
                    await Linking.openURL(data.loginUrl);
                else
                    Alert.alert('Open in browser', data.loginUrl);
            }
            if (data.completed)
                await checkStatus(profileName);
        }
        catch (err: any) {
            setLoginByProfile((s: any) => ({
                ...s,
                [profileName]: { loading: false, error: err?.message || 'Login failed' },
            }));
        }
    };
    return (<SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="AWS" project={project} onBack={() => navigation.goBack()}/>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.desc}>
          AWS profiles for this project. Agents use project-scoped config and credentials files.
          {defaultProfile
            ? ` "${defaultProfile}" is exported as AWS_PROFILE, so aws commands without --profile resolve to it.`
            : ''}
          {monitoringProfile
            ? ` "${monitoringProfile}" runs unattended background collection.`
            : profiles.length > 0
                ? ' No monitoring profile is designated, so background collection is off. Designate a static or assume-role profile in the web settings — an SSO token expires with nobody around to refresh it.'
                : ''}
        </Text>
        {loading && <ActivityIndicator color={colors.gray400}/>}
        {error && <Text style={styles.error}>{error}</Text>}
        {!loading && profiles.length === 0 && !error && (<Text style={styles.empty}>No AWS profiles configured.</Text>)}
        {profiles.map((row: any) => {
            const st = statusByProfile[row.name];
            const lg = loginByProfile[row.name];
            const loggedIn = st?.data?.loggedIn;
            const isStatic = row.type === 'static';
            const isRole = row.type === 'role';
            const isSso = !isStatic && !isRole;
            return (<View key={row.name} style={styles.card}>
              <Text style={styles.profileName}>
                {row.name}
                {awsProfileBadges(row.name, { defaultProfile, monitoringProfile })}
              </Text>
              <Text style={styles.meta}>Type: {isStatic ? 'static' : isRole ? 'assume role' : 'SSO'}</Text>
              {isSso && <Text style={styles.meta}>Account: {row.sso_account_id || '-'}</Text>}
              {isSso && <Text style={styles.meta}>Role: {row.sso_role_name || '-'}</Text>}
              {isStatic && <Text style={styles.meta}>Access key: {row.aws_access_key_id || '-'}</Text>}
              {isRole && <Text style={styles.meta}>Role ARN: {row.role_arn || '-'}</Text>}
              {isRole && (<Text style={styles.meta}>
                  Source: {row.source_profile || row.credential_source || ambientCredentialSource || 'auto'}
                </Text>)}
              <Text style={styles.meta}>Region: {row.region || '-'}</Text>
              <View style={styles.actions}>
                <TouchableOpacity style={styles.btn} onPress={() => checkStatus(row.name)} disabled={st?.loading}>
                  <Text style={styles.btnText}>{st?.loading ? 'Checking…' : isSso ? 'Check SSO' : 'Check credentials'}</Text>
                </TouchableOpacity>
                {isSso && (<TouchableOpacity style={styles.btn} onPress={() => startLogin(row.name)} disabled={lg?.loading}>
                  <Text style={styles.btnText}>{lg?.loading ? 'Starting…' : 'Login'}</Text>
                </TouchableOpacity>)}
              </View>
              {loggedIn != null && (<Text style={[styles.status, loggedIn ? styles.ok : styles.warn]}>
                  {loggedIn ? (isSso ? 'SSO session active' : 'Credentials valid') : (isSso ? 'Not logged in' : 'Credentials invalid')}
                </Text>)}
              {st?.error && <Text style={styles.error}>{st.error}</Text>}
              {lg?.error && <Text style={styles.error}>{lg.error}</Text>}
            </View>);
        })}
      </ScrollView>
    </SafeAreaView>);
}
const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.gray950 },
    content: { padding: 16, paddingBottom: 32 },
    desc: { fontSize: 13, color: colors.gray500, marginBottom: 16, lineHeight: 18 },
    empty: { fontSize: 14, color: colors.gray500, fontStyle: 'italic' },
    error: { fontSize: 12, color: colors.red400, marginTop: 4 },
    card: {
        backgroundColor: colors.gray900,
        borderRadius: 10,
        padding: 12,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: colors.gray800,
    },
    profileName: { fontSize: 15, fontWeight: '600', color: colors.white, marginBottom: 6 },
    meta: { fontSize: 12, color: colors.gray500, fontFamily: 'monospace' },
    actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
    btn: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: colors.gray800,
        borderWidth: 1,
        borderColor: colors.gray700,
    },
    btnText: { fontSize: 12, color: colors.gray300 },
    status: { fontSize: 12, marginTop: 8 },
    ok: { color: colors.emerald400 },
    warn: { color: colors.amber400 },
});
