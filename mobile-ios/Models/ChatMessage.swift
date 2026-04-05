// KCodeMobile - Chat message model
// Represents messages in the conversation: user input, assistant text, tool results

import Foundation

enum MessageRole: String, Codable {
    case user
    case assistant
    case system
}

enum MessageKind {
    case text(String)
    case toolCall(name: String, status: ToolStatus, result: String?, isError: Bool)
    case toolProgress(name: String, index: Int, total: Int, status: String)
    case agentUpdate(agents: [AgentStatus])
    case error(String)
}

enum ToolStatus: String {
    case running
    case done
    case error
}

struct AgentStatus: Identifiable {
    let id = UUID()
    let name: String
    let stepTitle: String
    let status: String // "running" | "done" | "failed"
    let durationMs: Int?
}

struct ChatMessage: Identifiable {
    let id = UUID()
    let role: MessageRole
    let kind: MessageKind
    let timestamp: Date

    init(role: MessageRole, kind: MessageKind) {
        self.role = role
        self.kind = kind
        self.timestamp = Date()
    }

    // Convenience constructors
    static func user(_ text: String) -> ChatMessage {
        ChatMessage(role: .user, kind: .text(text))
    }

    static func assistant(_ text: String) -> ChatMessage {
        ChatMessage(role: .assistant, kind: .text(text))
    }
}
