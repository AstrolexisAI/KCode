// KCode - Docker/Compose Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface DockerService {
  name: string;
  image?: string;
  build?: string;
  ports?: string[];
  env?: Record<string, string>;
  volumes?: string[];
  depends?: string[];
  command?: string;
  healthcheck?: string;
}

interface DockerConfig {
  name: string;
  services: DockerService[];
  hasNginx: boolean;
  hasGpu: boolean;
}

function detectDockerProject(msg: string): DockerConfig {
  const lower = msg.toLowerCase();
  const services: DockerService[] = [];
  let hasNginx = false;
  let hasGpu = false;

  // Detect databases
  if (/\b(?:postgres|postgresql|pg)\b/i.test(lower)) {
    services.push({
      name: "postgres",
      image: "postgres:17-alpine",
      ports: ["5432:5432"],
      env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "changeme", POSTGRES_DB: "appdb" },
      volumes: ["pgdata:/var/lib/postgresql/data"],
      healthcheck: "pg_isready -U app",
    });
  }
  if (/\b(?:mysql|mariadb)\b/i.test(lower)) {
    const isMariadb = /\bmariadb\b/i.test(lower);
    services.push({
      name: isMariadb ? "mariadb" : "mysql",
      image: isMariadb ? "mariadb:11" : "mysql:8.4",
      ports: ["3306:3306"],
      env: {
        MYSQL_ROOT_PASSWORD: "changeme",
        MYSQL_DATABASE: "appdb",
        MYSQL_USER: "app",
        MYSQL_PASSWORD: "changeme",
      },
      volumes: ["mysqldata:/var/lib/mysql"],
      healthcheck: "mysqladmin ping -h localhost",
    });
  }
  if (/\b(?:mongo|mongodb)\b/i.test(lower)) {
    services.push({
      name: "mongo",
      image: "mongo:7",
      ports: ["27017:27017"],
      env: { MONGO_INITDB_ROOT_USERNAME: "app", MONGO_INITDB_ROOT_PASSWORD: "changeme" },
      volumes: ["mongodata:/data/db"],
    });
  }

  // Detect caches/queues
  if (/\b(?:redis)\b/i.test(lower)) {
    services.push({
      name: "redis",
      image: "redis:7-alpine",
      ports: ["6379:6379"],
      volumes: ["redisdata:/data"],
      command: "redis-server --appendonly yes",
      healthcheck: "redis-cli ping",
    });
  }
  if (/\b(?:rabbitmq|rabbit)\b/i.test(lower)) {
    services.push({
      name: "rabbitmq",
      image: "rabbitmq:3-management-alpine",
      ports: ["5672:5672", "15672:15672"],
      env: { RABBITMQ_DEFAULT_USER: "app", RABBITMQ_DEFAULT_PASS: "changeme" },
      volumes: ["rabbitdata:/var/lib/rabbitmq"],
    });
  }
  if (/\b(?:kafka)\b/i.test(lower)) {
    services.push({
      name: "kafka",
      image: "bitnami/kafka:3.8",
      ports: ["9092:9092"],
      env: {
        KAFKA_CFG_NODE_ID: "0",
        KAFKA_CFG_PROCESS_ROLES: "controller,broker",
        KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093",
        KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "0@kafka:9093",
        KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
      },
    });
  }

  // Detect app frameworks
  if (/\b(?:node|express|fastify|nest|next|javascript|typescript|bun)\b/i.test(lower)) {
    const dbDeps = services
      .filter((s) => ["postgres", "mysql", "mariadb", "mongo", "redis"].includes(s.name))
      .map((s) => s.name);
    services.push({
      name: "app",
      build: "./app",
      ports: ["10080:10080"],
      env: { NODE_ENV: "production", PORT: "10080" },
      depends: dbDeps,
    });
  }
  if (/\b(?:python|flask|django|fastapi|ml|ai)\b/i.test(lower)) {
    const dbDeps = services
      .filter((s) => ["postgres", "mysql", "mariadb", "mongo", "redis"].includes(s.name))
      .map((s) => s.name);
    if (/\b(?:gpu|cuda|ml|ai|torch|tensorflow)\b/i.test(lower)) hasGpu = true;
    services.push({
      name: "app",
      build: "./app",
      ports: ["10080:10080"],
      env: { PYTHONUNBUFFERED: "1" },
      depends: dbDeps,
    });
  }
  if (/\b(?:go|golang)\b/i.test(lower)) {
    const dbDeps = services
      .filter((s) => ["postgres", "mysql", "mariadb", "mongo", "redis"].includes(s.name))
      .map((s) => s.name);
    services.push({ name: "app", build: "./app", ports: ["10080:10080"], depends: dbDeps });
  }
  if (/\b(?:java|spring|quarkus)\b/i.test(lower)) {
    const dbDeps = services
      .filter((s) => ["postgres", "mysql", "mariadb", "mongo", "redis"].includes(s.name))
      .map((s) => s.name);
    services.push({ name: "app", build: "./app", ports: ["10080:10080"], depends: dbDeps });
  }

  // Detect reverse proxy
  if (/\b(?:nginx|reverse\s*proxy|load\s*balancer|lb)\b/i.test(lower)) {
    hasNginx = true;
    const appService = services.find((s) => s.name === "app");
    services.push({
      name: "nginx",
      image: "nginx:alpine",
      ports: ["80:80", "443:443"],
      volumes: ["./nginx/nginx.conf:/etc/nginx/nginx.conf:ro"],
      depends: appService ? ["app"] : [],
    });
  }

  // Detect monitoring
  if (/\b(?:prometheus|grafana|monitoring)\b/i.test(lower)) {
    services.push({
      name: "prometheus",
      image: "prom/prometheus:latest",
      ports: ["9090:9090"],
      volumes: ["./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro"],
    });
    services.push({
      name: "grafana",
      image: "grafana/grafana:latest",
      ports: ["3000:3000"],
      env: { GF_SECURITY_ADMIN_PASSWORD: "changeme" },
      volumes: ["grafanadata:/var/lib/grafana"],
      depends: ["prometheus"],
    });
  }

  // If no app service detected, add a generic one
  if (!services.find((s) => s.name === "app") && services.length > 0) {
    const dbDeps = services
      .filter((s) => ["postgres", "mysql", "mariadb", "mongo", "redis"].includes(s.name))
      .map((s) => s.name);
    services.push({ name: "app", build: "./app", ports: ["10080:10080"], depends: dbDeps });
  }

  // If nothing detected, create a basic Node + Postgres stack
  if (services.length === 0) {
    services.push(
      {
        name: "postgres",
        image: "postgres:17-alpine",
        ports: ["5432:5432"],
        env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "changeme", POSTGRES_DB: "appdb" },
        volumes: ["pgdata:/var/lib/postgresql/data"],
        healthcheck: "pg_isready -U app",
      },
      {
        name: "app",
        build: "./app",
        ports: ["10080:10080"],
        env: {
          NODE_ENV: "production",
          DATABASE_URL: "postgres://app:changeme@postgres:5432/appdb",
        },
        depends: ["postgres"],
      },
    );
  }

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "mystack";

  return { name, services, hasNginx, hasGpu };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}

export interface DockerProjectResult {
  config: DockerConfig;
  services: DockerService[];
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

function buildComposeYml(cfg: DockerConfig): string {
  const lines: string[] = [];

  for (const svc of cfg.services) {
    lines.push(`  ${svc.name}:`);
    if (svc.image) lines.push(`    image: ${svc.image}`);
    if (svc.build)
      lines.push(`    build:\n      context: ${svc.build}\n      dockerfile: Dockerfile`);
    if (svc.command) lines.push(`    command: ${svc.command}`);
    if (svc.ports?.length) {
      lines.push("    ports:");
      for (const p of svc.ports) lines.push(`      - "${p}"`);
    }
    if (svc.env && Object.keys(svc.env).length) {
      lines.push("    environment:");
      for (const [k, v] of Object.entries(svc.env)) lines.push(`      ${k}: "${v}"`);
    }
    if (svc.volumes?.length) {
      lines.push("    volumes:");
      for (const v of svc.volumes) lines.push(`      - ${v}`);
    }
    if (svc.depends?.length) {
      lines.push("    depends_on:");
      for (const d of svc.depends) lines.push(`      ${d}:\n        condition: service_started`);
    }
    if (svc.healthcheck) {
      lines.push(
        `    healthcheck:\n      test: ["CMD-SHELL", "${svc.healthcheck}"]\n      interval: 10s\n      timeout: 5s\n      retries: 5`,
      );
    }
    if (cfg.hasGpu && svc.name === "app") {
      lines.push(
        "    deploy:\n      resources:\n        reservations:\n          devices:\n            - driver: nvidia\n              count: all\n              capabilities: [gpu]",
      );
    }
    lines.push("    restart: unless-stopped");
    lines.push("");
  }

  const volumes = cfg.services
    .flatMap((s) => s.volumes ?? [])
    .filter((v) => !v.startsWith("./"))
    .map((v) => v.split(":")[0]!);
  const uniqueVols = [...new Set(volumes)];

  let yml = `services:\n${lines.join("\n")}`;
  if (uniqueVols.length) {
    yml += `\nvolumes:\n${uniqueVols.map((v) => `  ${v}:`).join("\n")}\n`;
  }
  return yml;
}

export function createDockerProject(userRequest: string, cwd: string): DockerProjectResult {
  const cfg = detectDockerProject(userRequest);
  const files: GenFile[] = [];

  // docker-compose.yml
  files.push({ path: "docker-compose.yml", content: buildComposeYml(cfg), needsLlm: false });

  // .env
  const envLines = ["# Docker Compose environment", `COMPOSE_PROJECT_NAME=${cfg.name}`];
  for (const svc of cfg.services) {
    if (svc.env) for (const [k, v] of Object.entries(svc.env)) envLines.push(`${k}=${v}`);
  }
  files.push({ path: ".env", content: envLines.join("\n") + "\n", needsLlm: false });
  files.push({
    path: ".env.example",
    content:
      envLines
        .map((l) => (l.includes("changeme") ? l.replace("changeme", "YOUR_SECRET_HERE") : l))
        .join("\n") + "\n",
    needsLlm: false,
  });

  // App Dockerfile if build context exists
  const appSvc = cfg.services.find((s) => s.build);
  if (appSvc) {
    const isPython = /\b(?:python|flask|django|fastapi|ml)\b/i.test(userRequest);
    const isGo = /\b(?:go|golang)\b/i.test(userRequest);
    const isJava = /\b(?:java|spring)\b/i.test(userRequest);

    if (isPython) {
      files.push({
        path: "app/Dockerfile",
        content: `FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 10080
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10080"]
`,
        needsLlm: false,
      });
      files.push({
        path: "app/requirements.txt",
        content: "fastapi\nuvicorn[standard]\npydantic\n",
        needsLlm: false,
      });
      files.push({
        path: "app/main.py",
        content: `from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="${cfg.name}")

class ItemBase(BaseModel):
    name: str
    description: str = ""

_items: dict[int, dict] = {}
_next_id = 1

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/api/items")
def list_items():
    return list(_items.values())

@app.post("/api/items", status_code=201)
def create_item(data: ItemBase):
    global _next_id
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    item = {"id": _next_id, "name": data.name, "description": data.description}
    _items[_next_id] = item
    _next_id += 1
    return item

@app.get("/api/items/{item_id}")
def get_item(item_id: int):
    if item_id not in _items:
        raise HTTPException(status_code=404, detail="Item not found")
    return _items[item_id]

@app.put("/api/items/{item_id}")
def update_item(item_id: int, data: ItemBase):
    if item_id not in _items:
        raise HTTPException(status_code=404, detail="Item not found")
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    _items[item_id] = {"id": item_id, "name": data.name, "description": data.description}
    return _items[item_id]

@app.delete("/api/items/{item_id}", status_code=204)
def delete_item(item_id: int):
    if item_id not in _items:
        raise HTTPException(status_code=404, detail="Item not found")
    del _items[item_id]
`,
        needsLlm: false,
      });
    } else if (isGo) {
      files.push({
        path: "app/Dockerfile",
        content: `FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/app

FROM alpine:3.20
COPY --from=builder /bin/app /usr/local/bin/app
EXPOSE 10080
ENTRYPOINT ["app"]
`,
        needsLlm: false,
      });
      files.push({
        path: "app/go.mod",
        content: `module ${cfg.name}\n\ngo 1.23\n`,
        needsLlm: false,
      });
      files.push({
        path: "app/main.go",
        content: `package main

import (
\t"encoding/json"
\t"log"
\t"net/http"
)

func main() {
\thttp.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
\t\tjson.NewEncoder(w).Encode(map[string]string{"status": "ok"})
\t})

\t// TODO: add routes

\tlog.Println("Listening on :10080")
\tlog.Fatal(http.ListenAndServe(":10080", nil))
}
`,
        needsLlm: true,
      });
    } else if (isJava) {
      files.push({
        path: "app/Dockerfile",
        content: `FROM eclipse-temurin:21-jdk AS builder
WORKDIR /app
COPY . .
RUN ./gradlew build -x test

FROM eclipse-temurin:21-jre
COPY --from=builder /app/build/libs/*.jar /app/app.jar
EXPOSE 10080
CMD ["java", "-jar", "/app/app.jar"]
`,
        needsLlm: false,
      });
    } else {
      // Default: Node.js
      files.push({
        path: "app/Dockerfile",
        content: `FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 10080
CMD ["node", "index.js"]
`,
        needsLlm: false,
      });
      files.push({
        path: "app/package.json",
        content: JSON.stringify(
          {
            name: cfg.name,
            version: "0.1.0",
            type: "module",
            scripts: { start: "node index.js", dev: "node --watch index.js" },
            dependencies: { express: "*" },
          },
          null,
          2,
        ),
        needsLlm: false,
      });
      files.push({
        path: "app/index.js",
        content: `import express from "express";

const app = express();
app.use(express.json());

const items = new Map();
let nextId = 1;

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/items", (req, res) => res.json([...items.values()]));

app.get("/api/items/:id", (req, res) => {
  const item = items.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found" });
  res.json(item);
});

app.post("/api/items", (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
  const item = { id: nextId++, name: name.trim(), description: description || "" };
  items.set(item.id, item);
  res.status(201).json(item);
});

app.put("/api/items/:id", (req, res) => {
  const item = items.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: "Item not found" });
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required" });
  item.name = name.trim();
  item.description = description || item.description;
  res.json(item);
});

app.delete("/api/items/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!items.has(id)) return res.status(404).json({ error: "Item not found" });
  items.delete(id);
  res.status(204).end();
});

const PORT = process.env.PORT || 10080;
app.listen(PORT, () => console.log(\`Listening on :\${PORT}\`));
`,
        needsLlm: false,
      });
    }
  }

  // Test file for app service
  if (appSvc) {
    const isPython = /\b(?:python|flask|django|fastapi|ml)\b/i.test(userRequest);
    if (isPython) {
      files.push({
        path: "app/test_main.py",
        content: `from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

def test_create_item():
    r = client.post("/api/items", json={"name": "Test", "description": "desc"})
    assert r.status_code == 201
    assert r.json()["name"] == "Test"

def test_list_items():
    r = client.get("/api/items")
    assert r.status_code == 200

def test_create_item_validation():
    r = client.post("/api/items", json={"name": "", "description": ""})
    assert r.status_code == 400
`,
        needsLlm: false,
      });
    } else if (
      !/\b(?:go|golang)\b/i.test(userRequest) &&
      !/\b(?:java|spring)\b/i.test(userRequest)
    ) {
      // Default Node.js test
      files.push({
        path: "app/index.test.js",
        content: `import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("items API", () => {
  it("should validate required fields", () => {
    assert.ok(true, "placeholder");
  });
});
`,
        needsLlm: false,
      });
    }
  }

  // Nginx config
  if (cfg.hasNginx) {
    files.push({
      path: "nginx/nginx.conf",
      content: `events { worker_connections 1024; }

http {
    upstream app {
        server app:10080;
    }

    server {
        listen 80;
        server_name _;

        location / {
            proxy_pass http://app;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /health {
            proxy_pass http://app/health;
        }
    }
}
`,
      needsLlm: false,
    });
  }

  // Prometheus config
  if (cfg.services.find((s) => s.name === "prometheus")) {
    files.push({
      path: "prometheus/prometheus.yml",
      content: `global:
  scrape_interval: 15s

scrape_configs:
  - job_name: app
    static_configs:
      - targets: ["app:10080"]
`,
      needsLlm: false,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content: ".env\nnode_modules/\n__pycache__/\n*.pyc\nbuild/\ndist/\n",
    needsLlm: false,
  });
  files.push({
    path: "Makefile",
    content: `up:\n\tdocker compose up -d\n\ndown:\n\tdocker compose down\n\nlogs:\n\tdocker compose logs -f\n\nbuild:\n\tdocker compose build\n\nrestart:\n\tdocker compose restart\n\nclean:\n\tdocker compose down -v --remove-orphans\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nDocker Compose stack. Built with KCode.\n\n## Services\n${cfg.services.map((s) => `- **${s.name}**: ${s.image ?? "custom build"}`).join("\n")}\n\n\`\`\`bash\ndocker compose up -d\ndocker compose logs -f\ndocker compose down\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
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
    services: cfg.services,
    files,
    projectPath,
    prompt: `Docker Compose stack with ${cfg.services.length} services. ${m} files machine. USER: "${userRequest}"`,
  };
}
