// KCodeMobile - Chat session manager
// Coordinates sending messages, streaming responses, updating UI state

import Foundation
import SwiftUI

@MainActor
class ChatSession: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isStreaming = false
    @Published var currentStreamingText = ""
    @Published var connectionStatus: ConnectionStatus = .disconnected
    @Published var kodiMood: KodiMood = .idle

    enum ConnectionStatus {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    enum KodiMood {
        case idle, thinking, working, done, error
    }

    private var sseClient: SSEClient?
    private var settings: AppSettings?

    func configure(settings: AppSettings) {
        self.settings = settings
    }

    func sendMessage(_ text: String) async {
        guard let settings = settings else { return }
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }

        messages.append(.user(text))
        isStreaming = true
        currentStreamingText = ""
        kodiMood = .thinking

        guard let url = URL(string: "\(settings.serverURL)/api/prompt") else {
            messages.append(ChatMessage(role: .system, kind: .error("Invalid server URL")))
            isStreaming = false
            return
        }

        var body: [String: Any] = [
            "prompt": text,
            "stream": true,
            "model": settings.model,
        ]
        if !settings.cwd.isEmpty {
            body["cwd"] = settings.cwd
        }

        sseClient = SSEClient()
        sseClient?.delegate = self
        connectionStatus = .connecting
        sseClient?.connect(url: url, body: body, sessionId: settings.sessionId)
    }

    func stopStreaming() {
        sseClient?.disconnect()
        sseClient = nil
        isStreaming = false
        kodiMood = .idle
    }

    func clearConversation() {
        messages.removeAll()
        settings?.resetSession()
    }

    private func appendAssistantText(_ text: String) {
        currentStreamingText += text
    }

    private func flushStreamingText() {
        if !currentStreamingText.isEmpty {
            messages.append(.assistant(currentStreamingText))
            currentStreamingText = ""
        }
    }
}

extension ChatSession: SSEClientDelegate {
    nonisolated func sseClient(_ client: SSEClient, didReceive event: SSEEvent) {
        Task { @MainActor in
            self.connectionStatus = .connected

            switch event {
            case .session(let sessionId):
                self.settings?.sessionId = sessionId

            case .text(let text):
                self.appendAssistantText(text)

            case .toolResult(let name, let result, let isError):
                self.flushStreamingText()
                self.messages.append(ChatMessage(
                    role: .assistant,
                    kind: .toolCall(name: name, status: isError ? .error : .done, result: result, isError: isError)
                ))

            case .toolProgress(let name, let index, let total, let status):
                self.kodiMood = .working
                // Update or append tool progress message
                if case .toolProgress = self.messages.last?.kind {
                    self.messages.removeLast()
                }
                self.messages.append(ChatMessage(
                    role: .assistant,
                    kind: .toolProgress(name: name, index: index, total: total, status: status)
                ))

            case .turnStart:
                self.kodiMood = .thinking

            case .compaction:
                break // silent

            case .done:
                self.flushStreamingText()
                self.isStreaming = false
                self.kodiMood = .done
                // Reset mood after 2s
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if self.kodiMood == .done { self.kodiMood = .idle }
                }

            case .error(let msg):
                self.messages.append(ChatMessage(role: .system, kind: .error(msg)))
                self.isStreaming = false
                self.kodiMood = .error
            }
        }
    }

    nonisolated func sseClient(_ client: SSEClient, didCompleteWithError error: Error?) {
        Task { @MainActor in
            self.flushStreamingText()
            self.isStreaming = false

            if let err = error, !err.localizedDescription.contains("cancelled") {
                self.connectionStatus = .error(err.localizedDescription)
                self.messages.append(ChatMessage(role: .system, kind: .error("Connection error: \(err.localizedDescription)")))
                self.kodiMood = .error
            } else {
                self.connectionStatus = .disconnected
            }
        }
    }
}
