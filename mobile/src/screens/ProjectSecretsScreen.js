import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import ProjectSecretsSection from '../components/settings/ProjectSecretsSection';

/**
 * Per-project Secrets screen, reached from the project's Settings submenu.
 * Wraps the shared `ProjectSecretsSection`, locked to the tapped project so
 * the project picker is hidden (mirrors ProjectAgentsScreen → AgentsSection).
 */
export default function ProjectSecretsScreen({ route, navigation }) {
  const { projectId, project: routeProject } = route.params || {};
  const { projects } = useApp();
  const project = routeProject || projects?.find((p) => p.id === projectId);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Secrets" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ProjectSecretsSection projectId={projectId} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
});
