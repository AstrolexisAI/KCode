// KCode - ANE Embedder helper
//
// Long-lived stdio JSON-RPC server: KCode (TypeScript) spawns this
// once per session, pipes embed requests to stdin, reads embeddings
// from stdout. The Core ML model loads once and stays in ANE-pinned
// memory for fast subsequent calls.
//
// Build:
//   swift build -c release --arch arm64
// Result: .build/arm64-apple-macosx/release/ANEEmbedder
//
// Protocol (JSON Lines, one message per line):
//   Request:  {"id": <int>, "method": "embed", "texts": ["..."]}
//   Response: {"id": <int>, "result": [[<float>, ...], ...]}
//   Error:    {"id": <int>, "error": "<message>"}
//
// Args: ANEEmbedder <path-to-model.mlmodelc>

import Foundation
import CoreML

@main
struct ANEEmbedder {
    // Singleton tokenizer sidecar — initialized once on startup, reused
    // for every embed call. Holds a long-lived Python process so we
    // don't pay tokenizer load (~500ms) per request.
    static var tokenizer: PythonTokenizer?

    static func main() {
        // First arg is the .mlmodelc path. Reject if missing.
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            fputs("usage: ANEEmbedder <path-to-model.mlmodelc>\n", stderr)
            exit(2)
        }
        let modelPath = args[1]
        let modelURL = URL(fileURLWithPath: modelPath)

        // Force ANE for both compute units AND the .all preference.
        // .cpuAndNeuralEngine pins to ANE; .all lets Core ML pick the
        // fastest path which on Apple Silicon also routes embedder
        // ops to ANE when supported.
        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndNeuralEngine

        let model: MLModel
        do {
            model = try MLModel(contentsOf: modelURL, configuration: config)
        } catch {
            fputs("ANEEmbedder: failed to load model from \(modelPath): \(error)\n", stderr)
            exit(3)
        }

        // Spawn the Python tokenizer sidecar. The tokenizer dir lives
        // beside the model file (~/.kcode/ane/tokenizer). If the
        // sidecar can't start (Python missing, transformers not
        // installed, tokenizer dir missing), we fall back to the
        // byte-as-token stub with a stderr warning — the helper still
        // works end-to-end, just with degraded similarity scores.
        let modelDir = (modelPath as NSString).deletingLastPathComponent
        let tokenizerDir = (modelDir as NSString).appendingPathComponent("tokenizer")
        if FileManager.default.fileExists(atPath: tokenizerDir) {
            do {
                tokenizer = try PythonTokenizer.spawn(tokenizerDir: tokenizerDir)
                fputs("ANEEmbedder: real xlm-roberta tokenizer ready\n", stderr)
            } catch {
                fputs("ANEEmbedder: tokenizer sidecar unavailable (\(error)) — falling back to byte stub\n", stderr)
                tokenizer = nil
            }
        } else {
            fputs("ANEEmbedder: no tokenizer dir at \(tokenizerDir) — using byte stub (degraded scores)\n", stderr)
        }

        // Read JSON-Lines from stdin until EOF.
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            handleLine(line, model: model)
        }
    }

    static func handleLine(_ line: String, model: MLModel) {
        guard let data = line.data(using: .utf8) else { return }
        var requestId: Int = 0

        do {
            let parsed = try JSONSerialization.jsonObject(with: data, options: [])
            guard let dict = parsed as? [String: Any] else {
                writeError(id: 0, message: "request not a JSON object")
                return
            }
            requestId = (dict["id"] as? Int) ?? 0
            guard let method = dict["method"] as? String else {
                writeError(id: requestId, message: "missing method")
                return
            }

            switch method {
            case "embed":
                guard let texts = dict["texts"] as? [String] else {
                    writeError(id: requestId, message: "missing or invalid 'texts' array")
                    return
                }
                let vectors = try embed(texts: texts, model: model)
                writeResult(id: requestId, vectors: vectors)
            case "health":
                writeRaw(id: requestId, payload: ["model": modelDescription(model)])
            default:
                writeError(id: requestId, message: "unknown method '\(method)'")
            }
        } catch {
            writeError(id: requestId, message: "\(error)")
        }
    }

    static func embed(texts: [String], model: MLModel) throws -> [[Float]] {
        // BGE-M3 export expects an "input_ids" tensor of shape
        // [1, seq_len]. We tokenize per-string and feed one at a
        // time. The conversion script in scripts/convert-bge-m3.py
        // ships a tokenizer.json beside the .mlmodelc so the helper
        // doesn't need to vendor a tokenizer separately — it reads
        // the same file Core ML used.
        //
        // To keep this PoC compact, we delegate tokenization to a
        // bundled Python sidecar at first. A pure-Swift tokenizer is
        // a follow-up. (See scripts/convert-bge-m3.py which prints a
        // working tokenize step KCode can shell out to as a stop-gap.)
        //
        // For now: each text → one model invocation → one 1024-dim
        // vector. Batch=1 is suboptimal for ANE throughput; a future
        // pass should pad+stack into a batch tensor.
        var output: [[Float]] = []
        for text in texts {
            let inputIds = try tokenize(text)
            let provider = try buildProvider(inputIds: inputIds, model: model)
            let result = try model.prediction(from: provider)
            let vec = try extractEmbedding(from: result, model: model)
            output.append(vec)
        }
        return output
    }

    // ── Tokenization stub ──────────────────────────────────────
    // Placeholder — pads to 512 to match the fixed input shape
    // baked into the Core ML trace (max_length=512 in conversion
    // script). Real xlm-roberta tokenization is the next iteration;
    // for now this lets us smoke-test the ANE pipeline end-to-end
    // even though embeddings won't be semantically meaningful.
    static let MAX_SEQ_LEN = 512

    static func tokenize(_ text: String) throws -> [Int32] {
        // Real path: delegate to the Python tokenizer sidecar that
        // ran AutoTokenizer.from_pretrained on startup. Sidecar already
        // pads to MAX_SEQ_LEN so we just convert the result.
        if let tok = tokenizer {
            let ids = try tok.tokenize(text: text, maxLen: MAX_SEQ_LEN)
            return ids.map { Int32($0) }
        }
        // Fallback when the sidecar didn't start (no Python venv, no
        // tokenizer dir): use byte values clamped to vocab size. Lets
        // the ANE pipeline keep working end-to-end with degraded but
        // non-zero similarity scores. Stderr warns the user at boot.
        let bytes = Array(text.utf8.prefix(MAX_SEQ_LEN)).map { Int32($0) }
        var padded = bytes
        while padded.count < MAX_SEQ_LEN { padded.append(0) }
        return padded
    }

    static func buildProvider(inputIds: [Int32], model: MLModel) throws -> MLDictionaryFeatureProvider {
        let count = inputIds.count
        let inputArray = try MLMultiArray(shape: [1, NSNumber(value: count)], dataType: .int32)
        let maskArray = try MLMultiArray(shape: [1, NSNumber(value: count)], dataType: .int32)
        for (i, v) in inputIds.enumerated() {
            inputArray[i] = NSNumber(value: v)
            // Tokens with id=0 are padding (BGE-M3 / xlm-roberta convention).
            // Mask them as 0 so attention skips them; real tokens get 1.
            maskArray[i] = NSNumber(value: v == 0 ? 0 : 1)
        }
        return try MLDictionaryFeatureProvider(dictionary: [
            "input_ids": inputArray,
            "attention_mask": maskArray,
        ])
    }

    static func extractEmbedding(from result: MLFeatureProvider, model: MLModel) throws -> [Float] {
        let outputName = model.modelDescription.outputDescriptionsByName.keys.first ?? "embeddings"
        guard let out = result.featureValue(for: outputName)?.multiArrayValue else {
            throw NSError(domain: "ANEEmbedder", code: 1, userInfo: [NSLocalizedDescriptionKey: "no output multiArray"])
        }
        // Output shape varies by model — common: [1, hidden_dim] or [1, seq_len, hidden_dim].
        // For sentence embedders we mean-pool over seq_len if needed.
        let shape = out.shape.map { $0.intValue }
        if shape.count == 2 {
            // [1, hidden_dim] — single vector
            return (0..<shape[1]).map { Float(truncating: out[$0]) }
        }
        if shape.count == 3 {
            // [1, seq_len, hidden_dim] — mean-pool over seq_len
            let seqLen = shape[1]
            let hidden = shape[2]
            var pooled = [Float](repeating: 0, count: hidden)
            for s in 0..<seqLen {
                for h in 0..<hidden {
                    pooled[h] += Float(truncating: out[s * hidden + h])
                }
            }
            for h in 0..<hidden { pooled[h] /= Float(seqLen) }
            // L2 normalize
            let norm = sqrt(pooled.map { $0 * $0 }.reduce(0, +))
            if norm > 0 {
                for h in 0..<hidden { pooled[h] /= norm }
            }
            return pooled
        }
        throw NSError(domain: "ANEEmbedder", code: 2, userInfo: [NSLocalizedDescriptionKey: "unexpected output shape \(shape)"])
    }

    static func modelDescription(_ m: MLModel) -> String {
        let desc = m.modelDescription
        return "\(desc.metadata[MLModelMetadataKey.author] ?? "unknown") / inputs=\(desc.inputDescriptionsByName.keys.sorted())"
    }

    // ── Output helpers ─────────────────────────────────────────

    static func writeResult(id: Int, vectors: [[Float]]) {
        let payload: [String: Any] = ["id": id, "result": vectors]
        writeJSON(payload)
    }

    static func writeError(id: Int, message: String) {
        let payload: [String: Any] = ["id": id, "error": message]
        writeJSON(payload)
    }

    static func writeRaw(id: Int, payload: [String: Any]) {
        var out = payload
        out["id"] = id
        writeJSON(out)
    }

    static func writeJSON(_ obj: Any) {
        do {
            let data = try JSONSerialization.data(withJSONObject: obj, options: [])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        } catch {
            fputs("ANEEmbedder: failed to write JSON: \(error)\n", stderr)
        }
    }
}

// ── Python tokenizer sidecar ────────────────────────────────────
//
// Spawns scripts/tokenize-server.py and pipes JSON-Lines requests over
// stdin/stdout. The sidecar loads AutoTokenizer once (BAAI/bge-m3 is
// xlm-roberta SentencePiece Unigram) and stays warm for the lifetime
// of the helper. We pick the Python interpreter in this order:
//   1. ANE_PYTHON env var (explicit override)
//   2. ~/.kcode/ane/venv/bin/python3 (if the user created a venv)
//   3. /opt/homebrew/bin/python3.11 / .12 / .13 (Homebrew on Apple Si)
//   4. /usr/bin/python3 (system)
// If none have `transformers` installed, the sidecar fails fast and
// the helper falls back to the byte-stub tokenizer (warning logged).

final class PythonTokenizer {
    private let process: Process
    private let stdin: Pipe
    private let stdout: Pipe
    private var buffer = Data()
    private var nextId: Int = 1
    private let lock = NSLock()

    static func spawn(tokenizerDir: String) throws -> PythonTokenizer {
        let scriptPath = findScriptPath()
        guard let scriptPath else {
            throw NSError(domain: "ANEEmbedder", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "tokenize-server.py not found"
            ])
        }
        let pythonPath = try findPython()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: pythonPath)
        proc.arguments = [scriptPath, tokenizerDir]
        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardInput = inPipe
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        try proc.run()

        let tok = PythonTokenizer(process: proc, stdin: inPipe, stdout: outPipe)
        // Wait for the "ready" handshake (single line on stdout).
        let ready = try tok.readLine(timeout: 30.0)
        if let dict = try? JSONSerialization.jsonObject(with: ready, options: []) as? [String: Any],
           dict["ready"] as? Bool == true {
            return tok
        }
        // If the sidecar wrote an error instead of ready, surface it.
        if let dict = try? JSONSerialization.jsonObject(with: ready, options: []) as? [String: Any],
           let err = dict["error"] as? String {
            throw NSError(domain: "ANEEmbedder", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "tokenizer sidecar: \(err)"
            ])
        }
        throw NSError(domain: "ANEEmbedder", code: 12, userInfo: [
            NSLocalizedDescriptionKey: "tokenizer sidecar did not handshake"
        ])
    }

    private init(process: Process, stdin: Pipe, stdout: Pipe) {
        self.process = process
        self.stdin = stdin
        self.stdout = stdout
    }

    func tokenize(text: String, maxLen: Int) throws -> [Int] {
        lock.lock()
        defer { lock.unlock() }
        let id = nextId; nextId += 1
        let payload: [String: Any] = ["id": id, "text": text, "max_len": maxLen]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [])
        stdin.fileHandleForWriting.write(data)
        stdin.fileHandleForWriting.write("\n".data(using: .utf8)!)
        let line = try readLine(timeout: 10.0)
        guard let dict = try JSONSerialization.jsonObject(with: line, options: []) as? [String: Any] else {
            throw NSError(domain: "ANEEmbedder", code: 13, userInfo: [
                NSLocalizedDescriptionKey: "sidecar response not a JSON object"
            ])
        }
        if let err = dict["error"] as? String {
            throw NSError(domain: "ANEEmbedder", code: 14, userInfo: [
                NSLocalizedDescriptionKey: "sidecar error: \(err)"
            ])
        }
        guard let ids = dict["ids"] as? [Any] else {
            throw NSError(domain: "ANEEmbedder", code: 15, userInfo: [
                NSLocalizedDescriptionKey: "sidecar response missing 'ids' field"
            ])
        }
        return ids.compactMap { ($0 as? NSNumber)?.intValue }
    }

    /// Read one newline-delimited line of JSON from the sidecar's
    /// stdout, blocking up to `timeout` seconds.
    private func readLine(timeout: TimeInterval) throws -> Data {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: 0..<nl)
                buffer.removeSubrange(0...nl)
                return line
            }
            if Date() > deadline {
                throw NSError(domain: "ANEEmbedder", code: 16, userInfo: [
                    NSLocalizedDescriptionKey: "tokenizer sidecar read timeout"
                ])
            }
            // availableData blocks until data arrives or the pipe closes.
            let chunk = stdout.fileHandleForReading.availableData
            if chunk.isEmpty {
                throw NSError(domain: "ANEEmbedder", code: 17, userInfo: [
                    NSLocalizedDescriptionKey: "tokenizer sidecar EOF"
                ])
            }
            buffer.append(chunk)
        }
    }

    private static func findScriptPath() -> String? {
        // The Swift binary lives at ~/.kcode/ane/ane-embedder. The
        // tokenize script may be installed alongside the binary or
        // (during dev) in vendor/ane-embedder/scripts. Probe both.
        let env = ProcessInfo.processInfo.environment
        if let explicit = env["ANE_TOKENIZER_SCRIPT"],
           FileManager.default.fileExists(atPath: explicit) {
            return explicit
        }
        let candidates = [
            (env["HOME"] ?? "/tmp") + "/.kcode/ane/tokenize-server.py",
            // Repo-relative when running uninstalled
            FileManager.default.currentDirectoryPath + "/vendor/ane-embedder/scripts/tokenize-server.py",
        ]
        for c in candidates where FileManager.default.fileExists(atPath: c) {
            return c
        }
        return nil
    }

    private static func findPython() throws -> String {
        let env = ProcessInfo.processInfo.environment
        if let explicit = env["ANE_PYTHON"], FileManager.default.isExecutableFile(atPath: explicit) {
            return explicit
        }
        let home = env["HOME"] ?? "/tmp"
        let candidates = [
            // KCode venvs (with or without dot — convert-bge-m3.py docs
            // suggest both layouts depending on the Python tool used)
            home + "/.kcode/ane/venv/bin/python3",
            home + "/.kcode/ane/.venv/bin/python3",
            home + "/.kcode/ane/venv/bin/python",
            home + "/.kcode/ane/.venv/bin/python",
            "/opt/homebrew/bin/python3.13",
            "/opt/homebrew/bin/python3.12",
            "/opt/homebrew/bin/python3.11",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        throw NSError(domain: "ANEEmbedder", code: 18, userInfo: [
            NSLocalizedDescriptionKey: "no usable python3 found (tried \(candidates))"
        ])
    }
}
