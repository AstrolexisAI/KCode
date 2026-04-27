// KCode - Java Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type JavaProjectType =
  | "api"
  | "cli"
  | "library"
  | "microservice"
  | "android"
  | "desktop"
  | "custom";

interface JavaConfig {
  name: string;
  type: JavaProjectType;
  framework?: string;
  deps: string[];
  pkg: string;
}

function detectJavaProject(msg: string): JavaConfig {
  const lower = msg.toLowerCase();
  let type: JavaProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:api|server|rest|spring|quarkus|micronaut)\b/i.test(lower)) {
    type = "api";
    if (/\bquarkus\b/i.test(lower)) {
      framework = "quarkus";
    } else if (/\bmicronaut\b/i.test(lower)) {
      framework = "micronaut";
    } else {
      framework = "spring";
      deps.push("spring-boot-starter-web", "spring-boot-starter-validation");
    }
  } else if (/\b(?:android|mobile)\b/i.test(lower)) {
    type = "android";
  } else if (/\b(?:desktop|gui|swing|javafx)\b/i.test(lower)) {
    type = "desktop";
  } else if (/\b(?:lib|library)\b/i.test(lower)) {
    type = "library";
  } else if (/\b(?:micro|microservice)\b/i.test(lower)) {
    type = "microservice";
    framework = "spring";
  }

  if (/\b(?:jpa|hibernate|database|db|postgres|mysql)\b/i.test(lower))
    deps.push("spring-boot-starter-data-jpa", "h2");
  if (/\b(?:security|auth|jwt)\b/i.test(lower)) deps.push("spring-boot-starter-security", "jjwt");
  if (/\b(?:kafka|messaging|queue)\b/i.test(lower)) deps.push("spring-kafka");
  if (/\b(?:redis|cache)\b/i.test(lower)) deps.push("spring-boot-starter-data-redis");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "myapp";
  const pkg = `com.${name.replace(/-/g, "").toLowerCase()}`;

  return { name, type, framework, deps: [...new Set(deps)], pkg };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface JavaProjectResult {
  config: JavaConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createJavaProject(userRequest: string, cwd: string): JavaProjectResult {
  const cfg = detectJavaProject(userRequest);
  const files: GenFile[] = [];
  const pkgPath = cfg.pkg.replace(/\./g, "/");

  // Gradle build
  files.push({
    path: "build.gradle.kts",
    content: `plugins {
    java
    id("org.springframework.boot") version "3.4.0"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "${cfg.pkg}"
version = "0.1.0"

java { sourceCompatibility = JavaVersion.VERSION_21 }

repositories { mavenCentral() }

dependencies {
${cfg.deps.map((d) => `    implementation("org.springframework.boot:${d}")`).join("\n")}
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}

tasks.withType<Test> { useJUnitPlatform() }
`,
    needsLlm: false,
  });

  files.push({
    path: "settings.gradle.kts",
    content: `rootProject.name = "${cfg.name}"\n`,
    needsLlm: false,
  });
  files.push({
    path: "gradle/wrapper/gradle-wrapper.properties",
    content: `distributionUrl=https\\://services.gradle.org/distributions/gradle-8.12-bin.zip\n`,
    needsLlm: false,
  });
  files.push({ path: "gradlew", content: `#!/bin/sh\nexec gradle "$@"\n`, needsLlm: false });

  // Application properties
  files.push({
    path: "src/main/resources/application.yml",
    content: `server:\n  port: 10080\n\nspring:\n  application:\n    name: ${cfg.name}\n\nlogging:\n  level:\n    root: INFO\n    ${cfg.pkg}: DEBUG\n  pattern:\n    console: "%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n"\n`,
    needsLlm: false,
  });

  // Main class
  files.push({
    path: `src/main/java/${pkgPath}/Application.java`,
    content: `package ${cfg.pkg};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`,
    needsLlm: false,
  });

  // Controller
  files.push({
    path: `src/main/java/${pkgPath}/controller/HealthController.java`,
    content: `package ${cfg.pkg}.controller;

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
`,
    needsLlm: false,
  });

  // Item model
  files.push({
    path: `src/main/java/${pkgPath}/model/Item.java`,
    content: `package ${cfg.pkg}.model;

import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.UUID;

public record Item(
    String id,
    @NotBlank(message = "Name is required") String name,
    String description,
    Instant createdAt
) {
    public Item(String name, String description) {
        this(UUID.randomUUID().toString(), name, description, Instant.now());
    }
}
`,
    needsLlm: false,
  });

  // Item service
  files.push({
    path: `src/main/java/${pkgPath}/service/ItemService.java`,
    content: `package ${cfg.pkg}.service;

import ${cfg.pkg}.model.Item;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class ItemService {

    private final Map<String, Item> store = new ConcurrentHashMap<>();

    public List<Item> findAll() {
        return new ArrayList<>(store.values());
    }

    public Optional<Item> findById(String id) {
        return Optional.ofNullable(store.get(id));
    }

    public Item create(String name, String description) {
        var item = new Item(name, description);
        store.put(item.id(), item);
        return item;
    }

    public Optional<Item> update(String id, String name, String description) {
        return Optional.ofNullable(store.computeIfPresent(id, (k, existing) ->
            new Item(id, name, description, existing.createdAt())));
    }

    public boolean delete(String id) {
        return store.remove(id) != null;
    }
}
`,
    needsLlm: false,
  });

  // Error response record
  files.push({
    path: `src/main/java/${pkgPath}/controller/ErrorResponse.java`,
    content: `package ${cfg.pkg}.controller;

import java.time.Instant;
import java.util.Map;

public record ErrorResponse(int status, String message, Map<String, String> errors, Instant timestamp) {
    public ErrorResponse(int status, String message) {
        this(status, message, Map.of(), Instant.now());
    }

    public ErrorResponse(int status, String message, Map<String, String> errors) {
        this(status, message, errors, Instant.now());
    }
}
`,
    needsLlm: false,
  });

  // Item controller with full CRUD, validation, error handling, logging
  files.push({
    path: `src/main/java/${pkgPath}/controller/ItemController.java`,
    content: `package ${cfg.pkg}.controller;

import ${cfg.pkg}.model.Item;
import ${cfg.pkg}.service.ItemService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/items")
public class ItemController {

    private static final Logger log = LoggerFactory.getLogger(ItemController.class);

    private final ItemService itemService;

    public ItemController(ItemService itemService) {
        this.itemService = itemService;
    }

    public record CreateItemRequest(
        @NotBlank(message = "Name is required") String name,
        String description
    ) {}

    public record UpdateItemRequest(
        @NotBlank(message = "Name is required") String name,
        String description
    ) {}

    @GetMapping
    public List<Item> list() {
        log.debug("Listing all items");
        return itemService.findAll();
    }

    @PostMapping
    public ResponseEntity<Item> create(@Valid @RequestBody CreateItemRequest request) {
        log.info("Creating item: {}", request.name());
        var item = itemService.create(request.name(), request.description());
        return ResponseEntity.status(HttpStatus.CREATED).body(item);
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable String id) {
        log.debug("Getting item: {}", id);
        return itemService.findById(id)
            .<ResponseEntity<?>>map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ErrorResponse(404, "Item not found: " + id)));
    }

    @PutMapping("/{id}")
    public ResponseEntity<?> update(@PathVariable String id, @Valid @RequestBody UpdateItemRequest request) {
        log.info("Updating item: {}", id);
        return itemService.update(id, request.name(), request.description())
            .<ResponseEntity<?>>map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ErrorResponse(404, "Item not found: " + id)));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable String id) {
        log.info("Deleting item: {}", id);
        if (itemService.delete(id)) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(new ErrorResponse(404, "Item not found: " + id));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        Map<String, String> errors = ex.getBindingResult().getFieldErrors().stream()
            .collect(Collectors.toMap(FieldError::getField, FieldError::getDefaultMessage, (a, b) -> a));
        log.warn("Validation failed: {}", errors);
        return ResponseEntity.badRequest().body(new ErrorResponse(400, "Validation failed", errors));
    }
}
`,
    needsLlm: false,
  });

  // Test
  files.push({
    path: `src/test/java/${pkgPath}/ApplicationTests.java`,
    content: `package ${cfg.pkg};

import ${cfg.pkg}.model.Item;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ApplicationTests {

    @Autowired
    TestRestTemplate restTemplate;

    static String createdItemId;

    @Test
    @Order(1)
    void contextLoads() {}

    @Test
    @Order(2)
    void healthEndpoint() {
        var response = restTemplate.getForObject("/api/health", String.class);
        assertThat(response).contains("ok");
    }

    @Test
    @Order(3)
    void listItemsEmpty() {
        var response = restTemplate.getForEntity("/api/items", Item[].class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
    }

    @Test
    @Order(4)
    void createItem() {
        var body = java.util.Map.of("name", "Test Item", "description", "A test item");
        var response = restTemplate.postForEntity("/api/items", body, Item.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().name()).isEqualTo("Test Item");
        assertThat(response.getBody().id()).isNotBlank();
        createdItemId = response.getBody().id();
    }

    @Test
    @Order(5)
    void getItemById() {
        assertThat(createdItemId).isNotBlank();
        var response = restTemplate.getForEntity("/api/items/" + createdItemId, Item.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().name()).isEqualTo("Test Item");
    }

    @Test
    @Order(6)
    void getItemNotFound() {
        var response = restTemplate.getForEntity("/api/items/nonexistent", String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(response.getBody()).contains("Item not found");
    }

    @Test
    @Order(7)
    void deleteItem() {
        var body = java.util.Map.of("name", "Delete Me", "description", "To be deleted");
        var created = restTemplate.postForObject("/api/items", body, Item.class);
        assertThat(created).isNotNull();

        restTemplate.delete("/api/items/" + created.id());

        var response = restTemplate.getForEntity("/api/items/" + created.id(), String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @Order(8)
    void createItemValidationFails() {
        var body = java.util.Map.of("name", "", "description", "No name");
        var response = restTemplate.postForEntity("/api/items", body, String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    @Order(9)
    void updateItem() {
        var createBody = java.util.Map.of("name", "Before Update", "description", "Original");
        var created = restTemplate.postForObject("/api/items", createBody, Item.class);
        assertThat(created).isNotNull();

        var updateBody = java.util.Map.of("name", "After Update", "description", "Modified");
        restTemplate.put("/api/items/" + created.id(), updateBody);

        var response = restTemplate.getForEntity("/api/items/" + created.id(), Item.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().name()).isEqualTo("After Update");
        assertThat(response.getBody().description()).isEqualTo("Modified");
    }
}
`,
    needsLlm: false,
  });

  // Extras
  files.push({
    path: ".gitignore",
    content: "build/\n.gradle/\n*.class\n*.jar\n.idea/\n*.iml\n.env\n",
    needsLlm: false,
  });
  files.push({
    path: "Dockerfile",
    content: `FROM eclipse-temurin:21-jdk AS builder\nWORKDIR /app\nCOPY . .\nRUN ./gradlew build -x test\n\nFROM eclipse-temurin:21-jre\nCOPY --from=builder /app/build/libs/*.jar /app/app.jar\nEXPOSE 10080\nCMD ["java", "-jar", "/app/app.jar"]\n`,
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with: { distribution: temurin, java-version: 21 }\n      - run: ./gradlew test\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nSpring Boot API. Built with KCode.\n\n\`\`\`bash\n./gradlew bootRun\n./gradlew test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
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
    prompt: `Implement Java ${cfg.type} (${cfg.framework}). ${m} files machine. USER: "${userRequest}"`,
  };
}
