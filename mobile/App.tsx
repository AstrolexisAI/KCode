import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Text } from "react-native";

import SessionsScreen from "./src/screens/SessionsScreen";
import SessionDetailScreen from "./src/screens/SessionDetailScreen";
import AnalyticsScreen from "./src/screens/AnalyticsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

export type SessionsStackParamList = {
  SessionsList: undefined;
  SessionDetail: { sessionId: string; sessionName: string };
};

const Tab = createBottomTabNavigator();
const SessionsStack = createNativeStackNavigator<SessionsStackParamList>();

function SessionsStackNavigator() {
  return (
    <SessionsStack.Navigator>
      <SessionsStack.Screen
        name="SessionsList"
        component={SessionsScreen}
        options={{ title: "Sessions" }}
      />
      <SessionsStack.Screen
        name="SessionDetail"
        component={SessionDetailScreen}
        options={({ route }) => ({ title: route.params.sessionName })}
      />
    </SessionsStack.Navigator>
  );
}

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  const icons: Record<string, string> = {
    Sessions: "💬",
    Analytics: "📊",
    Settings: "⚙️",
  };
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>
      {icons[label] ?? "?"}
    </Text>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: ({ focused }) => (
            <TabIcon label={route.name} focused={focused} />
          ),
          tabBarActiveTintColor: "#6366f1",
          tabBarInactiveTintColor: "#9ca3af",
          headerShown: false,
        })}
      >
        <Tab.Screen name="Sessions" component={SessionsStackNavigator} />
        <Tab.Screen name="Analytics" component={AnalyticsScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
