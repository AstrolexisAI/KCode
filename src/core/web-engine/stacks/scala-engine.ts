// KCode - Scala Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ScalaProjectType = "api" | "cli" | "library" | "spark" | "stream" | "custom";

interface ScalaConfig {
  name: string;
  type: ScalaProjectType;
  framework?: string;
  deps: string[];
  pkg: string;
}

function detectScalaProject(msg: string): ScalaConfig {
  const lower = msg.toLowerCase();
  let type: ScalaProjectType = "cli";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:spark|data\s*eng|etl|dataframe|hadoop)\b/i.test(lower)) {
    type = "spark";
    framework = "spark";
    deps.push("org.apache.spark::spark-sql:3.5.1", "org.apache.spark::spark-core:3.5.1");
  } else if (/\b(?:stream|akka.?stream|fs2|reactive)\b/i.test(lower)) {
    type = "stream";
    if (/\b(?:fs2)\b/i.test(lower)) {
      framework = "fs2";
      deps.push("co.fs2::fs2-core:3.10.2", "co.fs2::fs2-io:3.10.2");
    } else {
      framework = "akka-streams";
      deps.push(
        "com.typesafe.akka::akka-stream:2.9.3",
        "com.typesafe.akka::akka-actor-typed:2.9.3",
      );
    }
  } else if (/\b(?:api|server|rest|http|web|endpoint)\b/i.test(lower)) {
    type = "api";
    if (/\b(?:akka)\b/i.test(lower)) {
      framework = "akka";
      deps.push(
        "com.typesafe.akka::akka-http:10.6.3",
        "com.typesafe.akka::akka-actor-typed:2.9.3",
        "com.typesafe.akka::akka-stream:2.9.3",
      );
    } else if (/\b(?:play)\b/i.test(lower)) {
      framework = "play";
    } else {
      framework = "http4s";
      deps.push(
        "org.http4s::http4s-ember-server:0.23.27",
        "org.http4s::http4s-dsl:0.23.27",
        "org.http4s::http4s-circe:0.23.27",
        "io.circe::circe-core:0.14.9",
        "io.circe::circe-generic:0.14.9",
        "org.typelevel::cats-effect:3.5.4",
        "org.typelevel::log4cats-slf4j:2.7.0",
      );
    }
  } else if (/\b(?:cli|console|command|tool)\b/i.test(lower)) {
    type = "cli";
    deps.push("com.github.scopt::scopt:4.1.0");
  } else if (/\b(?:lib|library|package)\b/i.test(lower)) {
    type = "library";
  }

  if (/\b(?:circe|json)\b/i.test(lower) && !deps.some((d) => d.includes("circe")))
    deps.push(
      "io.circe::circe-core:0.14.9",
      "io.circe::circe-generic:0.14.9",
      "io.circe::circe-parser:0.14.9",
    );
  if (/\b(?:doobie|jdbc|postgres|sql|database|db)\b/i.test(lower))
    deps.push("org.tpolecat::doobie-core:1.0.0-RC5", "org.tpolecat::doobie-hikari:1.0.0-RC5");
  if (/\b(?:fs2)\b/i.test(lower) && !deps.some((d) => d.includes("fs2")))
    deps.push("co.fs2::fs2-core:3.10.2");
  if (/\b(?:cats)\b/i.test(lower) && !deps.some((d) => d.includes("cats")))
    deps.push("org.typelevel::cats-core:2.12.0");
  if (/\b(?:zio)\b/i.test(lower)) {
    framework = framework ?? "zio";
    deps.push("dev.zio::zio:2.1.6", "dev.zio::zio-streams:2.1.6");
  }
  if (/\b(?:cats.?effect)\b/i.test(lower) && !deps.some((d) => d.includes("cats-effect"))) {
    framework = framework ?? "cats-effect";
    deps.push("org.typelevel::cats-effect:3.5.4");
  }
  if (/\b(?:pureconfig|config)\b/i.test(lower))
    deps.push("com.github.pureconfig::pureconfig-core:0.17.7");
  if (/\b(?:scalatest)\b/i.test(lower)) deps.push("org.scalatest::scalatest:3.2.19");
  if (/\b(?:specs2)\b/i.test(lower)) deps.push("org.specs2::specs2-core:5.5.1");

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
export interface ScalaProjectResult {
  config: ScalaConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createScalaProject(userRequest: string, cwd: string): ScalaProjectResult {
  const cfg = detectScalaProject(userRequest);
  const files: GenFile[] = [];
  const pkgPath = cfg.pkg.replace(/\./g, "/");

  // build.sbt
  const depsStr = cfg.deps
    .map((d) => {
      const parts = d.split("::");
      const [org, rest] = [parts[0], parts[1]];
      const [artifact, ver] = rest!.split(":");
      return `    "${org}" %% "${artifact}" % "${ver}"`;
    })
    .join(",\n");

  const testDeps = cfg.deps.some((d) => d.includes("scalatest"))
    ? ""
    : ',\n    "org.scalatest" %% "scalatest" % "3.2.19" % Test';

  const logbackDep =
    cfg.framework === "http4s" ? ',\n    "ch.qos.logback" % "logback-classic" % "1.5.0"' : "";

  files.push({
    path: "build.sbt",
    content: `ThisBuild / version := "0.1.0"
ThisBuild / scalaVersion := "3.4.2"
ThisBuild / organization := "${cfg.pkg}"

lazy val root = (project in file("."))
  .settings(
    name := "${cfg.name}",
    libraryDependencies ++= Seq(
${depsStr}${logbackDep}${testDeps}
    )
  )
`,
    needsLlm: false,
  });

  files.push({
    path: "project/build.properties",
    content: `sbt.version=1.10.1\n`,
    needsLlm: false,
  });
  files.push({
    path: "project/plugins.sbt",
    content: `addSbtPlugin("org.scalameta" % "sbt-scalafmt" % "2.5.2")
addSbtPlugin("com.github.sbt" % "sbt-native-packager" % "1.10.0")
`,
    needsLlm: false,
  });

  // Main code
  if (cfg.type === "api" && cfg.framework === "http4s") {
    // Item model with circe codecs
    files.push({
      path: `src/main/scala/${pkgPath}/model/Item.scala`,
      content: `package ${cfg.pkg}.model

import io.circe.*
import io.circe.generic.semiauto.*
import java.time.Instant
import java.util.UUID

case class Item(
  id: String,
  name: String,
  description: String,
  createdAt: String
)

object Item:
  given Encoder[Item] = deriveEncoder[Item]
  given Decoder[Item] = deriveDecoder[Item]

  def create(name: String, description: String): Item =
    Item(
      id = UUID.randomUUID().toString,
      name = name,
      description = description,
      createdAt = Instant.now().toString
    )

case class CreateItemRequest(name: String, description: String = "")

object CreateItemRequest:
  given Decoder[CreateItemRequest] = deriveDecoder[CreateItemRequest]

case class ErrorResponse(status: Int, message: String)

object ErrorResponse:
  given Encoder[ErrorResponse] = deriveEncoder[ErrorResponse]
`,
      needsLlm: false,
    });

    // Item routes with full CRUD
    files.push({
      path: `src/main/scala/${pkgPath}/routes/ItemRoutes.scala`,
      content: `package ${cfg.pkg}.routes

import cats.effect.*
import cats.syntax.all.*
import ${cfg.pkg}.model.*
import io.circe.syntax.*
import org.http4s.*
import org.http4s.circe.*
import org.http4s.circe.CirceEntityDecoder.*
import org.http4s.dsl.io.*
import org.typelevel.log4cats.Logger
import org.typelevel.log4cats.slf4j.Slf4jLogger

object ItemRoutes:

  given logger: Logger[IO] = Slf4jLogger.getLoggerFromName[IO]("ItemRoutes")

  def routes(store: Ref[IO, Map[String, Item]]): HttpRoutes[IO] = HttpRoutes.of[IO]:

    case GET -> Root / "api" / "items" =>
      for
        _ <- logger.debug("Listing all items")
        items <- store.get.map(_.values.toList)
        resp <- Ok(items.asJson)
      yield resp

    case req @ POST -> Root / "api" / "items" =>
      for
        request <- req.as[CreateItemRequest]
        resp <- if request.name.isBlank then
          BadRequest(ErrorResponse(400, "Name must not be blank").asJson)
        else
          for
            _ <- logger.info(s"Creating item: \${request.name}")
            item = Item.create(request.name, request.description)
            _ <- store.update(_ + (item.id -> item))
            r <- Created(item.asJson)
          yield r
      yield resp

    case GET -> Root / "api" / "items" / id =>
      for
        _ <- logger.debug(s"Getting item: $id")
        items <- store.get
        resp <- items.get(id) match
          case Some(item) => Ok(item.asJson)
          case None => NotFound(ErrorResponse(404, s"Item not found: $id").asJson)
      yield resp

    case req @ PUT -> Root / "api" / "items" / id =>
      for
        request <- req.as[CreateItemRequest]
        items <- store.get
        resp <- items.get(id) match
          case None => NotFound(ErrorResponse(404, s"Item not found: $id").asJson)
          case Some(existing) =>
            if request.name.isBlank then
              BadRequest(ErrorResponse(400, "Name must not be blank").asJson)
            else
              for
                _ <- logger.info(s"Updating item: $id")
                updated = existing.copy(name = request.name, description = request.description)
                _ <- store.update(_ + (id -> updated))
                r <- Ok(updated.asJson)
              yield r
      yield resp

    case DELETE -> Root / "api" / "items" / id =>
      for
        _ <- logger.info(s"Deleting item: $id")
        removed <- store.modify: m =>
          if m.contains(id) then (m - id, true)
          else (m, false)
        resp <- if removed then NoContent()
          else NotFound(ErrorResponse(404, s"Item not found: $id").asJson)
      yield resp
`,
      needsLlm: false,
    });

    // Main with logging middleware
    files.push({
      path: `src/main/scala/${pkgPath}/Main.scala`,
      content: `package ${cfg.pkg}

import cats.effect.*
import ${cfg.pkg}.model.Item
import ${cfg.pkg}.routes.ItemRoutes
import io.circe.syntax.*
import org.http4s.*
import org.http4s.dsl.io.*
import org.http4s.ember.server.EmberServerBuilder
import org.http4s.server.middleware.{Logger as Http4sLogger}
import com.comcast.ip4s.*

object Main extends IOApp.Simple:

  val healthRoutes: HttpRoutes[IO] = HttpRoutes.of[IO]:
    case GET -> Root / "health" =>
      Ok(Map("status" -> "ok").asJson)

  override def run: IO[Unit] =
    for
      store <- Ref.of[IO, Map[String, Item]](Map.empty)
      allRoutes = healthRoutes <+> ItemRoutes.routes(store)
      loggedRoutes = Http4sLogger.httpApp[IO](
        logHeaders = false,
        logBody = false
      )(allRoutes.orNotFound)
      _ <- EmberServerBuilder
        .default[IO]
        .withHost(host"0.0.0.0")
        .withPort(port"10080")
        .withHttpApp(loggedRoutes)
        .build
        .useForever
    yield ()
`,
      needsLlm: false,
    });
  } else if (cfg.type === "api" && cfg.framework === "akka") {
    files.push({
      path: `src/main/scala/${pkgPath}/Main.scala`,
      content: `package ${cfg.pkg}

import akka.actor.typed.ActorSystem
import akka.actor.typed.scaladsl.Behaviors
import akka.http.scaladsl.Http
import akka.http.scaladsl.server.Directives.*

object Main:

  def main(args: Array[String]): Unit =
    given system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "${cfg.name}")
    given ec: scala.concurrent.ExecutionContext = system.executionContext

    val routes =
      pathPrefix("health"):
        get:
          complete("""{"status":"ok"}""")
      ~
      pathPrefix("api" / "items"):
        get:
          complete("""[{"id":1,"name":"Sample"}]""")

    Http().newServerAt("0.0.0.0", 10080).bind(routes)
    println(s"Server running at http://0.0.0.0:10080/")
`,
      needsLlm: true,
    });
  } else if (cfg.type === "spark") {
    files.push({
      path: `src/main/scala/${pkgPath}/Main.scala`,
      content: `package ${cfg.pkg}

import org.apache.spark.sql.SparkSession
import org.apache.spark.sql.functions.*

object Main:

  def main(args: Array[String]): Unit =
    val spark = SparkSession
      .builder()
      .appName("${cfg.name}")
      .master("local[*]")
      .getOrCreate()

    import spark.implicits.*

    // TODO: load real data
    val df = Seq(
      ("Alice", 30, "Engineering"),
      ("Bob", 25, "Marketing"),
      ("Carol", 35, "Engineering")
    ).toDF("name", "age", "department")

    df.show()
    df.groupBy("department").agg(avg("age").as("avg_age")).show()

    spark.stop()
`,
      needsLlm: true,
    });
  } else if (cfg.type === "stream") {
    files.push({
      path: `src/main/scala/${pkgPath}/Main.scala`,
      content: `package ${cfg.pkg}

${
  cfg.framework === "fs2"
    ? `import cats.effect.*
import fs2.*

object Main extends IOApp.Simple:

  val pipeline: Stream[IO, Unit] =
    Stream
      .iterate(1)(_ + 1)
      .take(100)
      .evalMap(n => IO.println(s"Processing item $n"))

  override def run: IO[Unit] =
    pipeline.compile.drain`
    : `import akka.actor.typed.ActorSystem
import akka.actor.typed.scaladsl.Behaviors
import akka.stream.scaladsl.*

object Main:

  def main(args: Array[String]): Unit =
    given system: ActorSystem[Nothing] = ActorSystem(Behaviors.empty, "${cfg.name}")

    Source(1 to 100)
      .map(n => s"Processing item $n")
      .runForeach(println)
      .onComplete(_ => system.terminate())(using system.executionContext)`
}
`,
      needsLlm: true,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: `src/main/scala/${pkgPath}/Main.scala`,
      content: `package ${cfg.pkg}

import scopt.OParser

case class Config(
  input: String = "",
  verbose: Boolean = false
)

object Main:

  val builder = OParser.builder[Config]
  val parser =
    import builder.*
    OParser.sequence(
      programName("${cfg.name}"),
      head("${cfg.name}", "0.1.0"),
      opt[String]('i', "input")
        .required()
        .action((x, c) => c.copy(input = x))
        .text("input file path"),
      opt[Unit]('v', "verbose")
        .action((_, c) => c.copy(verbose = true))
        .text("enable verbose output")
    )

  def main(args: Array[String]): Unit =
    OParser.parse(parser, args, Config()) match
      case Some(config) =>
        if config.verbose then println(s"Processing: \${config.input}")
        // TODO: implement logic
        println("Done!")
      case None =>
        System.exit(1)
`,
      needsLlm: true,
    });
  } else if (cfg.type === "library") {
    files.push({
      path: `src/main/scala/${pkgPath}/${cap(cfg.name)}.scala`,
      content: `package ${cfg.pkg}

trait ${cap(cfg.name)}[F[_]]:
  def initialize: F[Unit]
  def process(data: String): F[String]

class ${cap(cfg.name)}Impl extends ${cap(cfg.name)}[[A] =>> A]:
  private var initialized = false

  override def initialize: Unit =
    // TODO: setup
    initialized = true

  override def process(data: String): String =
    require(initialized, "Not initialized. Call initialize first.")
    // TODO: main logic
    data

object ${cap(cfg.name)}:
  def apply(): ${cap(cfg.name)}Impl = ${cap(cfg.name)}Impl()

  extension (s: String)
    def transform: String = s.trim.toLowerCase
`,
      needsLlm: true,
    });
  } else {
    files.push({
      path: `src/main/scala/${pkgPath}/Main.scala`,
      content: `package ${cfg.pkg}

@main def run(): Unit =
  println("${cfg.name} started")
  // TODO: implement
`,
      needsLlm: true,
    });
  }

  // Test — http4s API gets full CRUD tests, others get basic tests
  if (cfg.type === "api" && cfg.framework === "http4s") {
    files.push({
      path: `src/test/scala/${pkgPath}/MainSpec.scala`,
      content: `package ${cfg.pkg}

import cats.effect.*
import cats.effect.unsafe.implicits.global
import ${cfg.pkg}.model.*
import ${cfg.pkg}.routes.ItemRoutes
import io.circe.*
import io.circe.parser.*
import io.circe.syntax.*
import org.http4s.*
import org.http4s.circe.*
import org.http4s.circe.CirceEntityDecoder.*
import org.http4s.dsl.io.*
import org.http4s.implicits.*
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class MainSpec extends AnyFlatSpec with Matchers:

  def withRoutes(test: (HttpRoutes[IO], Ref[IO, Map[String, Item]]) => IO[Unit]): Unit =
    (for
      store <- Ref.of[IO, Map[String, Item]](Map.empty)
      routes = ItemRoutes.routes(store)
      _ <- test(routes, store)
    yield ()).unsafeRunSync()

  "${cfg.name}" should "return health ok" in:
    val healthRoutes = org.http4s.HttpRoutes.of[IO]:
      case GET -> Root / "health" =>
        Ok(Map("status" -> "ok").asJson)
    val req = Request[IO](Method.GET, uri"/health")
    val resp = healthRoutes.orNotFound.run(req).unsafeRunSync()
    resp.status shouldBe Status.Ok

  it should "list items (empty)" in withRoutes: (routes, _) =>
    val req = Request[IO](Method.GET, uri"/api/items")
    for
      resp <- routes.orNotFound.run(req)
      body <- resp.as[String]
    yield
      resp.status shouldBe Status.Ok
      body shouldBe "[]"

  it should "create an item" in withRoutes: (routes, _) =>
    val body = CreateItemRequest("Test Item", "A test").asJson(using
      io.circe.generic.semiauto.deriveEncoder[CreateItemRequest])
    val req = Request[IO](Method.POST, uri"/api/items").withEntity(body)
    for
      resp <- routes.orNotFound.run(req)
      item <- resp.as[Item]
    yield
      resp.status shouldBe Status.Created
      item.name shouldBe "Test Item"

  it should "reject blank name" in withRoutes: (routes, _) =>
    val body = CreateItemRequest("", "No name").asJson(using
      io.circe.generic.semiauto.deriveEncoder[CreateItemRequest])
    val req = Request[IO](Method.POST, uri"/api/items").withEntity(body)
    for
      resp <- routes.orNotFound.run(req)
    yield
      resp.status shouldBe Status.BadRequest

  it should "get item by id" in withRoutes: (routes, store) =>
    val item = Item.create("Lookup", "For retrieval")
    for
      _ <- store.update(_ + (item.id -> item))
      req = Request[IO](Method.GET, Uri.unsafeFromString(s"/api/items/\${item.id}"))
      resp <- routes.orNotFound.run(req)
      found <- resp.as[Item]
    yield
      resp.status shouldBe Status.Ok
      found.name shouldBe "Lookup"

  it should "return 404 for missing item" in withRoutes: (routes, _) =>
    val req = Request[IO](Method.GET, uri"/api/items/nonexistent")
    for
      resp <- routes.orNotFound.run(req)
    yield
      resp.status shouldBe Status.NotFound

  it should "delete an item" in withRoutes: (routes, store) =>
    val item = Item.create("Delete Me", "Bye")
    for
      _ <- store.update(_ + (item.id -> item))
      delReq = Request[IO](Method.DELETE, Uri.unsafeFromString(s"/api/items/\${item.id}"))
      delResp <- routes.orNotFound.run(delReq)
      getReq = Request[IO](Method.GET, Uri.unsafeFromString(s"/api/items/\${item.id}"))
      getResp <- routes.orNotFound.run(getReq)
    yield
      delResp.status shouldBe Status.NoContent
      getResp.status shouldBe Status.NotFound
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: `src/test/scala/${pkgPath}/MainSpec.scala`,
      content: `package ${cfg.pkg}

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class MainSpec extends AnyFlatSpec with Matchers:

  "${cfg.name}" should "run basic test" in:
    1 + 1 shouldBe 2
`,
      needsLlm: false,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content:
      "target/\nproject/target/\nproject/project/\n.bsp/\n.idea/\n*.class\n.env\nmetals.sbt\n.bloop/\n.metals/\n",
    needsLlm: false,
  });
  files.push({
    path: ".scalafmt.conf",
    content: `version = "3.8.1"
runner.dialect = scala3
maxColumn = 100
indent.main = 2
indent.callSite = 2
rewrite.rules = [SortImports, RedundantBraces, RedundantParens]
`,
    needsLlm: false,
  });
  files.push({
    path: "Dockerfile",
    content: `FROM sbtscala/scala-sbt:eclipse-temurin-jammy-21.0.2_13_1.10.1_3.4.2 AS builder
WORKDIR /app
COPY . .
RUN sbt assembly

FROM eclipse-temurin:21-jre
COPY --from=builder /app/target/scala-3.4.2/*.jar /app/app.jar
EXPOSE 10080
CMD ["java", "-jar", "/app/app.jar"]
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
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 21 }
      - uses: sbt/setup-sbt@v1
      - run: sbt test
`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nScala 3 ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\nsbt run\nsbt test\n\`\`\`\n\n*Astrolexis.space --- Kulvex Code*\n`,
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
    prompt: `Implement Scala 3 ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
