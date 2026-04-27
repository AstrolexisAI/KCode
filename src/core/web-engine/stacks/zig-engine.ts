// KCode - Zig Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ZigProjectType = "cli" | "library" | "server" | "embedded" | "wasm" | "game" | "custom";

interface ZigConfig {
  name: string;
  type: ZigProjectType;
  deps: Array<{ name: string; url: string }>;
}

function detectZigProject(msg: string): ZigConfig {
  const lower = msg.toLowerCase();
  let type: ZigProjectType = "cli";
  const deps: Array<{ name: string; url: string }> = [];

  if (/\b(?:server|http|api|rest|web)\b/i.test(lower)) {
    type = "server";
    deps.push({ name: "httpz", url: "https://github.com/karlseguin/http.zig" });
  } else if (/\b(?:lib|library|package)\b/i.test(lower)) {
    type = "library";
  } else if (
    /\b(?:embedded|firmware|bare.?metal|stm32|esp|arm|riscv|microcontroller)\b/i.test(lower)
  ) {
    type = "embedded";
  } else if (/\b(?:wasm|webassembly|browser)\b/i.test(lower)) {
    type = "wasm";
  } else if (/\b(?:game|raylib|opengl|sdl|graphics)\b/i.test(lower)) {
    type = "game";
    if (/\braylib\b/i.test(lower))
      deps.push({ name: "raylib", url: "https://github.com/raysan5/raylib" });
  }

  if (/\b(?:log|logging)\b/i.test(lower))
    deps.push({ name: "log", url: "https://github.com/ziglang/zig" });
  if (/\b(?:json)\b/i.test(lower))
    deps.push({ name: "json", url: "https://github.com/getty-zig/getty" });

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, deps };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface ZigProjectResult {
  config: ZigConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createZigProject(userRequest: string, cwd: string): ZigProjectResult {
  const cfg = detectZigProject(userRequest);
  const files: GenFile[] = [];
  const snakeName = cfg.name.replace(/-/g, "_");

  // build.zig
  if (cfg.type === "library") {
    files.push({
      path: "build.zig",
      content: `const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addStaticLibrary(.{
        .name = "${snakeName}",
        .root_source_file = b.path("src/${snakeName}.zig"),
        .target = target,
        .optimize = optimize,
    });
    b.installArtifact(lib);

    const tests = b.addTest(.{
        .root_source_file = b.path("src/${snakeName}.zig"),
        .target = target,
        .optimize = optimize,
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: "build.zig",
      content: `const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "${snakeName}",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| { run_cmd.addArgs(args); }
    const run_step = b.step("run", "Run the application");
    run_step.dependOn(&run_cmd.step);

    const tests = b.addTest(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
`,
      needsLlm: false,
    });
  }

  files.push({
    path: "build.zig.zon",
    content: `.{
    .name = "${snakeName}",
    .version = "0.1.0",
    .paths = .{
        "build.zig",
        "build.zig.zon",
        "src",
    },
}
`,
    needsLlm: false,
  });

  // Source code
  if (cfg.type === "cli") {
    files.push({
      path: "src/main.zig",
      content: `const std = @import("std");

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();

    var args = try std.process.argsWithAllocator(std.heap.page_allocator);
    defer args.deinit();

    _ = args.skip(); // program name

    const input = args.next() orelse {
        try std.io.getStdErr().writer().print("Usage: ${snakeName} <input>\\n", .{});
        std.process.exit(1);
    };

    try stdout.print("Processing: {s}\\n", .{input});

    // TODO: implement CLI logic

    try stdout.print("Done!\\n", .{});
}

test "basic" {
    try std.testing.expect(true);
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "library") {
    files.push({
      path: `src/${snakeName}.zig`,
      content: `const std = @import("std");

pub const ${cap(cfg.name)} = struct {
    initialized: bool = false,
    allocator: std.mem.Allocator,

    const Self = @This();

    pub fn init(allocator: std.mem.Allocator) Self {
        return .{ .allocator = allocator };
    }

    pub fn setup(self: *Self) !void {
        // TODO: setup
        self.initialized = true;
    }

    pub fn process(self: *const Self, data: []const u8) ![]const u8 {
        if (!self.initialized) return error.NotInitialized;
        // TODO: main logic
        return data;
    }
};

test "init and process" {
    var lib = ${cap(cfg.name)}.init(std.testing.allocator);
    try lib.setup();
    const result = try lib.process("hello");
    try std.testing.expectEqualStrings("hello", result);
}

test "process without setup fails" {
    const lib = ${cap(cfg.name)}.init(std.testing.allocator);
    const result = lib.process("data");
    try std.testing.expectError(error.NotInitialized, result);
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "server") {
    files.push({
      path: "src/main.zig",
      content: `const std = @import("std");

pub fn main() !void {
    const address = std.net.Address.parseIp("0.0.0.0", 10080) catch unreachable;
    var server = try address.listen(.{ .reuse_address = true });
    defer server.deinit();

    std.log.info("${cfg.name} listening on :10080", .{});

    while (true) {
        const conn = try server.accept();
        defer conn.stream.close();

        var buf: [4096]u8 = undefined;
        const n = try conn.stream.read(&buf);
        if (n == 0) continue;

        const response = "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{\\"status\\":\\"ok\\"}";
        _ = try conn.stream.write(response);
    }
}

test "basic" {
    try std.testing.expect(true);
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "embedded") {
    files.push({
      path: "src/main.zig",
      content: `const std = @import("std");
const builtin = @import("builtin");

// Embedded entry point
export fn _start() callconv(.c) noreturn {
    main() catch {};
    while (true) {}
}

fn main() !void {
    // TODO: hardware init
    // TODO: main loop

    while (true) {
        // TODO: process
        asm volatile ("nop");
    }
}

test "basic" {
    try std.testing.expect(true);
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "wasm") {
    files.push({
      path: "src/main.zig",
      content: `const std = @import("std");

// WASM exports
export fn add(a: i32, b: i32) i32 {
    return a + b;
}

export fn multiply(a: i32, b: i32) i32 {
    return a * b;
}

// TODO: add more exports

test "add" {
    try std.testing.expectEqual(@as(i32, 5), add(2, 3));
}

test "multiply" {
    try std.testing.expectEqual(@as(i32, 6), multiply(2, 3));
}
`,
      needsLlm: true,
    });
  } else {
    files.push({
      path: "src/main.zig",
      content: `const std = @import("std");

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("${cfg.name} v0.1.0\\n", .{});

    // TODO: implement

}

test "basic" {
    try std.testing.expect(true);
}
`,
      needsLlm: true,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content: "zig-out/\nzig-cache/\n.zig-cache/\n",
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: mlugg/setup-zig@v2\n        with: { version: "0.13.0" }\n      - run: zig build test\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nZig ${cfg.type}. Built with KCode.\n\n\`\`\`bash\nzig build\nzig build run\nzig build test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
    needsLlm: false,
  });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) {
    const p = join(projectPath, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }

  const m = files.filter((f) => !f.needsLlm).length;
  return {
    config: cfg,
    files,
    projectPath,
    prompt: `Implement Zig ${cfg.type}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
