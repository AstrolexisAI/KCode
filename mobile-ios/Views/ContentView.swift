// KCodeMobile - Root view
// Shows chat or settings based on connection state

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var chatSession: ChatSession
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            ChatView()
                .navigationTitle("KCode")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        KodiMoodIndicator(mood: chatSession.kodiMood)
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Menu {
                            Button(action: { showingSettings = true }) {
                                Label("Settings", systemImage: "gearshape")
                            }
                            Button(action: { chatSession.clearConversation() }) {
                                Label("New Session", systemImage: "square.and.pencil")
                            }
                            ConnectionStatusLabel(status: chatSession.connectionStatus)
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
                .sheet(isPresented: $showingSettings) {
                    SettingsView()
                }
                .onAppear {
                    chatSession.configure(settings: settings)
                }
        }
    }
}

struct KodiMoodIndicator: View {
    let mood: ChatSession.KodiMood

    var body: some View {
        Text(emoji)
            .font(.title2)
            .animation(.easeInOut(duration: 0.3), value: mood)
    }

    private var emoji: String {
        switch mood {
        case .idle: return "😊"
        case .thinking: return "🤔"
        case .working: return "⚡"
        case .done: return "✨"
        case .error: return "😰"
        }
    }
}

struct ConnectionStatusLabel: View {
    let status: ChatSession.ConnectionStatus

    var body: some View {
        switch status {
        case .disconnected: Label("Disconnected", systemImage: "circle")
        case .connecting: Label("Connecting...", systemImage: "arrow.triangle.2.circlepath")
        case .connected: Label("Connected", systemImage: "circle.fill").foregroundStyle(.green)
        case .error(let msg): Label(msg, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
        }
    }
}
