// KCode - Swift Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SwiftProjectType = "ios" | "macos" | "cli" | "server" | "package" | "custom";

interface SwiftConfig {
  name: string;
  type: SwiftProjectType;
  dependencies: Array<{ url: string; from: string }>;
  framework?: string;
}

function detectSwiftProject(msg: string): SwiftConfig {
  const lower = msg.toLowerCase();
  let type: SwiftProjectType = "ios";
  let framework: string | undefined;
  const deps: Array<{ url: string; from: string }> = [];

  if (/\b(?:ios|iphone|ipad|swiftui|uikit)\b/i.test(lower)) {
    type = "ios";
  } else if (/\b(?:macos|mac\s*app|desktop|appkit)\b/i.test(lower)) {
    type = "macos";
  } else if (/\b(?:cli|command|terminal|tool)\b/i.test(lower)) {
    type = "cli";
    deps.push({ url: "https://github.com/apple/swift-argument-parser", from: "1.5.0" });
  } else if (/\b(?:server|vapor|hummingbird|api|backend)\b/i.test(lower)) {
    type = "server";
    if (/\bhummingbird\b/i.test(lower)) {
      framework = "hummingbird";
      deps.push({ url: "https://github.com/hummingbird-project/hummingbird", from: "2.0.0" });
    } else {
      framework = "vapor";
      deps.push({ url: "https://github.com/vapor/vapor", from: "4.100.0" });
    }
  } else if (/\b(?:package|library|lib|spm)\b/i.test(lower)) {
    type = "package";
  }

  if (/\b(?:alamofire|network|http)\b/i.test(lower))
    deps.push({ url: "https://github.com/Alamofire/Alamofire", from: "5.10.0" });
  if (/\b(?:realm|database|db)\b/i.test(lower))
    deps.push({ url: "https://github.com/realm/realm-swift", from: "10.50.0" });
  if (/\b(?:keychain|security)\b/i.test(lower))
    deps.push({ url: "https://github.com/kishikawakatsumi/KeychainAccess", from: "4.2.2" });

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "package" ? "MyLib" : "MyApp");

  return { name, type, dependencies: deps, framework };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface SwiftProjectResult {
  config: SwiftConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createSwiftProject(userRequest: string, cwd: string): SwiftProjectResult {
  const cfg = detectSwiftProject(userRequest);
  const files: GenFile[] = [];

  if (cfg.type === "ios" || cfg.type === "macos") {
    // SwiftUI App
    files.push({
      path: "Package.swift",
      content: `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "${cfg.name}",
    platforms: [${cfg.type === "ios" ? ".iOS(.v17)" : ".macOS(.v14)"}],
    dependencies: [
${cfg.dependencies.map((d) => `        .package(url: "${d.url}", from: "${d.from}"),`).join("\n")}
    ],
    targets: [
        .executableTarget(name: "${cfg.name}", dependencies: [
${cfg.dependencies.map((d) => `            .product(name: "${d.url.split("/").pop()!.replace(".git", "")}", package: "${d.url.split("/").pop()!.replace(".git", "")}"),`).join("\n")}
        ]),
        .testTarget(name: "${cfg.name}Tests", dependencies: ["${cfg.name}"]),
    ]
)
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/${cfg.name}App.swift`,
      content: `import SwiftUI

@main
struct ${cfg.name}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/ContentView.swift`,
      content: `import SwiftUI

struct ContentView: View {
    @State private var count = 0

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                // TODO: implement your UI

                Text("${cfg.name}")
                    .font(.largeTitle)
                    .fontWeight(.bold)

                Text("Count: \\(count)")
                    .font(.title2)

                Button("Increment") {
                    count += 1
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .navigationTitle("${cfg.name}")
        }
    }
}

#Preview {
    ContentView()
}
`,
      needsLlm: true,
    });

    files.push({
      path: `Sources/Models/Item.swift`,
      content: `import Foundation

struct Item: Identifiable, Codable {
    let id: UUID
    var title: String
    var description: String
    var createdAt: Date

    init(title: String, description: String = "") {
        self.id = UUID()
        self.title = title
        self.description = description
        self.createdAt = Date()
    }
}
`,
      needsLlm: true,
    });

    files.push({
      path: `Sources/ViewModels/AppViewModel.swift`,
      content: `import SwiftUI

@Observable
class AppViewModel {
    var items: [Item] = []
    var isLoading = false
    var errorMessage: String?

    func loadItems() async {
        isLoading = true
        defer { isLoading = false }

        // TODO: fetch from API or local storage
        items = [
            Item(title: "Sample Item", description: "This is a sample"),
        ]
    }

    func addItem(_ item: Item) {
        items.append(item)
        // TODO: persist
    }

    func deleteItem(at offsets: IndexSet) {
        items.remove(atOffsets: offsets)
        // TODO: persist
    }
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: "Package.swift",
      content: `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "${cfg.name}",
    dependencies: [
${cfg.dependencies.map((d) => `        .package(url: "${d.url}", from: "${d.from}"),`).join("\n")}
    ],
    targets: [
        .executableTarget(name: "${cfg.name}", dependencies: [
            .product(name: "ArgumentParser", package: "swift-argument-parser"),
        ]),
        .testTarget(name: "${cfg.name}Tests", dependencies: ["${cfg.name}"]),
    ]
)
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/${cfg.name}.swift`,
      content: `import ArgumentParser

@main
struct ${cfg.name}: ParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "${cfg.name} — CLI tool",
        version: "0.1.0"
    )

    @Argument(help: "Input file path")
    var input: String

    @Option(name: .shortAndLong, help: "Output file path")
    var output: String = "output.txt"

    @Flag(name: .shortAndLong, help: "Verbose output")
    var verbose = false

    func run() throws {
        if verbose {
            print("Processing: \\(input)")
        }

        // TODO: implement CLI logic

        print("Done!")
    }
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "server") {
    files.push({
      path: "Package.swift",
      content: `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "${cfg.name}",
    platforms: [.macOS(.v14)],
    dependencies: [
${cfg.dependencies.map((d) => `        .package(url: "${d.url}", from: "${d.from}"),`).join("\n")}
    ],
    targets: [
        .executableTarget(name: "${cfg.name}", dependencies: [
            .product(name: "Vapor", package: "vapor"),
        ]),
        .testTarget(name: "${cfg.name}Tests", dependencies: [
            "${cfg.name}",
            .product(name: "XCTVapor", package: "vapor"),
        ]),
    ]
)
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/Models/Item.swift`,
      content: `import Vapor

struct Item: Content, Sendable {
    let id: String
    var name: String
    var description: String
    let createdAt: Date
}

struct CreateItemRequest: Content, Validatable {
    let name: String
    let description: String?

    static func validations(_ validations: inout Validations) {
        validations.add("name", as: String.self, is: !.empty && .count(1...200))
    }
}

struct UpdateItemRequest: Content, Validatable {
    let name: String
    let description: String?

    static func validations(_ validations: inout Validations) {
        validations.add("name", as: String.self, is: !.empty && .count(1...200))
    }
}
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/Services/ItemStore.swift`,
      content: `import Foundation

actor ItemStore {
    static let shared = ItemStore()

    private var items: [String: Item] = [:]

    func getAll() -> [Item] {
        items.values.sorted { $0.createdAt > $1.createdAt }
    }

    func get(_ id: String) -> Item? {
        items[id]
    }

    func create(name: String, description: String) -> Item {
        let item = Item(
            id: UUID().uuidString,
            name: name,
            description: description,
            createdAt: Date()
        )
        items[item.id] = item
        return item
    }

    func update(_ id: String, name: String, description: String) -> Item? {
        guard var existing = items[id] else { return nil }
        existing.name = name
        existing.description = description
        items[id] = existing
        return existing
    }

    func delete(_ id: String) -> Bool {
        items.removeValue(forKey: id) != nil
    }
}
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/Routes/ItemRoutes.swift`,
      content: `import Vapor

func registerItemRoutes(_ app: Application) {
    let items = app.grouped("api", "items")
    let store = ItemStore.shared

    items.get { req async throws -> [Item] in
        req.logger.info("Listing all items")
        return await store.getAll()
    }

    items.get(":id") { req async throws -> Item in
        guard let id = req.parameters.get("id") else {
            throw Abort(.badRequest, reason: "Missing item ID")
        }
        guard let item = await store.get(id) else {
            throw Abort(.notFound, reason: "Item not found: \\(id)")
        }
        return item
    }

    items.post { req async throws -> Response in
        try CreateItemRequest.validate(content: req)
        let input = try req.content.decode(CreateItemRequest.self)
        let item = await store.create(name: input.name, description: input.description ?? "")
        req.logger.info("Created item \\(item.id): \\(item.name)")
        let response = Response(status: .created)
        try response.content.encode(item)
        response.headers.replaceOrAdd(name: .location, value: "/api/items/\\(item.id)")
        return response
    }

    items.put(":id") { req async throws -> Item in
        guard let id = req.parameters.get("id") else {
            throw Abort(.badRequest, reason: "Missing item ID")
        }
        try UpdateItemRequest.validate(content: req)
        let input = try req.content.decode(UpdateItemRequest.self)
        guard let updated = await store.update(id, name: input.name, description: input.description ?? "") else {
            throw Abort(.notFound, reason: "Item not found: \\(id)")
        }
        req.logger.info("Updated item \\(id)")
        return updated
    }

    items.delete(":id") { req async throws -> HTTPStatus in
        guard let id = req.parameters.get("id") else {
            throw Abort(.badRequest, reason: "Missing item ID")
        }
        guard await store.delete(id) else {
            throw Abort(.notFound, reason: "Item not found: \\(id)")
        }
        req.logger.info("Deleted item \\(id)")
        return .noContent
    }
}
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/main.swift`,
      content: `import Vapor

let app = try Application(.detect())
defer { app.shutdown() }

app.logger.logLevel = .info

app.get("health") { _ in
    ["status": "ok"]
}

registerItemRoutes(app)

app.logger.info("${cfg.name} starting on port 10080")
app.http.server.configuration.port = 10080

try app.run()
`,
      needsLlm: false,
    });
  } else {
    // package
    files.push({
      path: "Package.swift",
      content: `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "${cfg.name}",
    products: [.library(name: "${cfg.name}", targets: ["${cfg.name}"])],
    targets: [
        .target(name: "${cfg.name}"),
        .testTarget(name: "${cfg.name}Tests", dependencies: ["${cfg.name}"]),
    ]
)
`,
      needsLlm: false,
    });

    files.push({
      path: `Sources/${cfg.name}.swift`,
      content: `/// ${cfg.name} — A Swift library
public struct ${cfg.name} {
    private var initialized = false

    public init() {}

    public mutating func initialize() throws {
        // TODO: setup
        initialized = true
    }

    public func run() throws {
        guard initialized else { throw ${cfg.name}Error.notInitialized }
        // TODO: main logic
    }
}

public enum ${cfg.name}Error: Error, CustomStringConvertible {
    case notInitialized
    public var description: String {
        switch self {
        case .notInitialized: return "Not initialized. Call initialize() first."
        }
    }
}
`,
      needsLlm: true,
    });
  }

  // Tests
  if (cfg.type === "server") {
    files.push({
      path: `Tests/${cfg.name}Tests.swift`,
      content: `import XCTVapor
@testable import ${cfg.name}

final class ${cfg.name}Tests: XCTestCase {
    var app: Application!

    override func setUp() async throws {
        app = try Application(.testing)
        app.get("health") { _ in ["status": "ok"] }
        registerItemRoutes(app)
    }

    override func tearDown() async throws {
        app.shutdown()
    }

    func testHealthEndpoint() async throws {
        try app.test(.GET, "health") { res in
            XCTAssertEqual(res.status, .ok)
        }
    }

    func testListItemsEmpty() async throws {
        try app.test(.GET, "api/items") { res in
            XCTAssertEqual(res.status, .ok)
        }
    }

    func testCreateItem() async throws {
        let body = #"{"name":"Test","description":"A test item"}"#
        try app.test(.POST, "api/items", headers: ["Content-Type": "application/json"], body: .init(string: body)) { res in
            XCTAssertEqual(res.status, .created)
            XCTAssertNotNil(res.headers[.location].first)
        }
    }

    func testCreateItemMissingName() async throws {
        let body = #"{"name":"","description":"No name"}"#
        try app.test(.POST, "api/items", headers: ["Content-Type": "application/json"], body: .init(string: body)) { res in
            XCTAssertTrue(res.status == .badRequest || res.status == .unprocessableEntity)
        }
    }

    func testGetItemNotFound() async throws {
        try app.test(.GET, "api/items/nonexistent-id") { res in
            XCTAssertEqual(res.status, .notFound)
        }
    }

    func testDeleteItemNotFound() async throws {
        try app.test(.DELETE, "api/items/nonexistent-id") { res in
            XCTAssertEqual(res.status, .notFound)
        }
    }
}
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: `Tests/${cfg.name}Tests.swift`,
      content: `import Testing
@testable import ${cfg.name}

@Suite("${cfg.name} Tests")
struct ${cfg.name}Tests {
    @Test func basic() async throws {
        // TODO: add tests
        #expect(true)
    }
}
`,
      needsLlm: true,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content: ".build/\n.swiftpm/\nPackage.resolved\n*.xcodeproj\nDerivedData/\n",
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: macos-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: swift build\n      - run: swift test\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nBuilt with KCode.\n\n\`\`\`bash\nswift build\nswift run\nswift test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
    needsLlm: false,
  });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) {
    const p = join(projectPath, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }

  const m = files.filter((f) => !f.needsLlm).length;
  const l = files.filter((f) => f.needsLlm).length;
  return {
    config: cfg,
    files,
    projectPath,
    prompt: `Implement a Swift ${cfg.type}. ${m} files machine, ${l} for LLM. USER: "${userRequest}"`,
  };
}
