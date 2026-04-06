// KCode - Java Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type JavaProjectType = "api" | "cli" | "library" | "microservice" | "android" | "desktop" | "custom";

interface JavaConfig { name: string; type: JavaProjectType; framework?: string; deps: string[]; pkg: string; }

function detectJavaProject(msg: string): JavaConfig {
  const lower = msg.toLowerCase();
  let type: JavaProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:api|server|rest|spring|quarkus|micronaut)\b/i.test(lower)) {
    type = "api";
    if (/\bquarkus\b/i.test(lower)) { framework = "quarkus"; }
    else if (/\bmicronaut\b/i.test(lower)) { framework = "micronaut"; }
    else { framework = "spring"; deps.push("spring-boot-starter-web", "spring-boot-starter-validation"); }
  }
  else if (/\b(?:android|mobile)\b/i.test(lower)) { type = "android"; }
  else if (/\b(?:desktop|gui|swing|javafx)\b/i.test(lower)) { type = "desktop"; }
  else if (/\b(?:lib|library)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:micro|microservice)\b/i.test(lower)) { type = "microservice"; framework = "spring"; }

  if (/\b(?:jpa|hibernate|database|db|postgres|mysql)\b/i.test(lower)) deps.push("spring-boot-starter-data-jpa", "h2");
  if (/\b(?:security|auth|jwt)\b/i.test(lower)) deps.push("spring-boot-starter-security", "jjwt");
  if (/\b(?:kafka|messaging|queue)\b/i.test(lower)) deps.push("spring-kafka");
  if (/\b(?:redis|cache)\b/i.test(lower)) deps.push("spring-boot-starter-data-redis");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "myapp";
  const pkg = `com.${name.replace(/-/g, "").toLowerCase()}`;

  return { name, type, framework, deps: [...new Set(deps)], pkg };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface JavaProjectResult { config: JavaConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createJavaProject(userRequest: string, cwd: string): JavaProjectResult {
  const cfg = detectJavaProject(userRequest);
  const files: GenFile[] = [];
  const pkgPath = cfg.pkg.replace(/\./g, "/");

  // Gradle build
  files.push({ path: "build.gradle.kts", content: `plugins {
    java
    id("org.springframework.boot") version "3.4.0"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "${cfg.pkg}"
version = "0.1.0"

java { sourceCompatibility = JavaVersion.VERSION_21 }

repositories { mavenCentral() }

dependencies {
${cfg.deps.map(d => `    implementation("org.springframework.boot:${d}")`).join("\n")}
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}

tasks.withType<Test> { useJUnitPlatform() }
`, needsLlm: false });

  files.push({ path: "settings.gradle.kts", content: `rootProject.name = "${cfg.name}"\n`, needsLlm: false });
  files.push({ path: "gradle/wrapper/gradle-wrapper.properties", content: `distributionUrl=https\\://services.gradle.org/distributions/gradle-8.12-bin.zip\n`, needsLlm: false });
  files.push({ path: "gradlew", content: `#!/bin/sh\nexec gradle "$@"\n`, needsLlm: false });

  // Application properties
  files.push({ path: "src/main/resources/application.yml", content: `server:\n  port: 8080\n\nspring:\n  application:\n    name: ${cfg.name}\n`, needsLlm: false });

  // Main class
  files.push({ path: `src/main/java/${pkgPath}/Application.java`, content: `package ${cfg.pkg};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`, needsLlm: false });

  // Controller
  files.push({ path: `src/main/java/${pkgPath}/controller/HealthController.java`, content: `package ${cfg.pkg}.controller;

import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class HealthController {

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }
}
`, needsLlm: false });

  // Entity + Service + Controller template
  files.push({ path: `src/main/java/${pkgPath}/controller/ItemController.java`, content: `package ${cfg.pkg}.controller;

import org.springframework.web.bind.annotation.*;
import java.util.*;

// TODO: implement CRUD controller
@RestController
@RequestMapping("/api/items")
public class ItemController {

    @GetMapping
    public List<Map<String, Object>> list() {
        // TODO: return items from service
        return List.of(Map.of("id", "1", "name", "Sample"));
    }

    @PostMapping
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        // TODO: create item via service
        return body;
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable String id) {
        // TODO: get by id
        return Map.of("id", id);
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable String id) {
        // TODO: delete
    }
}
`, needsLlm: true });

  // Test
  files.push({ path: `src/test/java/${pkgPath}/ApplicationTests.java`, content: `package ${cfg.pkg};

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class ApplicationTests {

    @Autowired
    TestRestTemplate restTemplate;

    @Test
    void contextLoads() {}

    @Test
    void healthEndpoint() {
        var response = restTemplate.getForObject("/api/health", String.class);
        assertThat(response).contains("ok");
    }

    // TODO: add domain-specific tests
}
`, needsLlm: true });

  // Extras
  files.push({ path: ".gitignore", content: "build/\n.gradle/\n*.class\n*.jar\n.idea/\n*.iml\n.env\n", needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM eclipse-temurin:21-jdk AS builder\nWORKDIR /app\nCOPY . .\nRUN ./gradlew build -x test\n\nFROM eclipse-temurin:21-jre\nCOPY --from=builder /app/build/libs/*.jar /app/app.jar\nEXPOSE 8080\nCMD ["java", "-jar", "/app/app.jar"]\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with: { distribution: temurin, java-version: 21 }\n      - run: ./gradlew test\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nSpring Boot API. Built with KCode.\n\n\`\`\`bash\n./gradlew bootRun\n./gradlew test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement Java ${cfg.type} (${cfg.framework}). ${m} files machine. USER: "${userRequest}"` };
}
