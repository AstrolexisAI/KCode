// KCodeMobile - Chat view
// Main chat interface with message list and input bar

import SwiftUI

struct ChatView: View {
    @EnvironmentObject var chatSession: ChatSession
    @State private var inputText = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            MessageListView()
            InputBar(text: $inputText, isFocused: $inputFocused, onSend: sendMessage, onStop: chatSession.stopStreaming)
        }
        .background(Color(.systemGroupedBackground))
    }

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""
        Task {
            await chatSession.sendMessage(text)
        }
    }
}

struct MessageListView: View {
    @EnvironmentObject var chatSession: ChatSession

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(chatSession.messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }

                    // Streaming text preview
                    if chatSession.isStreaming && !chatSession.currentStreamingText.isEmpty {
                        MessageBubble(message: ChatMessage(
                            role: .assistant,
                            kind: .text(chatSession.currentStreamingText)
                        ))
                        .id("streaming")
                    }

                    // Typing indicator
                    if chatSession.isStreaming && chatSession.currentStreamingText.isEmpty {
                        TypingIndicator()
                            .id("typing")
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .onChange(of: chatSession.messages.count) { _, _ in
                withAnimation { proxy.scrollTo(chatSession.messages.last?.id, anchor: .bottom) }
            }
            .onChange(of: chatSession.currentStreamingText) { _, _ in
                proxy.scrollTo("streaming", anchor: .bottom)
            }
        }
    }
}

struct InputBar: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onStop: () -> Void
    @EnvironmentObject var chatSession: ChatSession

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message KCode...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 20))
                .lineLimit(1...6)
                .focused(isFocused)

            Button(action: chatSession.isStreaming ? onStop : onSend) {
                Image(systemName: chatSession.isStreaming ? "stop.circle.fill" : "arrow.up.circle.fill")
                    .font(.title)
                    .foregroundStyle(chatSession.isStreaming ? .red : .accentColor)
            }
            .disabled(!chatSession.isStreaming && text.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}

struct TypingIndicator: View {
    @State private var phase = 0

    var body: some View {
        HStack {
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle()
                        .fill(.secondary)
                        .frame(width: 6, height: 6)
                        .opacity(phase == i ? 1.0 : 0.3)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            Spacer()
        }
        .onAppear {
            Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
                phase = (phase + 1) % 3
            }
        }
    }
}
