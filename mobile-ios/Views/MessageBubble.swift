// KCodeMobile - Message bubble component
// Renders a single message in the chat (text, tool result card, error, etc.)

import SwiftUI

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 40) }
            bubbleContent
            if message.role != .user { Spacer(minLength: 40) }
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        switch message.kind {
        case .text(let text):
            TextBubble(text: text, isUser: message.role == .user)
        case .toolCall(let name, let status, let result, let isError):
            ToolResultCard(name: name, status: status, result: result, isError: isError)
        case .toolProgress(let name, let index, let total, let status):
            ToolProgressBar(name: name, index: index, total: total, status: status)
        case .agentUpdate(let agents):
            AgentListCard(agents: agents)
        case .error(let msg):
            ErrorBubble(message: msg)
        }
    }
}

struct TextBubble: View {
    let text: String
    let isUser: Bool

    var body: some View {
        Text(text)
            .font(.body)
            .foregroundStyle(isUser ? .white : .primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(isUser ? Color.accentColor : Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .textSelection(.enabled)
    }
}

struct ToolResultCard: View {
    let name: String
    let status: ToolStatus
    let result: String?
    let isError: Bool
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: { withAnimation { expanded.toggle() } }) {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .foregroundStyle(iconColor)
                    Text(name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                    if let result = result, !expanded {
                        Text(result.split(separator: "\n").first.map(String.init) ?? "")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if result != nil {
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)

            if expanded, let result = result {
                ScrollView(.horizontal) {
                    Text(result)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 300)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var icon: String {
        switch status {
        case .running: return "circle.dotted"
        case .done: return isError ? "xmark.circle.fill" : "checkmark.circle.fill"
        case .error: return "exclamationmark.circle.fill"
        }
    }

    private var iconColor: Color {
        switch status {
        case .running: return .orange
        case .done: return isError ? .red : .green
        case .error: return .red
        }
    }
}

struct ToolProgressBar: View {
    let name: String
    let index: Int
    let total: Int
    let status: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .scaleEffect(0.7)
            Text("\(name) (\(index + 1)/\(total))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(10)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct AgentListCard: View {
    let agents: [AgentStatus]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("⚡ Agents (\(agents.filter { $0.status == "running" }.count) running)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)

            ForEach(agents) { agent in
                HStack(spacing: 8) {
                    Text(statusIcon(agent.status))
                    Text(agent.name)
                        .font(.caption.weight(.medium))
                    Text(agent.stepTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let ms = agent.durationMs {
                        Spacer()
                        Text("\(ms / 1000)s")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func statusIcon(_ status: String) -> String {
        switch status {
        case "running": return "⏳"
        case "done": return "✓"
        case "failed": return "✗"
        default: return "○"
        }
    }
}

struct ErrorBubble: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.caption)
                .foregroundStyle(.primary)
        }
        .padding(10)
        .background(Color.red.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
