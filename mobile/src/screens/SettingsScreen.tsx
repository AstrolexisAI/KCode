import React, { useCallback, useEffect, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEYS = {
  SERVER_URL: "kcode_server_url",
  API_KEY: "kcode_api_key",
  PUSH_NOTIFICATIONS: "kcode_push_notifications",
  THEME: "kcode_theme",
};

type Theme = "dark" | "light";

export default function SettingsScreen() {
  const [serverUrl, setServerUrl] = useState("http://localhost:10091");
  const [apiKey, setApiKey] = useState("");
  const [pushEnabled, setPushEnabled] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const [url, key, push, th] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.SERVER_URL),
        AsyncStorage.getItem(STORAGE_KEYS.API_KEY),
        AsyncStorage.getItem(STORAGE_KEYS.PUSH_NOTIFICATIONS),
        AsyncStorage.getItem(STORAGE_KEYS.THEME),
      ]);
      if (url) setServerUrl(url);
      if (key) setApiKey(key);
      if (push !== null) setPushEnabled(push === "true");
      if (th === "light" || th === "dark") setTheme(th);
    })();
  }, []);

  const save = useCallback(async () => {
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl),
      AsyncStorage.setItem(STORAGE_KEYS.API_KEY, apiKey),
      AsyncStorage.setItem(STORAGE_KEYS.PUSH_NOTIFICATIONS, String(pushEnabled)),
      AsyncStorage.setItem(STORAGE_KEYS.THEME, theme),
    ]);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [serverUrl, apiKey, pushEnabled, theme]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Settings</Text>

      {/* Server URL */}
      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="http://localhost:10091"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      {/* API Key */}
      <Text style={styles.label}>API Key</Text>
      <TextInput
        style={styles.input}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder="Enter your KCode API key"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      {/* Push Notifications */}
      <View style={styles.switchRow}>
        <Text style={styles.label}>Push Notifications</Text>
        <Switch
          value={pushEnabled}
          onValueChange={setPushEnabled}
          trackColor={{ false: "#374151", true: "#6366f1" }}
          thumbColor="#fff"
        />
      </View>

      {/* Theme */}
      <Text style={styles.label}>Theme</Text>
      <View style={styles.themeRow}>
        {(["dark", "light"] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.themeButton, theme === t && styles.themeButtonActive]}
            onPress={() => setTheme(t)}
          >
            <Text
              style={[
                styles.themeButtonText,
                theme === t && styles.themeButtonTextActive,
              ]}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Save Button */}
      <TouchableOpacity style={styles.saveButton} onPress={save}>
        <Text style={styles.saveButtonText}>
          {saved ? "Saved!" : "Save Settings"}
        </Text>
      </TouchableOpacity>

      {/* Version Info */}
      <View style={styles.versionContainer}>
        <Text style={styles.versionText}>KCode Mobile v1.0.0</Text>
        <Text style={styles.versionText}>Companion for KCode CLI</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  content: { padding: 16 },
  heading: {
    color: "#e2e8f0",
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 24,
    marginTop: 8,
  },
  label: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    backgroundColor: "#1e1e2e",
    color: "#e2e8f0",
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#334155",
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
  },
  themeRow: {
    flexDirection: "row",
    gap: 10,
  },
  themeButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#334155",
    alignItems: "center",
  },
  themeButtonActive: {
    borderColor: "#6366f1",
    backgroundColor: "#312e81",
  },
  themeButtonText: { color: "#9ca3af", fontWeight: "600" },
  themeButtonTextActive: { color: "#a5b4fc" },
  saveButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 32,
  },
  saveButtonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  versionContainer: { alignItems: "center", marginTop: 40, marginBottom: 20 },
  versionText: { color: "#6b7280", fontSize: 12 },
});
