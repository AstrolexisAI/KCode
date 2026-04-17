// KCodeMobile - Settings view
// Server URL, model, cwd configuration

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) var dismiss
    @State private var testingConnection = false
    @State private var testResult: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://localhost:10100", text: $settings.serverURL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button(action: testConnection) {
                        HStack {
                            if testingConnection {
                                ProgressView().scaleEffect(0.8)
                            } else {
                                Image(systemName: "network")
                            }
                            Text("Test Connection")
                        }
                    }
                    .disabled(testingConnection)
                    if let result = testResult {
                        Text(result)
                            .font(.caption)
                            .foregroundStyle(result.contains("✓") ? .green : .red)
                    }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Your KCode HTTP server. Use localhost for same network, or Tailscale IP for remote access.")
                }

                Section("Model") {
                    TextField("e.g. mnemo:mark6-mid, gpt-4o, or any model your server has", text: $settings.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                Section {
                    TextField("/home/user/projects/myproject", text: $settings.cwd)
                        .textContentType(.none)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Working Directory")
                } footer: {
                    Text("Absolute path to the project KCode should work on. Leave empty to use server default.")
                }

                Section("Session") {
                    if let sid = settings.sessionId {
                        Text("ID: \(sid.prefix(8))")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    } else {
                        Text("No active session")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Button("Reset Session", role: .destructive) {
                        settings.resetSession()
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: "1.0.0")
                    LabeledContent("KCode", value: "v2.6.8+")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func testConnection() {
        testingConnection = true
        testResult = nil
        Task {
            guard let url = URL(string: "\(settings.serverURL)/api/health") else {
                testResult = "✗ Invalid URL"
                testingConnection = false
                return
            }
            do {
                let (_, response) = try await URLSession.shared.data(from: url)
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    testResult = "✓ Connected"
                } else {
                    testResult = "✗ Server not responding"
                }
            } catch {
                testResult = "✗ \(error.localizedDescription)"
            }
            testingConnection = false
        }
    }
}
