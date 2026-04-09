import React, { useState, useRef, useCallback } from 'react';
import { View, Animated, TouchableOpacity, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AppProvider, useApp } from './src/context/AppContext';
import { SidebarContext } from './src/context/SidebarContext';
import { useNotifications } from './src/hooks/useNotifications';
import ChatScreen from './src/screens/ChatScreen';
import SkillsScreen from './src/screens/SkillsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import WikiScreen from './src/screens/WikiScreen';
import DrawerContent from './src/components/DrawerContent';
import { colors } from './src/theme/colors';

const Stack = createNativeStackNavigator();
const DRAWER_WIDTH = 280;

const DarkTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.blue600,
    background: colors.gray950,
    card: colors.gray900,
    text: colors.white,
    border: colors.gray800,
    notification: colors.blue600,
  },
};

function AppContent() {
  const sidebarOpenRef = useRef(false);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const navigationRef = useRef(null);
  const { setActiveSessionId } = useApp();

  // Push notifications — tap navigates to the relevant session
  useNotifications(useCallback((sessionId) => {
    setActiveSessionId(sessionId);
    if (navigationRef.current) {
      navigationRef.current.navigate('Chat');
    }
  }, [setActiveSessionId]));

  const openSidebar = useCallback(() => {
    sidebarOpenRef.current = true;
    setSidebarVisible(true);
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, [slideAnim, overlayAnim]);

  const closeSidebar = useCallback(() => {
    sidebarOpenRef.current = false;
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: -DRAWER_WIDTH,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => setSidebarVisible(false));
  }, [slideAnim, overlayAnim]);

  const toggleSidebar = useCallback(() => {
    if (sidebarOpenRef.current) closeSidebar();
    else openSidebar();
  }, [openSidebar, closeSidebar]);

  // Navigation helper for DrawerContent compatibility
  const navigation = useRef({
    navigate: (screen) => {
      closeSidebar();
      setTimeout(() => {
        if (navigationRef.current) {
          navigationRef.current.navigate(screen);
        }
      }, 50);
    },
    closeDrawer: () => closeSidebar(),
  }).current;
  // Keep closeSidebar reference current
  navigation.closeDrawer = closeSidebar;
  navigation.navigate = (screen, params) => {
    closeSidebar();
    setTimeout(() => {
      if (navigationRef.current) {
        navigationRef.current.navigate(screen, params);
      }
    }, 50);
  };

  return (
    <SidebarContext.Provider value={{ openSidebar, closeSidebar, toggleSidebar }}>
      <View style={styles.root}>
        <NavigationContainer theme={DarkTheme} ref={navigationRef}>
          <StatusBar style="light" />
          <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="Skills" component={SkillsScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Rooms" component={RoomsScreen} />
            <Stack.Screen name="Wiki" component={WikiScreen} />
          </Stack.Navigator>
        </NavigationContainer>

        {/* Overlay + Sidebar rendered when visible */}
        {sidebarVisible && (
          <>
            <Animated.View
              style={[styles.overlay, { opacity: overlayAnim }]}
              pointerEvents="auto"
            >
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={closeSidebar}
              />
            </Animated.View>

            <Animated.View
              style={[
                styles.sidebar,
                { transform: [{ translateX: slideAnim }] },
              ]}
            >
              <DrawerContent navigation={navigation} />
            </Animated.View>
          </>
        )}
      </View>
    </SidebarContext.Provider>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <AppContent />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    zIndex: 10,
    elevation: 10,
  },
  sidebar: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    backgroundColor: colors.gray900,
    zIndex: 20,
    elevation: 20,
  },
});
