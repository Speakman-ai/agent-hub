import React from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import OrganizationsPanel from '../components/OrganizationsPanel';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { colors } from '../theme/colors';

export default function OrganizationsScreen({ navigation }: any) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.gray950 }} edges={['top']}>
      <ProjectScreenHeader title="Organizations" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <OrganizationsPanel />
      </ScrollView>
    </SafeAreaView>
  );
}
