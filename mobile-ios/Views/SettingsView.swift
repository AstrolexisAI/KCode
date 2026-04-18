// KCodeMobile - Settings view
// Server URL, model, cwd configuration

import SwiftUI

// Model entry returned by the KCode server's /api/models endpoint.
// We only decode the fields we need for the picker.
struct RemoteModel: Decodable, Identifiable, Hashable {
    let name: String
    let provider: String?
    let description: String?
    let gpu: String?
    var id: String { name }
}

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) var dismiss
    @State private var testingConnection = false
    @State private var testResult: String?
    // Dynamic model catalog (fetched from /api/models)
    @State private var availableModels: [RemoteModel] = []
    @State private var modelsLoading = false
    @State private var modelsError: String?

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

                Section {
                    if modelsLoading {
                        HStack {
                            ProgressView().scaleEffect(0.8)
                            Text("Loading models from server…").foregroundStyle(.secondary)
                        }
                    } else if let err = modelsError {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Could not reach the server").foregroundStyle(.red)
                            Text(err).font(.caption).foregroundStyle(.secondary)
                            // Fallback: free-text entry when the server is unreachable.
                            TextField("e.g. mnemo:mark6-mid", text: $settings.model)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            Button("Retry") { Task { await loadModels() } }
                        }
                    } else if availableModels.isEmpty {
                        Text("Server has no models configured. Run `kcode models add` or `kcode setup`.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("Type a model ID", text: $settings.model)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    } else {
                        Picker("Model", selection: $settings.model) {
                            ForEach(groupedModels(), id: \.provider) { group in
                                Section(header: Text(group.provider.uppercased())) {
                                    ForEach(group.entries) { m in
                                        VStack(alignment: .leading) {
                                            Text(m.name).font(.body)
                                            if let d = m.description, !d.isEmpty {
                                                Text(d).font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                        .tag(m.name)
                                    }
                                }
                            }
                        }
                        .pickerStyle(.navigationLink)
                        Button {
                            Task { await loadModels() }
                        } label: {
                            Label("Refresh from server", systemImage: "arrow.clockwise")
                        }
                    }
                } header: {
                    Text("Model")
                } footer: {
                    Text("Models are fetched live from your KCode server. Add a new one with `kcode models add` and tap Refresh.")
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
            .task { await loadModels() }
            .onChange(of: settings.serverURL) { _, _ in
                Task { await loadModels() }
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
                    await loadModels()
                } else {
                    testResult = "✗ Server not responding"
                }
            } catch {
                testResult = "✗ \(error.localizedDescription)"
            }
            testingConnection = false
        }
    }

    /// Fetch the model catalog from /api/models. Best-effort: falls back
    /// to a free-text field when the server is unreachable or empty.
    @MainActor
    private func loadModels() async {
        guard let url = URL(string: "\(settings.serverURL)/api/models") else {
            modelsError = "Invalid server URL"
            return
        }
        modelsLoading = true
        modelsError = nil
        defer { modelsLoading = false }
        do {
            var req = URLRequest(url: url)
            req.timeoutInterval = 5
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                modelsError = "Server returned non-200"
                return
            }
            struct Wrapper: Decodable { let models: [RemoteModel] }
            let wrapper = try JSONDecoder().decode(Wrapper.self, from: data)
            availableModels = wrapper.models
            // If the current selection isn't in the catalog, pick the first one.
            if !availableModels.contains(where: { $0.name == settings.model }), let first = availableModels.first {
                settings.model = first.name
            }
        } catch {
            modelsError = error.localizedDescription
        }
    }

    /// Group models by provider for a cleaner section-based picker.
    private func groupedModels() -> [(provider: String, entries: [RemoteModel])] {
        let dict = Dictionary(grouping: availableModels) { $0.provider ?? "other" }
        return dict.keys.sorted().map { (provider: $0, entries: dict[$0]!.sorted { $0.name < $1.name }) }
    }
}
