# KCode Mobile (iOS)

SwiftUI companion app for KCode. Chat with KCode from your iPhone over the local network or Tailscale.

## Architecture

```
iPhone (KCodeMobile)
   │
   │  HTTP + SSE
   │
   ▼
KCode HTTP server (kcode serve)
   │
   ▼
KCode conversation manager → Anthropic API
```

## Setup

### 1. Start the KCode HTTP server

On your main machine:

```bash
kcode serve --port 10101
```

The server exposes `/api/prompt` with SSE streaming.

### 2. Find your machine's IP

**Local network:**
```bash
ip addr show | grep inet
# → e.g. 192.168.1.42
```

**Tailscale (for remote access):**
```bash
tailscale ip -4
# → e.g. 100.64.0.5
```

### 3. Create Xcode project

```bash
cd /home/curly/KCode/mobile-ios
# In Xcode: File → New → Project → iOS App
# - Name: KCodeMobile
# - Interface: SwiftUI
# - Language: Swift
# - Minimum deployment: iOS 17
# Drag all .swift files into the project
```

Requires: Xcode 15+ on a Mac

### 4. Configure the app

On first launch, tap ⋯ → Settings:

- **Server URL**: `http://192.168.1.42:10101` (LAN) or `http://100.64.0.5:10101` (Tailscale)
- **Model**: any model ID your KCode server has configured (run `kcode models list`)
- **Working Directory**: `/home/curly/projects/myproject` (absolute path)

Tap "Test Connection" to verify.

## Features

- **Chat interface** — clean messages, not raw terminal output
- **Streaming responses** — real-time text as the model generates
- **Tool result cards** — expandable, syntax-highlighted
- **Agent status** — live updates when background agents run
- **Kodi mood indicator** — visual feedback in toolbar
- **Session persistence** — conversations continue across app launches
- **Stop button** — cancel streaming mid-response

## File Structure

```
mobile-ios/
├── KCodeMobileApp.swift         # App entry point
├── Models/
│   ├── ChatMessage.swift        # Message types
│   └── AppSettings.swift        # Persisted settings
├── Services/
│   ├── SSEClient.swift          # Server-Sent Events parser
│   └── ChatSession.swift        # Chat state + SSE delegate
└── Views/
    ├── ContentView.swift        # Root nav
    ├── ChatView.swift           # Main chat + input bar
    ├── MessageBubble.swift      # Message rendering
    └── SettingsView.swift       # Configuration
```

## Roadmap

- [ ] Push notifications when tasks complete
- [ ] Voice input (dictation)
- [ ] Permission approval UI (for write tools)
- [ ] Agent panel with live progress bars
- [ ] Multi-session support (switch between projects)
- [ ] Android version (Compose)
