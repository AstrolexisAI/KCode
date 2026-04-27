// KCode - C/C++ Project Engine
//
// Machine generates complete C/C++ projects from description:
// CMake build system, source structure, headers, tests, CI
//
// "create a C++ HTTP server"
// → Machine: CMake + src/ + include/ + tests/ + main.cpp + Dockerfile
// → LLM: only business logic

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CppProjectType =
  | "library" // Static/shared library
  | "cli" // Command-line tool
  | "server" // Network server (HTTP, TCP, UDP)
  | "embedded" // Embedded/microcontroller
  | "game" // Game / graphics
  | "system" // System utility / daemon
  | "driver" // Device driver / kernel module
  | "gui" // Desktop GUI app
  | "scientific" // Scientific / numerical computing
  | "custom";

export interface CppProjectConfig {
  name: string;
  type: CppProjectType;
  standard: "c11" | "c17" | "c23" | "cpp14" | "cpp17" | "cpp20" | "cpp23";
  dependencies: string[];
  features: string[];
  usesCmake: boolean;
  hasTesting: boolean;
  hasDocker: boolean;
  hasCI: boolean;
}

// ── Project Type Detection ─────────────────────────────────────

function detectCppProject(message: string): CppProjectConfig {
  const lower = message.toLowerCase();

  let type: CppProjectType = "cli";
  let standard: CppProjectConfig["standard"] = "cpp17";
  const dependencies: string[] = [];
  const features: string[] = [];

  // Detect type
  if (/\b(?:lib|library|biblioteca)\b/i.test(lower)) type = "library";
  else if (/\b(?:server|servidor|http|tcp|udp|socket|network|red)\b/i.test(lower)) type = "server";
  else if (/\b(?:embedded|microcontroller|arduino|stm32|esp32|firmware)\b/i.test(lower))
    type = "embedded";
  else if (/\b(?:game|juego|opengl|vulkan|sdl|sfml|graphics|gráficos)\b/i.test(lower))
    type = "game";
  else if (/\b(?:system|daemon|service|servicio|utility|herramienta)\b/i.test(lower))
    type = "system";
  else if (/\b(?:driver|kernel|módulo|module)\b/i.test(lower)) type = "driver";
  else if (/\b(?:gui|desktop|gtk|qt|imgui|interfaz)\b/i.test(lower)) type = "gui";
  else if (/\b(?:scientific|numerical|math|fft|matrix|simulation|simulación)\b/i.test(lower))
    type = "scientific";

  // Detect language standard
  if (/\bc\b(?!\+)/.test(lower) && !/c\+\+/.test(lower)) standard = "c17";
  if (/\bc23\b/.test(lower)) standard = "c23";
  if (/\bc\+\+\s*20\b|cpp20\b/.test(lower)) standard = "cpp20";
  if (/\bc\+\+\s*23\b|cpp23\b/.test(lower)) standard = "cpp23";
  if (/\bc\+\+\s*14\b|cpp14\b/.test(lower)) standard = "cpp14";

  // Detect dependencies
  if (/\b(?:boost)\b/i.test(lower)) dependencies.push("Boost");
  if (/\b(?:openssl|tls|ssl|crypto)\b/i.test(lower)) dependencies.push("OpenSSL");
  if (/\b(?:curl|http\s*client)\b/i.test(lower)) dependencies.push("CURL");
  if (/\b(?:sqlite|database|db|base\s*de\s*datos)\b/i.test(lower)) dependencies.push("SQLite3");
  if (/\b(?:json|nlohmann)\b/i.test(lower)) dependencies.push("nlohmann_json");
  if (/\b(?:protobuf|grpc)\b/i.test(lower)) dependencies.push("Protobuf");
  if (/\b(?:opencv|vision|imagen|image)\b/i.test(lower)) dependencies.push("OpenCV");
  if (/\b(?:sdl|sfml)\b/i.test(lower)) dependencies.push(lower.includes("sdl") ? "SDL2" : "SFML");
  if (/\b(?:opengl|vulkan|glfw)\b/i.test(lower)) dependencies.push("OpenGL", "GLFW");
  if (/\b(?:qt)\b/i.test(lower)) dependencies.push("Qt6");
  if (/\b(?:imgui)\b/i.test(lower)) dependencies.push("imgui");
  if (/\b(?:pthread|thread|hilo|concurren)\b/i.test(lower)) features.push("threading");
  if (/\b(?:async|asio|epoll|io_uring)\b/i.test(lower)) dependencies.push("asio");
  if (/\b(?:websocket|ws)\b/i.test(lower)) dependencies.push("websocketpp");
  if (/\b(?:mqtt)\b/i.test(lower)) dependencies.push("mosquitto");
  if (/\b(?:redis)\b/i.test(lower)) dependencies.push("hiredis");
  if (/\b(?:postgres|postgresql)\b/i.test(lower)) dependencies.push("libpq");
  if (/\b(?:zmq|zeromq)\b/i.test(lower)) dependencies.push("ZeroMQ");

  // Features
  if (/\b(?:log|logging)\b/i.test(lower)) features.push("logging");
  if (/\b(?:config|configuration|yaml|toml)\b/i.test(lower)) features.push("config");
  if (/\b(?:signal|sigint|graceful)\b/i.test(lower)) features.push("signal-handling");
  if (/\b(?:memory\s*pool|allocator|arena)\b/i.test(lower)) features.push("memory-pool");
  if (/\b(?:benchmark|perf|performance)\b/i.test(lower)) features.push("benchmark");

  const nameMatch = message.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return {
    name,
    type,
    standard,
    dependencies,
    features,
    usesCmake: true,
    hasTesting: true,
    hasDocker: type !== "embedded" && type !== "driver",
    hasCI: true,
  };
}

// ── File Generators ────────────────────────────────────────────

function isCpp(cfg: CppProjectConfig): boolean {
  return cfg.standard.startsWith("cpp");
}

function stdFlag(cfg: CppProjectConfig): string {
  return cfg.standard.replace("cpp", "c++").replace("c", "c");
}

function ext(cfg: CppProjectConfig): string {
  return isCpp(cfg) ? "cpp" : "c";
}

function hext(cfg: CppProjectConfig): string {
  return isCpp(cfg) ? "hpp" : "h";
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}

function generateCMake(cfg: CppProjectConfig): GenFile {
  const deps = cfg.dependencies.map((d) => `find_package(${d} REQUIRED)`).join("\n");
  const links = cfg.dependencies
    .map((d) => {
      const targets: Record<string, string> = {
        OpenSSL: "OpenSSL::SSL OpenSSL::Crypto",
        CURL: "CURL::libcurl",
        SQLite3: "SQLite::SQLite3",
        Boost: "Boost::boost",
        OpenCV: "${OpenCV_LIBS}",
        SDL2: "SDL2::SDL2",
        SFML: "sfml-graphics sfml-window sfml-system",
        OpenGL: "OpenGL::GL",
        GLFW: "glfw",
        Qt6: "Qt6::Widgets",
        Protobuf: "protobuf::libprotobuf",
      };
      return targets[d] ?? d.toLowerCase();
    })
    .join(" ");

  const targetType =
    cfg.type === "library"
      ? `add_library(\${PROJECT_NAME} STATIC \${SOURCES})`
      : `add_executable(\${PROJECT_NAME} \${SOURCES})`;

  return {
    path: "CMakeLists.txt",
    content: `cmake_minimum_required(VERSION 3.20)
project(${cfg.name} VERSION 0.1.0 LANGUAGES ${isCpp(cfg) ? "CXX" : "C"})

set(CMAKE_${isCpp(cfg) ? "CXX" : "C"}_STANDARD ${cfg.standard.replace(/[a-z+]/g, "")})
set(CMAKE_${isCpp(cfg) ? "CXX" : "C"}_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Strict compiler warnings
add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wconversion)

${deps ? "# Dependencies\n" + deps + "\n" : ""}
# Source files
file(GLOB_RECURSE SOURCES "src/*.${ext(cfg)}")

# Target
${targetType}
target_include_directories(\${PROJECT_NAME} PUBLIC include)
${links ? `target_link_libraries(\${PROJECT_NAME} PRIVATE ${links})` : ""}
${cfg.features.includes("threading") ? `find_package(Threads REQUIRED)\ntarget_link_libraries(\${PROJECT_NAME} PRIVATE Threads::Threads)` : ""}

# Install
install(TARGETS \${PROJECT_NAME} DESTINATION bin)
${cfg.type === "library" ? `install(DIRECTORY include/ DESTINATION include)` : ""}

# Tests
${
  cfg.hasTesting
    ? `enable_testing()
add_subdirectory(tests)`
    : ""
}
`,
    needsLlm: false,
  };
}

function generateMain(cfg: CppProjectConfig): GenFile {
  const templates: Record<string, string> = {
    cli: isCpp(cfg)
      ? `#include <iostream>
#include <string>
#include "${cfg.name}.${hext(cfg)}"

int main(int argc, char* argv[]) {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <args>" << std::endl;
        return 1;
    }

    // TODO: implement CLI logic
    std::cout << "${cfg.name} v0.1.0" << std::endl;

    return 0;
}
`
      : `#include <stdio.h>
#include <stdlib.h>
#include "${cfg.name}.${hext(cfg)}"

int main(int argc, char* argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <args>\\n", argv[0]);
        return 1;
    }

    printf("${cfg.name} v0.1.0\\n");
    return 0;
}
`,
    server: `#include <iostream>
#include <sstream>
#include <string>
#include <map>
#include <vector>
#include <mutex>
#include <csignal>
#include <cstring>
#include <ctime>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>

static volatile bool running = true;
void signal_handler(int) { running = false; }

// ── Logging ──
enum class LogLevel { DEBUG, INFO, WARN, ERR };
static LogLevel min_level = LogLevel::INFO;

void log(LogLevel lvl, const std::string& msg) {
    if (lvl < min_level) return;
    const char* labels[] = {"DEBUG", "INFO", "WARN", "ERROR"};
    time_t now = time(nullptr);
    char ts[20];
    strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%S", localtime(&now));
    std::cerr << ts << " [" << labels[static_cast<int>(lvl)] << "] " << msg << std::endl;
}

// ── Item Store ──
struct Item {
    int id;
    std::string name;
    std::string description;
    std::string created_at;
};

class ItemStore {
    std::map<int, Item> items_;
    std::mutex mu_;
    int next_id_ = 1;
public:
    std::vector<Item> list() {
        std::lock_guard<std::mutex> lock(mu_);
        std::vector<Item> result;
        for (auto& [_, item] : items_) result.push_back(item);
        return result;
    }

    Item* get(int id) {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = items_.find(id);
        return it != items_.end() ? &it->second : nullptr;
    }

    Item create(const std::string& name, const std::string& desc) {
        std::lock_guard<std::mutex> lock(mu_);
        time_t now = time(nullptr);
        char ts[20];
        strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%S", localtime(&now));
        Item item{next_id_++, name, desc, std::string(ts)};
        items_[item.id] = item;
        return item;
    }

    bool remove(int id) {
        std::lock_guard<std::mutex> lock(mu_);
        return items_.erase(id) > 0;
    }
};

static ItemStore store;

// ── JSON helpers ──
std::string item_json(const Item& i) {
    return "{\\"id\\":" + std::to_string(i.id) +
           ",\\"name\\":\\"" + i.name +
           "\\",\\"description\\":\\"" + i.description +
           "\\",\\"created_at\\":\\"" + i.created_at + "\\"}";
}

std::string items_json(const std::vector<Item>& items) {
    std::string r = "[";
    for (size_t i = 0; i < items.size(); i++) {
        if (i > 0) r += ",";
        r += item_json(items[i]);
    }
    return r + "]";
}

std::string error_json(const std::string& msg) {
    return "{\\"error\\":true,\\"message\\":\\"" + msg + "\\"}";
}

std::string extract_json_field(const std::string& body, const std::string& key) {
    std::string search = "\\"" + key + "\\":\\"";
    auto pos = body.find(search);
    if (pos == std::string::npos) return "";
    pos += search.length();
    auto end = body.find("\\"", pos);
    return (end != std::string::npos) ? body.substr(pos, end - pos) : "";
}

// ── HTTP helpers ──
struct HttpRequest {
    std::string method;
    std::string path;
    std::string body;
};

HttpRequest parse_request(const char* raw, ssize_t len) {
    HttpRequest req;
    std::string data(raw, len);
    std::istringstream iss(data);
    iss >> req.method >> req.path;
    auto body_pos = data.find("\\r\\n\\r\\n");
    if (body_pos != std::string::npos) req.body = data.substr(body_pos + 4);
    return req;
}

std::string http_response(int status, const std::string& body) {
    std::string status_text = (status == 200) ? "OK" : (status == 201) ? "Created" :
        (status == 204) ? "No Content" : (status == 400) ? "Bad Request" :
        (status == 404) ? "Not Found" : (status == 422) ? "Unprocessable Entity" : "Error";
    return "HTTP/1.1 " + std::to_string(status) + " " + status_text +
           "\\r\\nContent-Type: application/json\\r\\nContent-Length: " +
           std::to_string(body.length()) + "\\r\\n\\r\\n" + body;
}

int extract_id(const std::string& path) {
    auto pos = path.rfind('/');
    if (pos == std::string::npos) return -1;
    try { return std::stoi(path.substr(pos + 1)); } catch (...) { return -1; }
}

// ── Route handler ──
std::string handle_request(const HttpRequest& req) {
    log(LogLevel::INFO, req.method + " " + req.path);

    if (req.path == "/health" && req.method == "GET") {
        return http_response(200, "{\\"status\\":\\"ok\\"}");
    }

    if (req.path == "/api/items" && req.method == "GET") {
        return http_response(200, items_json(store.list()));
    }

    if (req.path == "/api/items" && req.method == "POST") {
        std::string name = extract_json_field(req.body, "name");
        if (name.empty()) return http_response(422, error_json("name is required"));
        std::string desc = extract_json_field(req.body, "description");
        auto item = store.create(name, desc);
        log(LogLevel::INFO, "Created item " + std::to_string(item.id));
        return http_response(201, item_json(item));
    }

    if (req.path.rfind("/api/items/", 0) == 0 && req.method == "GET") {
        int id = extract_id(req.path);
        auto* item = store.get(id);
        if (!item) return http_response(404, error_json("Item not found"));
        return http_response(200, item_json(*item));
    }

    if (req.path.rfind("/api/items/", 0) == 0 && req.method == "PUT") {
        int id = extract_id(req.path);
        auto* item = store.get(id);
        if (!item) return http_response(404, error_json("Item not found"));
        std::string name = extract_json_field(req.body, "name");
        if (name.empty()) return http_response(422, error_json("name is required"));
        std::string desc = extract_json_field(req.body, "description");
        item->name = name;
        item->description = desc;
        log(LogLevel::INFO, "Updated item " + std::to_string(id));
        return http_response(200, item_json(*item));
    }

    if (req.path.rfind("/api/items/", 0) == 0 && req.method == "DELETE") {
        int id = extract_id(req.path);
        if (!store.remove(id)) return http_response(404, error_json("Item not found"));
        log(LogLevel::INFO, "Deleted item " + std::to_string(id));
        return http_response(204, "");
    }

    return http_response(404, error_json("Not found"));
}

int main(int argc, char* argv[]) {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    uint16_t port = 10080;
    if (argc > 1) port = static_cast<uint16_t>(std::stoi(argv[1]));

    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        log(LogLevel::ERR, std::string("Socket failed: ") + strerror(errno));
        return 1;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);

    if (bind(server_fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) < 0) {
        log(LogLevel::ERR, std::string("Bind failed: ") + strerror(errno));
        close(server_fd);
        return 1;
    }

    if (listen(server_fd, 128) < 0) {
        log(LogLevel::ERR, std::string("Listen failed: ") + strerror(errno));
        close(server_fd);
        return 1;
    }

    log(LogLevel::INFO, "${cfg.name} listening on port " + std::to_string(port));

    while (running) {
        struct sockaddr_in client_addr{};
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(server_fd, reinterpret_cast<struct sockaddr*>(&client_addr), &client_len);
        if (client_fd < 0) {
            if (running) log(LogLevel::WARN, std::string("Accept failed: ") + strerror(errno));
            continue;
        }

        char buffer[8192];
        ssize_t bytes = read(client_fd, buffer, sizeof(buffer) - 1);
        if (bytes > 0) {
            buffer[bytes] = '\\0';
            auto req = parse_request(buffer, bytes);
            auto resp = handle_request(req);
            write(client_fd, resp.c_str(), resp.length());
        }
        close(client_fd);
    }

    close(server_fd);
    log(LogLevel::INFO, "Shutdown complete");
    return 0;
}
`,
    library: isCpp(cfg)
      ? `// Library entry point — implement in src/${cfg.name}.${ext(cfg)}
#include "${cfg.name}.${hext(cfg)}"

// See include/${cfg.name}.${hext(cfg)} for public API
`
      : `#include "${cfg.name}.${hext(cfg)}"
`,
    system: `#include <iostream>
#include <csignal>
#include <chrono>
#include <thread>
#include "${cfg.name}.${hext(cfg)}"

static volatile bool running = true;
void signal_handler(int) { running = false; }

int main() {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    std::cout << "${cfg.name} daemon started" << std::endl;

    while (running) {
        // TODO: daemon work loop
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    std::cout << "\\nDaemon stopped." << std::endl;
    return 0;
}
`,
  };

  return {
    path: `src/main.${ext(cfg)}`,
    content: templates[cfg.type] ?? templates["cli"]!,
    needsLlm: cfg.type !== "server",
  };
}

function generateHeader(cfg: CppProjectConfig): GenFile {
  const guard = `${cfg.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${hext(cfg).toUpperCase()}`;

  return {
    path: `include/${cfg.name}.${hext(cfg)}`,
    content: isCpp(cfg)
      ? `#pragma once
#ifndef ${guard}
#define ${guard}

#include <string>
#include <vector>
#include <memory>
#include <optional>
#include <stdexcept>

namespace ${cfg.name} {

/**
 * ${cfg.name} — Main API
 *
 * TODO: define your public interface here
 */

class ${capitalize(cfg.name)} {
public:
    ${capitalize(cfg.name)}() = default;
    ~${capitalize(cfg.name)}() = default;

    // Non-copyable, movable
    ${capitalize(cfg.name)}(const ${capitalize(cfg.name)}&) = delete;
    ${capitalize(cfg.name)}& operator=(const ${capitalize(cfg.name)}&) = delete;
    ${capitalize(cfg.name)}(${capitalize(cfg.name)}&&) noexcept = default;
    ${capitalize(cfg.name)}& operator=(${capitalize(cfg.name)}&&) noexcept = default;

    // TODO: public methods
    void init();
    void run();
    void shutdown();

private:
    bool initialized_ = false;
};

} // namespace ${cfg.name}

#endif // ${guard}
`
      : `#pragma once
#ifndef ${guard}
#define ${guard}

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * ${cfg.name} — Public API
 */

typedef struct ${cfg.name}_ctx ${cfg.name}_ctx_t;

${cfg.name}_ctx_t* ${cfg.name}_create(void);
void ${cfg.name}_destroy(${cfg.name}_ctx_t* ctx);
int ${cfg.name}_init(${cfg.name}_ctx_t* ctx);
int ${cfg.name}_run(${cfg.name}_ctx_t* ctx);

#ifdef __cplusplus
}
#endif

#endif // ${guard}
`,
    needsLlm: true,
  };
}

function generateImpl(cfg: CppProjectConfig): GenFile {
  return {
    path: `src/${cfg.name}.${ext(cfg)}`,
    content: isCpp(cfg)
      ? `#include "${cfg.name}.${hext(cfg)}"
#include <iostream>

namespace ${cfg.name} {

void ${capitalize(cfg.name)}::init() {
    if (initialized_) return;
    // TODO: initialization logic
    initialized_ = true;
}

void ${capitalize(cfg.name)}::run() {
    if (!initialized_) {
        throw std::runtime_error("Not initialized. Call init() first.");
    }
    // TODO: main logic
}

void ${capitalize(cfg.name)}::shutdown() {
    if (!initialized_) return;
    // TODO: cleanup
    initialized_ = false;
}

} // namespace ${cfg.name}
`
      : `#include "${cfg.name}.${hext(cfg)}"
#include <stdlib.h>
#include <string.h>

struct ${cfg.name}_ctx {
    int initialized;
    // TODO: add fields
};

${cfg.name}_ctx_t* ${cfg.name}_create(void) {
    ${cfg.name}_ctx_t* ctx = calloc(1, sizeof(${cfg.name}_ctx_t));
    return ctx;
}

void ${cfg.name}_destroy(${cfg.name}_ctx_t* ctx) {
    if (!ctx) return;
    // TODO: cleanup resources
    free(ctx);
}

int ${cfg.name}_init(${cfg.name}_ctx_t* ctx) {
    if (!ctx) return -1;
    // TODO: init logic
    ctx->initialized = 1;
    return 0;
}

int ${cfg.name}_run(${cfg.name}_ctx_t* ctx) {
    if (!ctx || !ctx->initialized) return -1;
    // TODO: main logic
    return 0;
}
`,
    needsLlm: true,
  };
}

function generateTests(cfg: CppProjectConfig): GenFile[] {
  if (!cfg.hasTesting) return [];

  return [
    {
      path: "tests/CMakeLists.txt",
      content: `include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.tar.gz
)
FetchContent_MakeAvailable(googletest)

add_executable(${cfg.name}_tests
  test_main.${ext(cfg)}
)
target_link_libraries(${cfg.name}_tests PRIVATE
  ${cfg.name}
  GTest::gtest_main
)
target_include_directories(${cfg.name}_tests PRIVATE \${CMAKE_SOURCE_DIR}/include)

include(GoogleTest)
gtest_discover_tests(${cfg.name}_tests)
`,
      needsLlm: false,
    },
    {
      path: `tests/test_main.${ext(cfg)}`,
      content: isCpp(cfg)
        ? `#include <gtest/gtest.h>
#include "${cfg.name}.${hext(cfg)}"

using namespace ${cfg.name};

class ${capitalize(cfg.name)}Test : public ::testing::Test {
protected:
    ${capitalize(cfg.name)} instance;

    void SetUp() override {
        instance.init();
    }

    void TearDown() override {
        instance.shutdown();
    }
};

TEST_F(${capitalize(cfg.name)}Test, InitSucceeds) {
    // Already init'd in SetUp
    EXPECT_NO_THROW(instance.run());
}

TEST_F(${capitalize(cfg.name)}Test, DoubleInitSafe) {
    EXPECT_NO_THROW(instance.init());
}

TEST_F(${capitalize(cfg.name)}Test, RunWithoutInitThrows) {
    ${capitalize(cfg.name)} uninit;
    EXPECT_THROW(uninit.run(), std::runtime_error);
}

// TODO: add domain-specific tests
`
        : `#include <gtest/gtest.h>
extern "C" {
#include "${cfg.name}.${hext(cfg)}"
}

TEST(${capitalize(cfg.name)}Test, CreateDestroy) {
    ${cfg.name}_ctx_t* ctx = ${cfg.name}_create();
    ASSERT_NE(ctx, nullptr);
    ${cfg.name}_destroy(ctx);
}

TEST(${capitalize(cfg.name)}Test, InitSucceeds) {
    ${cfg.name}_ctx_t* ctx = ${cfg.name}_create();
    EXPECT_EQ(${cfg.name}_init(ctx), 0);
    ${cfg.name}_destroy(ctx);
}

TEST(${capitalize(cfg.name)}Test, RunWithoutInitFails) {
    ${cfg.name}_ctx_t* ctx = ${cfg.name}_create();
    EXPECT_EQ(${cfg.name}_run(ctx), -1);
    ${cfg.name}_destroy(ctx);
}
`,
      needsLlm: true,
    },
  ];
}

function generateExtras(cfg: CppProjectConfig): GenFile[] {
  const files: GenFile[] = [];

  // .clang-format
  files.push({
    path: ".clang-format",
    content: `BasedOnStyle: LLVM
IndentWidth: 4
ColumnLimit: 100
AllowShortFunctionsOnASingleLine: Inline
BreakBeforeBraces: Attach
PointerAlignment: Left
SortIncludes: true
`,
    needsLlm: false,
  });

  // .clang-tidy
  files.push({
    path: ".clang-tidy",
    content: `Checks: >
  -*,
  bugprone-*,
  clang-analyzer-*,
  cppcoreguidelines-*,
  misc-*,
  modernize-*,
  performance-*,
  readability-*,
  -modernize-use-trailing-return-type,
  -readability-magic-numbers,
  -cppcoreguidelines-avoid-magic-numbers
WarningsAsErrors: ''
`,
    needsLlm: false,
  });

  // .gitignore
  files.push({
    path: ".gitignore",
    content: `build/
cmake-build-*/
.cache/
compile_commands.json
*.o
*.a
*.so
*.dylib
*.exe
.vscode/
.idea/
`,
    needsLlm: false,
  });

  // Dockerfile
  if (cfg.hasDocker) {
    files.push({
      path: "Dockerfile",
      content: `FROM gcc:14 AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y cmake
COPY . .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)

FROM debian:bookworm-slim
COPY --from=builder /app/build/${cfg.name} /usr/local/bin/
ENTRYPOINT ["${cfg.name}"]
`,
      needsLlm: false,
    });
  }

  // GitHub Actions CI
  if (cfg.hasCI) {
    files.push({
      path: ".github/workflows/ci.yml",
      content: `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: cmake -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j$(nproc)
      - name: Test
        run: cd build && ctest --output-on-failure
`,
      needsLlm: false,
    });
  }

  // README
  files.push({
    path: "README.md",
    content: `# ${cfg.name}

${cfg.type === "library" ? "A C" + (isCpp(cfg) ? "++" : "") + " library." : "A C" + (isCpp(cfg) ? "++" : "") + " " + cfg.type + "."}

## Build

\`\`\`bash
cmake -B build
cmake --build build -j$(nproc)
\`\`\`

## Test

\`\`\`bash
cd build && ctest --output-on-failure
\`\`\`
${cfg.dependencies.length > 0 ? "\n## Dependencies\n\n" + cfg.dependencies.map((d) => `- ${d}`).join("\n") + "\n" : ""}
## Structure

\`\`\`
${cfg.name}/
├── CMakeLists.txt
├── include/${cfg.name}.${hext(cfg)}
├── src/
│   ├── main.${ext(cfg)}
│   └── ${cfg.name}.${ext(cfg)}
├── tests/
│   └── test_main.${ext(cfg)}
${cfg.hasDocker ? "├── Dockerfile\n" : ""}└── README.md
\`\`\`

*Generated by KCode — Astrolexis.space*
`,
    needsLlm: false,
  });

  return files;
}

function capitalize(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// ── Main Creator ───────────────────────────────────────────────

export interface CppProjectResult {
  config: CppProjectConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createCppProject(userRequest: string, cwd: string): CppProjectResult {
  const config = detectCppProject(userRequest);
  const files: GenFile[] = [];

  files.push(generateCMake(config));
  files.push(generateMain(config));
  files.push(generateHeader(config));
  files.push(generateImpl(config));
  files.push(...generateTests(config));
  files.push(...generateExtras(config));

  // Write files
  const projectPath = join(cwd, config.name);
  for (const file of files) {
    const fullPath = join(projectPath, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }

  const machineFiles = files.filter((f) => !f.needsLlm).length;
  const llmFiles = files.filter((f) => f.needsLlm).length;

  const prompt = `You are implementing a ${config.type} in ${isCpp(config) ? "C++" + config.standard.replace("cpp", "") : "C" + config.standard.replace("c", "")}.

PROJECT: ${config.name}
TYPE: ${config.type}
STANDARD: ${stdFlag(config)}
DEPENDENCIES: ${config.dependencies.join(", ") || "none"}

The machine already created ${machineFiles} files (CMake, structure, tests, CI, Docker).
You need to implement the business logic in ${llmFiles} files:

${files
  .filter((f) => f.needsLlm)
  .map((f) => `- ${f.path}`)
  .join("\n")}

USER REQUEST: "${userRequest}"

INSTRUCTIONS:
1. Implement the TODO sections in each file
2. Use modern ${isCpp(config) ? "C++" : "C"} idioms (RAII, smart pointers, const correctness)
3. Add proper error handling (exceptions for C++, error codes for C)
4. Make the code production-quality
5. Fill in the test cases with meaningful assertions
6. Do NOT modify CMakeLists.txt or config files`;

  return { config, files, projectPath, prompt };
}
