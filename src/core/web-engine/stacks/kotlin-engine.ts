// KCode - Kotlin Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type KotlinProjectType = "api" | "android" | "cli" | "library" | "multiplatform" | "desktop" | "custom";

interface KotlinConfig { name: string; type: KotlinProjectType; framework?: string; deps: string[]; pkg: string; }

function detectKotlinProject(msg: string): KotlinConfig {
  const lower = msg.toLowerCase();
  let type: KotlinProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:api|server|rest|ktor|spring)\b/i.test(lower)) {
    type = "api";
    if (/\b(?:spring)\b/i.test(lower)) { framework = "spring"; }
    else { framework = "ktor"; deps.push("io.ktor:ktor-server-core", "io.ktor:ktor-server-netty", "io.ktor:ktor-server-content-negotiation", "io.ktor:ktor-serialization-kotlinx-json"); }
  }
  else if (/\b(?:android|mobile|compose|jetpack)\b/i.test(lower)) { type = "android"; framework = "compose"; }
  else if (/\b(?:desktop|swing|compose.?desktop)\b/i.test(lower)) { type = "desktop"; framework = "compose-desktop"; }
  else if (/\b(?:cli|console|command|tool)\b/i.test(lower)) { type = "cli"; deps.push("com.github.ajalt.clikt:clikt"); }
  else if (/\b(?:lib|library|package)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:multiplatform|kmp|cross.?platform)\b/i.test(lower)) { type = "multiplatform"; }

  if (/\b(?:exposed|database|db|postgres|sql)\b/i.test(lower)) deps.push("org.jetbrains.exposed:exposed-core", "org.jetbrains.exposed:exposed-jdbc");
  if (/\b(?:koin|inject|di)\b/i.test(lower)) deps.push("io.insert-koin:koin-core");
  if (/\b(?:coroutine|async)\b/i.test(lower)) deps.push("org.jetbrains.kotlinx:kotlinx-coroutines-core");
  if (/\b(?:serialization|json)\b/i.test(lower) && !deps.some(d => d.includes("serialization"))) deps.push("org.jetbrains.kotlinx:kotlinx-serialization-json");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");
  const pkg = `com.${name.replace(/-/g, "").toLowerCase()}`;

  return { name, type, framework, deps: [...new Set(deps)], pkg };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface KotlinProjectResult { config: KotlinConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createKotlinProject(userRequest: string, cwd: string): KotlinProjectResult {
  const cfg = detectKotlinProject(userRequest);
  const files: GenFile[] = [];
  const pkgPath = cfg.pkg.replace(/\./g, "/");

  // build.gradle.kts
  if (cfg.type === "api" && cfg.framework === "ktor") {
    files.push({ path: "build.gradle.kts", content: `plugins {
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
    application
}

group = "${cfg.pkg}"
version = "0.1.0"

application { mainClass.set("${cfg.pkg}.MainKt") }

repositories { mavenCentral() }

dependencies {
    implementation("io.ktor:ktor-server-core:3.0.0")
    implementation("io.ktor:ktor-server-netty:3.0.0")
    implementation("io.ktor:ktor-server-content-negotiation:3.0.0")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.0.0")
    implementation("ch.qos.logback:logback-classic:1.5.0")
${cfg.deps.filter(d => !d.startsWith("io.ktor")).map(d => `    implementation("${d}")`).join("\n")}
    testImplementation("io.ktor:ktor-server-test-host:3.0.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
`, needsLlm: false });
  } else {
    files.push({ path: "build.gradle.kts", content: `plugins {
    kotlin("jvm") version "2.1.0"
${cfg.type === "cli" || cfg.type === "api" ? '    application' : ''}
}

group = "${cfg.pkg}"
version = "0.1.0"

${cfg.type === "cli" || cfg.type === "api" ? `application { mainClass.set("${cfg.pkg}.MainKt") }` : ""}

repositories { mavenCentral() }

dependencies {
${cfg.deps.map(d => `    implementation("${d}")`).join("\n")}
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
`, needsLlm: false });
  }

  files.push({ path: "settings.gradle.kts", content: `rootProject.name = "${cfg.name}"\n`, needsLlm: false });
  files.push({ path: "gradle/wrapper/gradle-wrapper.properties", content: `distributionUrl=https\\://services.gradle.org/distributions/gradle-8.12-bin.zip\n`, needsLlm: false });

  // Main code
  if (cfg.type === "api" && cfg.framework === "ktor") {
    files.push({ path: `src/main/kotlin/${pkgPath}/Main.kt`, content: `package ${cfg.pkg}

import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.plugins.contentnegotiation.*

fun main() {
    embeddedServer(Netty, port = 10080) {
        install(ContentNegotiation) { json() }
        routing {
            get("/health") { call.respond(mapOf("status" to "ok")) }

            // TODO: add routes
            route("/api/items") {
                get { call.respond(listOf(mapOf("id" to 1, "name" to "Sample"))) }
                post { call.respond(mapOf("created" to true)) }
            }
        }
    }.start(wait = true)
}
`, needsLlm: true });

  } else if (cfg.type === "cli") {
    files.push({ path: `src/main/kotlin/${pkgPath}/Main.kt`, content: `package ${cfg.pkg}

fun main(args: Array<String>) {
    if (args.isEmpty()) {
        println("Usage: ${cfg.name} <command>")
        return
    }

    // TODO: implement CLI logic
    println("${cfg.name} v0.1.0")
}
`, needsLlm: true });

  } else if (cfg.type === "library") {
    files.push({ path: `src/main/kotlin/${pkgPath}/${cap(cfg.name)}.kt`, content: `package ${cfg.pkg}

class ${cap(cfg.name)} {
    private var initialized = false

    fun initialize() {
        // TODO: setup
        initialized = true
    }

    fun process(data: Any): Any {
        check(initialized) { "Not initialized. Call initialize() first." }
        // TODO: main logic
        return data
    }
}
`, needsLlm: true });

  } else {
    files.push({ path: `src/main/kotlin/${pkgPath}/Main.kt`, content: `package ${cfg.pkg}

fun main() {
    println("${cfg.name} started")
    // TODO: implement
}
`, needsLlm: true });
  }

  // Test
  files.push({ path: `src/test/kotlin/${pkgPath}/${cap(cfg.name)}Test.kt`, content: `package ${cfg.pkg}

import kotlin.test.Test
import kotlin.test.assertTrue

class ${cap(cfg.name)}Test {
    @Test
    fun basic() {
        assertTrue(true)
    }

    // TODO: add tests
}
`, needsLlm: true });

  // Extras
  files.push({ path: ".gitignore", content: "build/\n.gradle/\n.idea/\n*.iml\n.env\n", needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM gradle:8-jdk21 AS builder\nWORKDIR /app\nCOPY . .\nRUN gradle build -x test\n\nFROM eclipse-temurin:21-jre\nCOPY --from=builder /app/build/libs/*.jar /app/app.jar\nEXPOSE 10080\nCMD ["java", "-jar", "/app/app.jar"]\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with: { distribution: temurin, java-version: 21 }\n      - run: ./gradlew test\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nKotlin ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\n./gradlew run\n./gradlew test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement Kotlin ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"` };
}

function cap(s: string): string { return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(""); }
