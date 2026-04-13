// KCodeMobile - Persistent settings
// Non-sensitive prefs (serverURL, model, cwd) use UserDefaults.
// Sensitive auth tokens (sessionId) use Keychain via Security framework.

import Foundation
import Security
import SwiftUI

private enum KeychainHelper {
    static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

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
        didSet {
            if let id = sessionId {
                KeychainHelper.save(key: "sessionId", value: id)
            } else {
                KeychainHelper.delete(key: "sessionId")
            }
        }
    }

    init() {
        self.serverURL = UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:10100"
        self.model = UserDefaults.standard.string(forKey: "model") ?? "claude-opus-4-6"
        self.cwd = UserDefaults.standard.string(forKey: "cwd") ?? ""
        self.sessionId = KeychainHelper.load(key: "sessionId")
        // Migrate: if sessionId was previously in UserDefaults, move it
        // to Keychain and remove the plaintext copy.
        if sessionId == nil, let legacy = UserDefaults.standard.string(forKey: "sessionId") {
            self.sessionId = legacy
            UserDefaults.standard.removeObject(forKey: "sessionId")
        }
    }

    func resetSession() {
        sessionId = nil
    }
}
