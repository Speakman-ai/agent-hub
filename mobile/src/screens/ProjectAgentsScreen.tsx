import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../context/AppContext';
import { colors } from '../theme/colors';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import AgentsSection from '../components/settings/AgentsSection';

export default function ProjectAgentsScreen({ route, navigation }: any) {
  const { projectId, project: routeProject } = route.params || {};
  const { projects } = useApp();
  const project = routeProject || projects?.find((p: any) => p.id === projectId);
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ProjectScreenHeader title="Agents" project={project} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <AgentsSection projectId={projectId} hideBulk />
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.gray950 },
  content: { padding: 16, paddingBottom: 32 },
});
