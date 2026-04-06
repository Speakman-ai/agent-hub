import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { AppProvider } from './src/context/AppContext';
import ChatScreen from './src/screens/ChatScreen';
import SkillsScreen from './src/screens/SkillsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import DrawerContent from './src/components/DrawerContent';
import { colors } from './src/theme/colors';

const Drawer = createDrawerNavigator();

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

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <NavigationContainer theme={DarkTheme}>
            <StatusBar style="light" />
            <Drawer.Navigator
              drawerContent={(props) => <DrawerContent {...props} />}
              screenOptions={{
                headerShown: false,
                drawerType: 'front',
                drawerStyle: {
                  width: 280,
                  backgroundColor: colors.gray900,
                },
                swipeEdgeWidth: 50,
              }}
            >
              <Drawer.Screen name="Chat" component={ChatScreen} />
              <Drawer.Screen name="Skills" component={SkillsScreen} />
              <Drawer.Screen name="Settings" component={SettingsScreen} />
            </Drawer.Navigator>
          </NavigationContainer>
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
