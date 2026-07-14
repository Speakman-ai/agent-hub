import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import DevServerSection from '../components/settings/DevServerSection';

/**
 * Per-project Dev Server settings screen, reached from the project's Settings
 * submenu. Wraps the shared `DevServerSection`, locked to the tapped project
 * (mirrors ProjectSecretsScreen → ProjectSecretsSection).
 */
export default function DevServerScreen({ route, navigation }: any) {
  const { projectId, project: routeProject } = route.params || {};
  const { projects } = useApp();
  const project = routeProject || projects?.find((p: any) => p.id === projectId);
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Dev Server" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <DevServerSection project={project} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 48 },
});
