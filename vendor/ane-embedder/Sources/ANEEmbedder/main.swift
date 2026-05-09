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
    // Placeholder — the production version reads tokenizer.json
    // beside the model. For the PoC, return a fixed-length array so
    // the model load + Core ML pipeline can be smoke-tested. A
    // real BGE-M3 needs xlm-roberta tokenizer; using the shipped
    // tokenizer.json is the next iteration.
    static func tokenize(_ text: String) throws -> [Int32] {
        // Stub: 32-char prefix → byte values clamped to vocab. Will
        // be replaced by a real tokenizer in the build script.
        let bytes = Array(text.utf8.prefix(32)).map { Int32($0) }
        // Pad to 32 with zeros so the input shape is fixed.
        var padded = bytes
        while padded.count < 32 { padded.append(0) }
        return padded
    }

    static func buildProvider(inputIds: [Int32], model: MLModel) throws -> MLDictionaryFeatureProvider {
        let array = try MLMultiArray(shape: [1, NSNumber(value: inputIds.count)], dataType: .int32)
        for (i, v) in inputIds.enumerated() {
            array[i] = NSNumber(value: v)
        }
        return try MLDictionaryFeatureProvider(dictionary: ["input_ids": array])
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
