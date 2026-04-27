// KCode - Dart/Flutter Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DartProjectType =
  | "mobile"
  | "web"
  | "cli"
  | "library"
  | "server"
  | "package"
  | "custom";

interface DartConfig {
  name: string;
  type: DartProjectType;
  framework?: string;
  deps: Array<{ name: string; version: string }>;
}

function detectDartProject(msg: string): DartConfig {
  const lower = msg.toLowerCase();
  let type: DartProjectType = "mobile";
  let framework: string | undefined;
  const deps: Array<{ name: string; version: string }> = [];

  if (/\b(?:flutter\s*web|web\s*app|webapp|pwa)\b/i.test(lower)) {
    type = "web";
    framework = "flutter";
  } else if (/\b(?:mobile|flutter|ios|android|app)\b/i.test(lower)) {
    type = "mobile";
    framework = "flutter";
  } else if (/\b(?:server|backend|api|rest|shelf|dart.?frog)\b/i.test(lower)) {
    type = "server";
    if (/\b(?:dart.?frog)\b/i.test(lower)) {
      framework = "dart_frog";
      deps.push({ name: "dart_frog", version: "^1.1.0" });
    } else {
      framework = "shelf";
      deps.push({ name: "shelf", version: "^1.4.0" }, { name: "shelf_router", version: "^1.1.0" });
    }
  } else if (/\b(?:cli|command|terminal|tool|console)\b/i.test(lower)) {
    type = "cli";
    deps.push({ name: "args", version: "^2.5.0" });
  } else if (/\b(?:lib|library)\b/i.test(lower)) {
    type = "library";
  } else if (/\b(?:package|pub)\b/i.test(lower)) {
    type = "package";
  }

  // State management
  if (/\b(?:riverpod)\b/i.test(lower)) deps.push({ name: "flutter_riverpod", version: "^2.5.0" });
  if (/\b(?:bloc)\b/i.test(lower)) deps.push({ name: "flutter_bloc", version: "^8.1.0" });
  if (/\b(?:provider)\b/i.test(lower) && !deps.some((d) => d.name.includes("riverpod")))
    deps.push({ name: "provider", version: "^6.1.0" });

  // Networking
  if (/\b(?:dio)\b/i.test(lower)) deps.push({ name: "dio", version: "^5.4.0" });
  if (/\b(?:http\b)/i.test(lower) && !deps.some((d) => d.name === "dio"))
    deps.push({ name: "http", version: "^1.2.0" });

  // Database
  if (/\b(?:hive)\b/i.test(lower))
    deps.push({ name: "hive", version: "^2.2.0" }, { name: "hive_flutter", version: "^1.1.0" });
  if (/\b(?:drift)\b/i.test(lower)) deps.push({ name: "drift", version: "^2.16.0" });
  if (/\b(?:sqflite)\b/i.test(lower)) deps.push({ name: "sqflite", version: "^2.3.0" });

  // Firebase
  if (/\b(?:firebase)\b/i.test(lower))
    deps.push(
      { name: "firebase_core", version: "^2.27.0" },
      { name: "firebase_auth", version: "^4.17.0" },
    );

  // Code generation
  if (/\b(?:freezed)\b/i.test(lower)) deps.push({ name: "freezed_annotation", version: "^2.4.0" });

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" || type === "package" ? "mylib" : "myapp");

  return { name, type, framework, deps: dedup(deps) };
}

function dedup(
  deps: Array<{ name: string; version: string }>,
): Array<{ name: string; version: string }> {
  const seen = new Set<string>();
  return deps.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface DartProjectResult {
  config: DartConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createDartProject(userRequest: string, cwd: string): DartProjectResult {
  const cfg = detectDartProject(userRequest);
  const files: GenFile[] = [];

  // pubspec.yaml
  const isFlutter = cfg.framework === "flutter";
  const depsYaml = cfg.deps.map((d) => `  ${d.name}: ${d.version}`).join("\n");
  files.push({
    path: "pubspec.yaml",
    content: `name: ${cfg.name}
description: A ${cfg.type} project built with KCode.
version: 0.1.0
${isFlutter ? "" : "publish_to: none\n"}
environment:
  sdk: ">=3.3.0 <4.0.0"
${isFlutter ? '  flutter: ">=3.19.0"\n' : ""}
dependencies:
${isFlutter ? "  flutter:\n    sdk: flutter\n" : ""}${depsYaml ? depsYaml + "\n" : ""}
dev_dependencies:
${isFlutter ? "  flutter_test:\n    sdk: flutter\n" : "  test: ^1.25.0\n"}  lints: ^4.0.0
${isFlutter ? "\nflutter:\n  uses-material-design: true\n" : ""}`,
    needsLlm: false,
  });

  // analysis_options.yaml
  files.push({
    path: "analysis_options.yaml",
    content: `include: package:lints/recommended.yaml

linter:
  rules:
    prefer_const_constructors: true
    prefer_const_declarations: true
    avoid_print: false
`,
    needsLlm: false,
  });

  // Source files
  if (cfg.type === "mobile" && cfg.framework === "flutter") {
    files.push({
      path: "lib/main.dart",
      content: `import 'package:flutter/material.dart';
import 'app.dart';

void main() {
  runApp(const ${cap(cfg.name)}App());
}
`,
      needsLlm: false,
    });

    files.push({
      path: "lib/app.dart",
      content: `import 'package:flutter/material.dart';
import 'screens/home_screen.dart';

class ${cap(cfg.name)}App extends StatelessWidget {
  const ${cap(cfg.name)}App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${cfg.name}',
      theme: ThemeData(
        colorSchemeSeed: Colors.blue,
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
`,
      needsLlm: true,
    });

    files.push({
      path: "lib/screens/home_screen.dart",
      content: `import 'package:flutter/material.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _counter = 0;

  void _increment() {
    setState(() { _counter++; });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${cfg.name}')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('You have pushed the button this many times:'),
            Text('$_counter', style: Theme.of(context).textTheme.headlineMedium),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _increment,
        tooltip: 'Increment',
        child: const Icon(Icons.add),
      ),
    );
  }
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "web" && cfg.framework === "flutter") {
    files.push({
      path: "lib/main.dart",
      content: `import 'package:flutter/material.dart';
import 'app.dart';

void main() {
  runApp(const ${cap(cfg.name)}App());
}
`,
      needsLlm: false,
    });

    files.push({
      path: "lib/app.dart",
      content: `import 'package:flutter/material.dart';
import 'screens/home_screen.dart';

class ${cap(cfg.name)}App extends StatelessWidget {
  const ${cap(cfg.name)}App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '${cfg.name}',
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
`,
      needsLlm: true,
    });

    files.push({
      path: "lib/screens/home_screen.dart",
      content: `import 'package:flutter/material.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('${cfg.name}')),
      body: const Center(
        child: Text('Welcome to ${cfg.name}!', style: TextStyle(fontSize: 24)),
      ),
    );
  }
}
`,
      needsLlm: true,
    });

    files.push({
      path: "web/index.html",
      content: `<!DOCTYPE html>
<html>
<head>
  <base href="/">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${cfg.name}</title>
</head>
<body>
  <script src="main.dart.js" type="application/javascript"></script>
</body>
</html>
`,
      needsLlm: false,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: "bin/main.dart",
      content: `import 'package:args/args.dart';

void main(List<String> arguments) {
  final parser = ArgParser()
    ..addOption('input', abbr: 'i', help: 'Input file path')
    ..addOption('output', abbr: 'o', help: 'Output file path', defaultsTo: 'output.txt')
    ..addFlag('verbose', abbr: 'v', help: 'Verbose output', negatable: false)
    ..addFlag('help', abbr: 'h', help: 'Show usage', negatable: false);

  try {
    final results = parser.parse(arguments);

    if (results['help'] as bool) {
      print('Usage: ${cfg.name} [options]');
      print(parser.usage);
      return;
    }

    if (results['verbose'] as bool) {
      print('${cfg.name} v0.1.0');
    }

    // TODO: implement CLI logic

    print('Done!');
  } on FormatException catch (e) {
    print('Error: \${e.message}');
    print(parser.usage);
  }
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "server" && cfg.framework === "dart_frog") {
    files.push({
      path: "routes/index.dart",
      content: `import 'package:dart_frog/dart_frog.dart';

Response onRequest(RequestContext context) {
  return Response.json(body: {'status': 'ok', 'message': 'Welcome to ${cfg.name}'});
}
`,
      needsLlm: true,
    });

    files.push({
      path: "routes/health.dart",
      content: `import 'package:dart_frog/dart_frog.dart';

Response onRequest(RequestContext context) {
  return Response.json(body: {'status': 'ok'});
}
`,
      needsLlm: false,
    });

    files.push({
      path: "main.dart",
      content: `import 'dart:io';
import 'package:dart_frog/dart_frog.dart';

Future<HttpServer> run(Handler handler, InternetAddress ip, int port) {
  return serve(handler, ip, port);
}
`,
      needsLlm: false,
    });
  } else if (cfg.type === "server" && cfg.framework === "shelf") {
    files.push({
      path: "bin/server.dart",
      content: `import 'dart:io';
import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';
import 'package:shelf/shelf_io.dart' as io;

void main() async {
  final router = Router()
    ..get('/health', (Request request) {
      return Response.ok('{"status":"ok"}', headers: {'Content-Type': 'application/json'});
    })
    ..get('/api/items', (Request request) {
      return Response.ok('[{"id":1,"name":"Sample"}]', headers: {'Content-Type': 'application/json'});
    });

  // TODO: add routes

  final handler = Pipeline().addMiddleware(logRequests()).addHandler(router.call);
  final server = await io.serve(handler, InternetAddress.anyIPv4, 10080);
  print('Server running on port \${server.port}');
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "library" || cfg.type === "package") {
    files.push({
      path: `lib/src/${cfg.name}.dart`,
      content: `/// ${cap(cfg.name)} — Main library class.
class ${cap(cfg.name)} {
  bool _initialized = false;

  /// Initialize the library.
  void initialize() {
    // TODO: setup
    _initialized = true;
  }

  /// Process the given [data].
  dynamic process(dynamic data) {
    if (!_initialized) {
      throw StateError('Not initialized. Call initialize() first.');
    }
    // TODO: main logic
    return data;
  }
}
`,
      needsLlm: true,
    });

    files.push({
      path: `lib/${cfg.name}.dart`,
      content: `/// ${cap(cfg.name)} library.
library;

export 'src/${cfg.name}.dart';
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: "lib/main.dart",
      content: `void main() {
  print('${cfg.name} started');
  // TODO: implement
}
`,
      needsLlm: true,
    });
  }

  // Test file
  if (isFlutter) {
    files.push({
      path: "test/widget_test.dart",
      content: `import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('app renders', (WidgetTester tester) async {
    // TODO: add widget tests
    expect(true, isTrue);
  });
}
`,
      needsLlm: true,
    });
  } else {
    files.push({
      path: `test/${cfg.name}_test.dart`,
      content: `import 'package:test/test.dart';

void main() {
  group('${cfg.name}', () {
    test('basic', () {
      expect(true, isTrue);
    });

    // TODO: add tests
  });
}
`,
      needsLlm: true,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content: `.dart_tool/
.packages
build/
.pub/
.env
*.g.dart
*.freezed.dart
pubspec.lock
`,
    needsLlm: false,
  });

  files.push({
    path: "Dockerfile",
    content: `FROM dart:stable AS builder
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe ${cfg.type === "cli" ? "bin/main.dart" : cfg.type === "server" && cfg.framework === "shelf" ? "bin/server.dart" : "lib/main.dart"} -o /app/server

FROM debian:bookworm-slim
COPY --from=builder /app/server /app/server
EXPOSE 10080
CMD ["/app/server"]
`,
    needsLlm: false,
  });

  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dart-lang/setup-dart@v1
        with: { sdk: stable }
      - run: dart pub get
      - run: dart analyze
      - run: dart test
`,
    needsLlm: false,
  });

  files.push({
    path: "README.md",
    content: `# ${cfg.name}

Dart ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.

\`\`\`bash
dart pub get
${isFlutter ? "flutter run" : cfg.type === "cli" ? "dart run bin/main.dart" : cfg.type === "server" && cfg.framework === "shelf" ? "dart run bin/server.dart" : "dart run"}
dart test
\`\`\`

*Astrolexis.space — Kulvex Code*
`,
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
    prompt: `Implement Dart ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
