import { useState, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from '../utils/api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function useNotifications(onTapNotification) {
  const [pushToken, setPushToken] = useState(null);
  const responseListener = useRef();

  useEffect(() => {
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') return;

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: '20b18a51-0fcc-4818-9721-e74db92bb51c',
      });
      setPushToken(tokenData.data);

      try {
        await api.registerDevice(tokenData.data, Platform.OS);
      } catch (e) {
        console.warn('[notifications] Failed to register:', e.message);
      }
    })();

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (data?.sessionId && onTapNotification) {
        onTapNotification(data.sessionId);
      }
    });

    return () => {
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, []);

  return { pushToken };
}
