# KCode Mobile Companion

React Native (Expo) mobile app for monitoring and interacting with KCode sessions remotely.

## Requirements

- Node.js 18+ or Bun
- Expo CLI (`npx expo`)
- KCode running with HTTP API enabled: `kcode serve`
- iOS Simulator (macOS) or Android Emulator, or Expo Go on a physical device

## Setup

```bash
cd mobile
npm install        # or: bun install
npx expo start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS) to open on a physical device.

### Connecting to KCode

1. Start KCode in serve mode on your machine: `kcode serve`
2. Open the **Settings** tab in the mobile app
3. Enter your server URL (e.g., `http://192.168.1.100:10091`)
4. Enter your API key if configured
5. Save and switch to the **Sessions** tab

## Features

- **Sessions** — View active KCode sessions, tap into conversation detail with real-time WebSocket updates
- **Tool Approval** — Approve or deny pending tool calls directly from your phone
- **Analytics** — Token usage (input vs output), cost breakdown by model, most-used tools, monthly session count
- **Settings** — Server URL, API key, push notifications toggle, dark/light theme

## Screenshots

<!-- TODO: Add screenshots -->

## Project Structure

```
mobile/
  App.tsx                         # Root app with bottom tab navigator
  src/
    api/
      client.ts                   # KCode API client (fetch + AsyncStorage)
    screens/
      SessionsScreen.tsx          # Session list with pull-to-refresh
      SessionDetailScreen.tsx     # Conversation view + tool approval cards
      AnalyticsScreen.tsx         # Token/cost/tool analytics dashboard
      SettingsScreen.tsx          # Server config, theme, notifications
```

## License

AGPL-3.0-only. Copyright Astrolexis.
