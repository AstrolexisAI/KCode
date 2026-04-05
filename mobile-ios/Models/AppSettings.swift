// KCodeMobile - Persistent settings
// Server URL, session ID, model preferences — persisted to UserDefaults

import Foundation
import SwiftUI

class AppSettings: ObservableObject {
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }

    @Published var model: String {
        didSet { UserDefaults.standard.set(model, forKey: "model") }
    }

    @Published var cwd: String {
        didSet { UserDefaults.standard.set(cwd, forKey: "cwd") }
    }

    @Published var sessionId: String? {
        didSet { UserDefaults.standard.set(sessionId, forKey: "sessionId") }
    }

    init() {
        self.serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:10100"
        self.model = UserDefaults.standard.string(forKey: "model") ?? "claude-opus-4-6"
        self.cwd = UserDefaults.standard.string(forKey: "cwd") ?? ""
        self.sessionId = UserDefaults.standard.string(forKey: "sessionId")
    }

    func resetSession() {
        sessionId = nil
    }
}
