// swift-tools-version: 5.9
//
// KCode ANE Embedder helper — long-lived Swift binary that pipes
// JSON-RPC over stdio and runs Core ML inference on the Neural
// Engine. Built on macOS-arm64 only.

import PackageDescription

let package = Package(
    name: "ANEEmbedder",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ANEEmbedder",
            path: "Sources/ANEEmbedder"
        )
    ]
)
