import React, { useState, useRef, useCallback, useEffect } from 'react';
import { View, Animated, TouchableOpacity, StyleSheet, ActivityIndicator, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AppProvider, useApp } from './src/context/AppContext';
import { SidebarContext } from './src/context/SidebarContext';
import ChatScreen from './src/screens/ChatScreen';
import SkillsScreen from './src/screens/SkillsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import RoomsScreen from './src/screens/RoomsScreen';
import KanbanScreen from './src/screens/KanbanScreen';
import DashboardScreen from './src/screens/DashboardScreen';
import WikiScreen from './src/screens/WikiScreen';
import NotesScreen from './src/screens/NotesScreen';
import PullRequestsScreen from './src/screens/PullRequestsScreen';
import ThreadsScreen from './src/screens/ThreadsScreen';
import DrawerContent from './src/components/DrawerContent';
import SetupWizard from './src/components/SetupWizard';
import LoginScreen from './src/components/LoginScreen';
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
  const {
    setActiveSessionId,
    configReady,
    needsSetup,
    completeSetup,
    needsAuth,
    completeAuth,
    registerNavigator,
  } = useApp();

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
    navigate: (screen, params) => {
      closeSidebar();
      setTimeout(() => {
        if (navigationRef.current) {
          navigationRef.current.navigate(screen, params);
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

  // Hand the AppContext a navigator function so notification-tap handlers
  // (registered inside the context) can open Kanban / Threads. We build a
  // small wrapper instead of exposing the raw navigationRef so taps also
  // close the drawer if it's open (mirrors the DrawerContent `navigate`
  // helper above).
  useEffect(() => {
    if (!registerNavigator) return undefined;
    registerNavigator((screen, params) => {
      closeSidebar();
      if (navigationRef.current) {
        navigationRef.current.navigate(screen, params);
      }
    });
    return () => registerNavigator(null);
  }, [registerNavigator, closeSidebar]);

  // Show loading screen while config loads from AsyncStorage
  if (!configReady) {
    return (
      <View style={styles.loadingContainer}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={colors.blue600} />
        <Text style={styles.loadingText}>Connecting...</Text>
      </View>
    );
  }

  // First-run: no server URL configured. Show the setup wizard before the
  // main drawer/stack so the user can't end up staring at an empty chat.
  if (needsSetup) {
    return <SetupWizard onComplete={completeSetup} />;
  }

  // Server has auth configured and we don't have a valid JWT — gate on login.
  if (needsAuth) {
    return <LoginScreen onAuthenticated={completeAuth} />;
  }

  return (
    <SidebarContext.Provider value={{ openSidebar, closeSidebar, toggleSidebar }}>
      <View style={styles.root}>
        <NavigationContainer theme={DarkTheme} ref={navigationRef}>
          <StatusBar style="light" />
          <Stack.Navigator screenOptions={{ headerShown: false, animation: 'none' }}>
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="Dashboard" component={DashboardScreen} />
            <Stack.Screen name="Skills" component={SkillsScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Rooms" component={RoomsScreen} />
            <Stack.Screen name="Kanban" component={KanbanScreen} />
            <Stack.Screen name="Wiki" component={WikiScreen} />
            <Stack.Screen name="Notes" component={NotesScreen} />
            <Stack.Screen name="PullRequests" component={PullRequestsScreen} />
            <Stack.Screen name="Threads" component={ThreadsScreen} />
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
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.gray950,
  },
  loadingText: {
    color: colors.gray400,
    marginTop: 12,
    fontSize: 16,
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
