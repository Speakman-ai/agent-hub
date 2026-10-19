import React, { useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import OrganizationsPanel from '../components/OrganizationsPanel';
import ProjectScreenHeader from '../components/ProjectScreenHeader';
import { colors } from '../theme/colors';
import { useApp } from '../context/AppContext';
import { getActiveOrg } from '../utils/orgs';

export default function OrganizationsScreen({ navigation, route }: any) {
  const { openOrganizationChat, handleOpenHandoffSession, projects } = useApp();
  // Chat opens on top of this screen, so it stays mounted; reload agents and history on return.
  // Keyed on leaving the screen rather than on its first focus, which may already have happened
  // before this effect subscribes.
  const [focusKey, setFocusKey] = useState(0);
  const leftScreen = useRef(false);
  useEffect(() => {
    const unsubscribeBlur = navigation.addListener?.('blur', () => {
      leftScreen.current = true;
    });
    const unsubscribeFocus = navigation.addListener?.('focus', () => {
      if (!leftScreen.current) return;
      leftScreen.current = false;
      setFocusKey((key) => key + 1);
    });
    return () => {
      unsubscribeBlur?.();
      unsubscribeFocus?.();
    };
  }, [navigation]);
  // A link names the Server it belongs to; on any other Server it opens the plain list.
  const params = route?.params ?? {};
  const organizationId =
    params.organizationId && (!params.serverId || params.serverId === getActiveOrg()?.id)
      ? params.organizationId
      : null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.gray950 }} edges={['top']}>
      <ProjectScreenHeader title="Organizations" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
        <OrganizationsPanel
          initialOrganizationId={organizationId}
          refreshKey={focusKey}
          onOpenChat={(target) => {
            openOrganizationChat(target);
            navigation.navigate('Chat');
          }}
          onOpenProject={(projectId) =>
            navigation.navigate('Kanban', {
              projectId,
              project: (projects ?? []).find((p: any) => p.id === projectId),
            })
          }
          onOpenSession={(agentId, sessionId) => {
            handleOpenHandoffSession(agentId, sessionId);
            navigation.navigate('Chat');
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
