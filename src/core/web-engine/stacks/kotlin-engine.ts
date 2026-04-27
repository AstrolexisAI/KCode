// KCode - Kotlin Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type KotlinProjectType =
  | "api"
  | "android"
  | "cli"
  | "library"
  | "multiplatform"
  | "desktop"
  | "custom";

interface KotlinConfig {
  name: string;
  type: KotlinProjectType;
  framework?: string;
  deps: string[];
  pkg: string;
}

function detectKotlinProject(msg: string): KotlinConfig {
  const lower = msg.toLowerCase();
  let type: KotlinProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:api|server|rest|ktor|spring)\b/i.test(lower)) {
    type = "api";
    if (/\b(?:spring)\b/i.test(lower)) {
      framework = "spring";
    } else {
      framework = "ktor";
      deps.push(
        "io.ktor:ktor-server-core",
        "io.ktor:ktor-server-netty",
        "io.ktor:ktor-server-content-negotiation",
        "io.ktor:ktor-serialization-kotlinx-json",
      );
    }
  } else if (/\b(?:android|mobile|compose|jetpack)\b/i.test(lower)) {
    type = "android";
    framework = "compose";
  } else if (/\b(?:desktop|swing|compose.?desktop)\b/i.test(lower)) {
    type = "desktop";
    framework = "compose-desktop";
  } else if (/\b(?:cli|console|command|tool)\b/i.test(lower)) {
    type = "cli";
    deps.push("com.github.ajalt.clikt:clikt");
  } else if (/\b(?:lib|library|package)\b/i.test(lower)) {
    type = "library";
  } else if (/\b(?:multiplatform|kmp|cross.?platform)\b/i.test(lower)) {
    type = "multiplatform";
  }

  if (/\b(?:exposed|database|db|postgres|sql)\b/i.test(lower))
    deps.push("org.jetbrains.exposed:exposed-core", "org.jetbrains.exposed:exposed-jdbc");
  if (/\b(?:koin|inject|di)\b/i.test(lower)) deps.push("io.insert-koin:koin-core");
  if (/\b(?:coroutine|async)\b/i.test(lower))
    deps.push("org.jetbrains.kotlinx:kotlinx-coroutines-core");
  if (/\b(?:serialization|json)\b/i.test(lower) && !deps.some((d) => d.includes("serialization")))
    deps.push("org.jetbrains.kotlinx:kotlinx-serialization-json");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");
  const pkg = `com.${name.replace(/-/g, "").toLowerCase()}`;

  return { name, type, framework, deps: [...new Set(deps)], pkg };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface KotlinProjectResult {
  config: KotlinConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createKotlinProject(userRequest: string, cwd: string): KotlinProjectResult {
  const cfg = detectKotlinProject(userRequest);
  const files: GenFile[] = [];
  const pkgPath = cfg.pkg.replace(/\./g, "/");

  // build.gradle.kts
  if (cfg.type === "api" && cfg.framework === "ktor") {
    files.push({
      path: "build.gradle.kts",
      content: `plugins {
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
    implementation("io.ktor:ktor-server-status-pages:3.0.0")
    implementation("ch.qos.logback:logback-classic:1.5.0")
${cfg.deps
  .filter((d) => !d.startsWith("io.ktor"))
  .map((d) => `    implementation("${d}")`)
  .join("\n")}
    testImplementation("io.ktor:ktor-server-test-host:3.0.0")
    testImplementation("io.ktor:ktor-client-content-negotiation:3.0.0")
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: "build.gradle.kts",
      content: `plugins {
    kotlin("jvm") version "2.1.0"
${cfg.type === "cli" || cfg.type === "api" ? "    application" : ""}
}

group = "${cfg.pkg}"
version = "0.1.0"

${cfg.type === "cli" || cfg.type === "api" ? `application { mainClass.set("${cfg.pkg}.MainKt") }` : ""}

repositories { mavenCentral() }

dependencies {
${cfg.deps.map((d) => `    implementation("${d}")`).join("\n")}
    testImplementation("org.jetbrains.kotlin:kotlin-test")
}
`,
      needsLlm: false,
    });
  }

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

  // Main code
  if (cfg.type === "api" && cfg.framework === "ktor") {
    // Item model
    files.push({
      path: `src/main/kotlin/${pkgPath}/model/Item.kt`,
      content: `package ${cfg.pkg}.model

import kotlinx.serialization.Serializable

@Serializable
data class Item(
    val id: String,
    val name: String,
    val description: String = "",
    val createdAt: String = ""
)

@Serializable
data class CreateItemRequest(
    val name: String,
    val description: String = ""
)

@Serializable
data class ErrorResponse(
    val status: Int,
    val message: String
)
`,
      needsLlm: false,
    });

    // Item repository
    files.push({
      path: `src/main/kotlin/${pkgPath}/repository/ItemRepository.kt`,
      content: `package ${cfg.pkg}.repository

import ${cfg.pkg}.model.Item
import ${cfg.pkg}.model.CreateItemRequest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class ItemRepository {
    private val store = ConcurrentHashMap<String, Item>()

    fun findAll(): List<Item> = store.values.toList()

    fun findById(id: String): Item? = store[id]

    fun create(request: CreateItemRequest): Item {
        val item = Item(
            id = UUID.randomUUID().toString(),
            name = request.name,
            description = request.description,
            createdAt = Instant.now().toString()
        )
        store[item.id] = item
        return item
    }

    fun update(id: String, name: String, description: String): Item? {
        val existing = store[id] ?: return null
        val updated = existing.copy(name = name, description = description)
        store[id] = updated
        return updated
    }

    fun delete(id: String): Boolean = store.remove(id) != null
}
`,
      needsLlm: false,
    });

    // Routes
    files.push({
      path: `src/main/kotlin/${pkgPath}/routes/ItemRoutes.kt`,
      content: `package ${cfg.pkg}.routes

import ${cfg.pkg}.model.CreateItemRequest
import ${cfg.pkg}.model.ErrorResponse
import ${cfg.pkg}.repository.ItemRepository
import io.ktor.http.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory

fun Route.itemRoutes(repository: ItemRepository) {
    val logger = LoggerFactory.getLogger("ItemRoutes")

    route("/api/items") {
        get {
            logger.debug("Listing all items")
            call.respond(repository.findAll())
        }

        post {
            val request = call.receive<CreateItemRequest>()
            if (request.name.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(400, "Name must not be blank"))
                return@post
            }
            logger.info("Creating item: {}", request.name)
            val item = repository.create(request)
            call.respond(HttpStatusCode.Created, item)
        }

        get("/{id}") {
            val id = call.parameters["id"] ?: return@get call.respond(
                HttpStatusCode.BadRequest, ErrorResponse(400, "Missing id parameter")
            )
            logger.debug("Getting item: {}", id)
            val item = repository.findById(id)
            if (item != null) {
                call.respond(item)
            } else {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(404, "Item not found: $id"))
            }
        }

        put("/{id}") {
            val id = call.parameters["id"] ?: return@put call.respond(
                HttpStatusCode.BadRequest, ErrorResponse(400, "Missing id parameter")
            )
            val request = call.receive<CreateItemRequest>()
            if (request.name.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(400, "Name must not be blank"))
                return@put
            }
            logger.info("Updating item: {}", id)
            val item = repository.update(id, request.name, request.description)
            if (item != null) {
                call.respond(item)
            } else {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(404, "Item not found: $id"))
            }
        }

        delete("/{id}") {
            val id = call.parameters["id"] ?: return@delete call.respond(
                HttpStatusCode.BadRequest, ErrorResponse(400, "Missing id parameter")
            )
            logger.info("Deleting item: {}", id)
            if (repository.delete(id)) {
                call.respond(HttpStatusCode.NoContent)
            } else {
                call.respond(HttpStatusCode.NotFound, ErrorResponse(404, "Item not found: $id"))
            }
        }
    }
}
`,
      needsLlm: false,
    });

    // Main with StatusPages, logging, organized routes
    files.push({
      path: `src/main/kotlin/${pkgPath}/Main.kt`,
      content: `package ${cfg.pkg}

import ${cfg.pkg}.repository.ItemRepository
import ${cfg.pkg}.routes.itemRoutes
import ${cfg.pkg}.model.ErrorResponse
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.slf4j.LoggerFactory

fun main() {
    val logger = LoggerFactory.getLogger("Application")
    logger.info("Starting server on port 10080")

    embeddedServer(Netty, port = 10080) {
        install(ContentNegotiation) { json() }
        install(StatusPages) {
            exception<ContentTransformationException> { call, cause ->
                logger.warn("Bad request: {}", cause.message)
                call.respond(HttpStatusCode.BadRequest, ErrorResponse(400, cause.message ?: "Invalid request body"))
            }
            exception<Throwable> { call, cause ->
                logger.error("Unhandled error", cause)
                call.respond(HttpStatusCode.InternalServerError, ErrorResponse(500, "Internal server error"))
            }
        }

        val itemRepository = ItemRepository()

        routing {
            get("/health") { call.respond(mapOf("status" to "ok")) }
            itemRoutes(itemRepository)
        }
    }.start(wait = true)
}
`,
      needsLlm: false,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: `src/main/kotlin/${pkgPath}/Main.kt`,
      content: `package ${cfg.pkg}

fun main(args: Array<String>) {
    if (args.isEmpty()) {
        println("Usage: ${cfg.name} <command>")
        return
    }

    // TODO: implement CLI logic
    println("${cfg.name} v0.1.0")
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "library") {
    files.push({
      path: `src/main/kotlin/${pkgPath}/${cap(cfg.name)}.kt`,
      content: `package ${cfg.pkg}

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
`,
      needsLlm: true,
    });
  } else {
    files.push({
      path: `src/main/kotlin/${pkgPath}/Main.kt`,
      content: `package ${cfg.pkg}

fun main() {
    println("${cfg.name} started")
    // TODO: implement
}
`,
      needsLlm: true,
    });
  }

  // Test — Ktor API gets full CRUD tests, others get basic tests
  if (cfg.type === "api" && cfg.framework === "ktor") {
    files.push({
      path: `src/test/kotlin/${pkgPath}/${cap(cfg.name)}Test.kt`,
      content: `package ${cfg.pkg}

import ${cfg.pkg}.model.CreateItemRequest
import ${cfg.pkg}.model.ErrorResponse
import ${cfg.pkg}.model.Item
import ${cfg.pkg}.repository.ItemRepository
import ${cfg.pkg}.routes.itemRoutes
import io.ktor.client.call.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.testing.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ${cap(cfg.name)}Test {

    private fun ApplicationTestBuilder.configureTestApp(): ItemRepository {
        val repository = ItemRepository()
        install(ContentNegotiation) { json() }
        install(StatusPages) {
            exception<Throwable> { call, _ ->
                call.respond(HttpStatusCode.InternalServerError, mapOf("error" to "Internal error"))
            }
        }
        routing {
            get("/health") { call.respond(mapOf("status" to "ok")) }
            itemRoutes(repository)
        }
        return repository
    }

    @Test
    fun healthEndpoint() = testApplication {
        configureTestApp()
        val response = client.get("/health")
        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(response.bodyAsText().contains("ok"))
    }

    @Test
    fun listItemsEmpty() = testApplication {
        configureTestApp()
        val response = client.get("/api/items")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("[]", response.bodyAsText())
    }

    @Test
    fun createItem() = testApplication {
        configureTestApp()
        val response = createJsonClient().post("/api/items") {
            contentType(ContentType.Application.Json)
            setBody("{\\"name\\":\\"Test Item\\",\\"description\\":\\"A test\\"}")
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val body = response.bodyAsText()
        assertTrue(body.contains("Test Item"))
    }

    @Test
    fun createItemBlankNameFails() = testApplication {
        configureTestApp()
        val response = createJsonClient().post("/api/items") {
            contentType(ContentType.Application.Json)
            setBody("{\\"name\\":\\"\\",\\"description\\":\\"No name\\"}")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun getItemById() = testApplication {
        configureTestApp()
        val client = createJsonClient()
        val createResponse = client.post("/api/items") {
            contentType(ContentType.Application.Json)
            setBody("{\\"name\\":\\"Lookup\\",\\"description\\":\\"For retrieval\\"}")
        }
        assertEquals(HttpStatusCode.Created, createResponse.status)
        val created = createResponse.bodyAsText()
        val idMatch = Regex("\\"id\\":\\"([^\\"]*)\\"").find(created)
        assertNotNull(idMatch)
        val id = idMatch.groupValues[1]

        val getResponse = client.get("/api/items/$id")
        assertEquals(HttpStatusCode.OK, getResponse.status)
        assertTrue(getResponse.bodyAsText().contains("Lookup"))
    }

    @Test
    fun getItemNotFound() = testApplication {
        configureTestApp()
        val response = client.get("/api/items/nonexistent")
        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    @Test
    fun deleteItem() = testApplication {
        configureTestApp()
        val client = createJsonClient()
        val createResponse = client.post("/api/items") {
            contentType(ContentType.Application.Json)
            setBody("{\\"name\\":\\"Delete Me\\",\\"description\\":\\"Bye\\"}")
        }
        val created = createResponse.bodyAsText()
        val idMatch = Regex("\\"id\\":\\"([^\\"]*)\\"").find(created)
        assertNotNull(idMatch)
        val id = idMatch.groupValues[1]

        val deleteResponse = client.delete("/api/items/$id")
        assertEquals(HttpStatusCode.NoContent, deleteResponse.status)

        val getResponse = client.get("/api/items/$id")
        assertEquals(HttpStatusCode.NotFound, getResponse.status)
    }

    private fun ApplicationTestBuilder.createJsonClient() = createClient {
        install(io.ktor.client.plugins.contentnegotiation.ContentNegotiation) { json() }
    }
}
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: `src/test/kotlin/${pkgPath}/${cap(cfg.name)}Test.kt`,
      content: `package ${cfg.pkg}

import kotlin.test.Test
import kotlin.test.assertTrue

class ${cap(cfg.name)}Test {
    @Test
    fun basic() {
        assertTrue(true)
    }
}
`,
      needsLlm: false,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content: "build/\n.gradle/\n.idea/\n*.iml\n.env\n",
    needsLlm: false,
  });
  files.push({
    path: "Dockerfile",
    content: `FROM gradle:8-jdk21 AS builder\nWORKDIR /app\nCOPY . .\nRUN gradle build -x test\n\nFROM eclipse-temurin:21-jre\nCOPY --from=builder /app/build/libs/*.jar /app/app.jar\nEXPOSE 10080\nCMD ["java", "-jar", "/app/app.jar"]\n`,
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with: { distribution: temurin, java-version: 21 }\n      - run: ./gradlew test\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nKotlin ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\n./gradlew run\n./gradlew test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
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
    prompt: `Implement Kotlin ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
