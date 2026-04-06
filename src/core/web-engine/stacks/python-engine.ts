// KCode - Python Project Engine
//
// Machine generates complete Python projects from description:
// pyproject.toml, src structure, tests, CI, Docker, virtual env
//
// "create a Python CLI for data processing"
// → Machine: pyproject.toml + src/ + tests/ + Dockerfile + CI
// → LLM: only business logic

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PyProjectType =
  | "cli"          // Command-line tool (click/typer/argparse)
  | "api"          // Web API (FastAPI/Flask/Django)
  | "library"      // Reusable library (pip install)
  | "scraper"      // Web scraper (requests/beautifulsoup/scrapy)
  | "bot"          // Discord/Telegram/Slack bot
  | "ml"           // Machine learning / AI
  | "data"         // Data processing / ETL / pipeline
  | "automation"   // Task automation / scripting
  | "gui"          // Desktop GUI (tkinter/PyQt/Kivy)
  | "blockchain"   // Blockchain / crypto
  | "iot"          // IoT / Raspberry Pi / hardware
  | "game"         // Game (pygame)
  | "custom";

export interface PyProjectConfig {
  name: string;
  type: PyProjectType;
  pythonVersion: string;
  dependencies: string[];
  devDependencies: string[];
  features: string[];
  framework?: string;
  hasDocker: boolean;
  hasCI: boolean;
  hasTesting: boolean;
}

// ── Detection ──────────────────────────────────────────────────

function detectPyProject(message: string): PyProjectConfig {
  const lower = message.toLowerCase();
  let type: PyProjectType = "cli";
  let framework: string | undefined;
  const dependencies: string[] = [];
  const devDependencies: string[] = ["pytest", "pytest-cov", "ruff", "mypy"];
  const features: string[] = [];

  // Type detection (order matters — more specific first)
  if (/\b(?:fastapi|django|flask|api|rest|endpoint|backend|servidor|server)\b/i.test(lower)) {
    type = "api";
    if (/\bdjango\b/i.test(lower)) { framework = "django"; dependencies.push("django", "djangorestframework"); }
    else if (/\bflask\b/i.test(lower)) { framework = "flask"; dependencies.push("flask", "flask-cors"); }
    else { framework = "fastapi"; dependencies.push("fastapi", "uvicorn[standard]", "pydantic"); }
  }
  else if (/\b(?:scrap|crawl|spider|araña|scraper)\b/i.test(lower)) {
    type = "scraper";
    if (/\bscrapy\b/i.test(lower)) { dependencies.push("scrapy"); }
    else { dependencies.push("requests", "beautifulsoup4", "lxml", "httpx"); }
  }
  else if (/\b(?:bot|discord|telegram|slack)\b/i.test(lower)) {
    type = "bot";
    if (/\bdiscord\b/i.test(lower)) dependencies.push("discord.py");
    else if (/\btelegram\b/i.test(lower)) dependencies.push("python-telegram-bot");
    else if (/\bslack\b/i.test(lower)) dependencies.push("slack-bolt");
    else dependencies.push("python-telegram-bot");
  }
  else if (/\b(?:ml|machine\s*learn|ai|model|train|neural|deep\s*learn|torch|tensorflow|llm)\b/i.test(lower)) {
    type = "ml";
    if (/\btorch|pytorch\b/i.test(lower)) dependencies.push("torch", "torchvision");
    else if (/\btensorflow|keras\b/i.test(lower)) dependencies.push("tensorflow");
    else if (/\bllm|langchain|openai\b/i.test(lower)) dependencies.push("langchain", "openai");
    else dependencies.push("scikit-learn", "pandas", "numpy");
    dependencies.push("matplotlib", "jupyter");
  }
  else if (/\b(?:data|etl|pipeline|pandas|csv|parquet|process|transform)\b/i.test(lower)) {
    type = "data";
    dependencies.push("pandas", "numpy", "polars");
    if (/\bsql|postgres|database\b/i.test(lower)) dependencies.push("sqlalchemy", "psycopg2-binary");
    if (/\bparquet|arrow\b/i.test(lower)) dependencies.push("pyarrow");
  }
  else if (/\b(?:automat|script|cron|schedule|task)\b/i.test(lower)) {
    type = "automation";
    dependencies.push("schedule", "python-dotenv");
    if (/\bselenium|browser\b/i.test(lower)) dependencies.push("selenium");
    if (/\bemail|smtp|correo\b/i.test(lower)) dependencies.push("aiosmtplib");
  }
  else if (/\b(?:gui|desktop|ventana|window|tkinter|qt|kivy)\b/i.test(lower)) {
    type = "gui";
    if (/\bqt|pyqt\b/i.test(lower)) dependencies.push("PyQt6");
    else if (/\bkivy\b/i.test(lower)) dependencies.push("kivy");
    else features.push("tkinter"); // built-in
  }
  else if (/\b(?:blockchain|crypto|web3|ethereum|solana|bitcoin)\b/i.test(lower)) {
    type = "blockchain";
    dependencies.push("web3", "eth-account", "python-dotenv");
  }
  else if (/\b(?:iot|raspberry|gpio|sensor|hardware|mqtt)\b/i.test(lower)) {
    type = "iot";
    dependencies.push("paho-mqtt", "RPi.GPIO");
  }
  else if (/\b(?:game|pygame|juego)\b/i.test(lower)) {
    type = "game";
    dependencies.push("pygame");
  }
  else if (/\b(?:lib|library|package|biblioteca|pip\s*install)\b/i.test(lower)) {
    type = "library";
  }
  else {
    type = "cli";
    dependencies.push("typer", "rich");
  }

  // Additional dependency detection
  if (/\b(?:async|asyncio|aiohttp)\b/i.test(lower) && !dependencies.includes("aiohttp")) dependencies.push("aiohttp");
  if (/\b(?:redis)\b/i.test(lower)) dependencies.push("redis");
  if (/\b(?:mongo|mongodb)\b/i.test(lower)) dependencies.push("pymongo", "motor");
  if (/\b(?:postgres|postgresql)\b/i.test(lower) && !dependencies.includes("psycopg2-binary")) dependencies.push("psycopg2-binary", "sqlalchemy");
  if (/\b(?:sqlite)\b/i.test(lower)) dependencies.push("aiosqlite");
  if (/\b(?:jwt|auth|token)\b/i.test(lower)) dependencies.push("PyJWT", "python-dotenv");
  if (/\b(?:yaml|config)\b/i.test(lower)) dependencies.push("pyyaml");
  if (/\b(?:csv|excel|xlsx)\b/i.test(lower) && !dependencies.includes("pandas")) dependencies.push("pandas", "openpyxl");
  if (/\b(?:image|pillow|foto|photo)\b/i.test(lower)) dependencies.push("Pillow");
  if (/\b(?:pdf)\b/i.test(lower)) dependencies.push("reportlab", "PyPDF2");
  if (/\b(?:email|smtp)\b/i.test(lower) && !dependencies.includes("aiosmtplib")) dependencies.push("aiosmtplib");
  if (/\b(?:docker|container)\b/i.test(lower)) features.push("docker");
  if (/\b(?:log|logging)\b/i.test(lower)) features.push("logging");
  if (/\b(?:click)\b/i.test(lower)) { dependencies.push("click"); dependencies.splice(dependencies.indexOf("typer"), 1); }

  const nameMatch = message.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1]?.replace(/-/g, "_") ?? (type === "library" ? "mylib" : "myapp");

  return {
    name,
    type,
    pythonVersion: "3.12",
    dependencies: [...new Set(dependencies)],
    devDependencies,
    features,
    framework,
    hasDocker: type !== "gui" && type !== "game",
    hasCI: true,
    hasTesting: true,
  };
}

// ── Generators ─────────────────────────────────────────────────

interface GenFile { path: string; content: string; needsLlm: boolean; }

function generatePyProject(cfg: PyProjectConfig): GenFile {
  const allDeps = [...cfg.dependencies, ...cfg.devDependencies];
  return {
    path: "pyproject.toml",
    content: `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "${cfg.name}"
version = "0.1.0"
description = "Generated by KCode"
requires-python = ">=${cfg.pythonVersion}"
dependencies = [
${cfg.dependencies.map(d => `    "${d}",`).join("\n")}
]

[project.optional-dependencies]
dev = [
${cfg.devDependencies.map(d => `    "${d}",`).join("\n")}
]
${cfg.type === "cli" ? `
[project.scripts]
${cfg.name} = "${cfg.name}.cli:app"
` : ""}
[tool.ruff]
line-length = 100
target-version = "py${cfg.pythonVersion.replace(".", "")}"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP", "B", "SIM", "S"]
ignore = ["S101"]  # allow assert in tests

[tool.mypy]
python_version = "${cfg.pythonVersion}"
strict = true
warn_return_any = true

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-v --tb=short"
`,
    needsLlm: false,
  };
}

function generateInit(cfg: PyProjectConfig): GenFile {
  return {
    path: `${cfg.name}/__init__.py`,
    content: `"""${cfg.name} — Generated by KCode."""

__version__ = "0.1.0"
`,
    needsLlm: false,
  };
}

function generateMain(cfg: PyProjectConfig): GenFile {
  const templates: Record<string, string> = {
    cli: `"""${cfg.name} CLI."""

import typer
from rich.console import Console

app = typer.Typer(help="${cfg.name} — CLI tool")
console = Console()


@app.command()
def run(
    input_file: str = typer.Argument(..., help="Input file path"),
    output: str = typer.Option("output.txt", "--output", "-o", help="Output file"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
) -> None:
    """Run the main command."""
    if verbose:
        console.print(f"[bold]Processing:[/bold] {input_file}")

    # TODO: implement main logic
    console.print("[green]Done![/green]")


@app.command()
def version() -> None:
    """Show version."""
    from . import __version__
    console.print(f"${cfg.name} v{__version__}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
`,
    api: cfg.framework === "fastapi" ? `"""${cfg.name} API."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime

app = FastAPI(title="${cfg.name}", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: str
    timestamp: datetime


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", timestamp=datetime.now())


# TODO: add your routes here
# Example:
# class Item(BaseModel):
#     name: str
#     price: float
#
# @app.post("/items")
# async def create_item(item: Item):
#     return item


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
` : `"""${cfg.name} API."""
# TODO: implement with ${cfg.framework}
`,
    scraper: `"""${cfg.name} Web Scraper."""

import httpx
from bs4 import BeautifulSoup
from dataclasses import dataclass, field
from typing import Optional
import json
import time


@dataclass
class ScrapedItem:
    title: str
    url: str
    content: str = ""
    metadata: dict = field(default_factory=dict)


class Scraper:
    def __init__(self, base_url: str, delay: float = 1.0) -> None:
        self.base_url = base_url
        self.delay = delay
        self.client = httpx.Client(
            headers={"User-Agent": "${cfg.name}/0.1.0"},
            follow_redirects=True,
            timeout=30.0,
        )
        self.results: list[ScrapedItem] = []

    def fetch(self, url: str) -> BeautifulSoup:
        time.sleep(self.delay)  # rate limiting
        response = self.client.get(url)
        response.raise_for_status()
        return BeautifulSoup(response.text, "lxml")

    def scrape(self) -> list[ScrapedItem]:
        # TODO: implement scraping logic
        soup = self.fetch(self.base_url)
        # Example: extract all links
        for link in soup.find_all("a", href=True):
            self.results.append(ScrapedItem(
                title=link.get_text(strip=True),
                url=link["href"],
            ))
        return self.results

    def save(self, path: str = "results.json") -> None:
        with open(path, "w") as f:
            json.dump([vars(r) for r in self.results], f, indent=2, default=str)


def main() -> None:
    scraper = Scraper("https://example.com")
    results = scraper.scrape()
    print(f"Scraped {len(results)} items")
    scraper.save()


if __name__ == "__main__":
    main()
`,
    ml: `"""${cfg.name} — Machine Learning."""

import numpy as np
import pandas as pd
from pathlib import Path
from dataclasses import dataclass
from typing import Any


@dataclass
class ModelConfig:
    name: str = "${cfg.name}"
    epochs: int = 10
    batch_size: int = 32
    learning_rate: float = 0.001
    data_path: str = "data/"
    model_path: str = "models/"


class Pipeline:
    def __init__(self, config: ModelConfig | None = None) -> None:
        self.config = config or ModelConfig()
        Path(self.config.data_path).mkdir(exist_ok=True)
        Path(self.config.model_path).mkdir(exist_ok=True)

    def load_data(self, path: str) -> pd.DataFrame:
        """Load and validate data."""
        df = pd.read_csv(path)
        print(f"Loaded {len(df)} rows, {len(df.columns)} columns")
        return df

    def preprocess(self, df: pd.DataFrame) -> tuple[Any, Any]:
        """Preprocess data — split features/target."""
        # TODO: implement preprocessing
        X = df.iloc[:, :-1].values
        y = df.iloc[:, -1].values
        return X, y

    def train(self, X: Any, y: Any) -> Any:
        """Train model."""
        # TODO: implement training
        print(f"Training with {len(X)} samples...")
        print(f"Config: epochs={self.config.epochs}, lr={self.config.learning_rate}")
        return None  # return trained model

    def evaluate(self, model: Any, X: Any, y: Any) -> dict[str, float]:
        """Evaluate model."""
        # TODO: implement evaluation
        return {"accuracy": 0.0, "loss": 0.0}

    def run(self, data_path: str) -> None:
        """Full pipeline: load → preprocess → train → evaluate."""
        df = self.load_data(data_path)
        X, y = self.preprocess(df)
        model = self.train(X, y)
        metrics = self.evaluate(model, X, y)
        print(f"Results: {metrics}")


def main() -> None:
    pipeline = Pipeline()
    pipeline.run("data/train.csv")


if __name__ == "__main__":
    main()
`,
    data: `"""${cfg.name} — Data Processing Pipeline."""

import pandas as pd
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from typing import Any
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class PipelineConfig:
    input_path: str = "data/input/"
    output_path: str = "data/output/"
    batch_size: int = 10000


class DataPipeline:
    def __init__(self, config: PipelineConfig | None = None) -> None:
        self.config = config or PipelineConfig()
        Path(self.config.input_path).mkdir(parents=True, exist_ok=True)
        Path(self.config.output_path).mkdir(parents=True, exist_ok=True)

    def extract(self, source: str) -> pd.DataFrame:
        """Extract data from source."""
        logger.info(f"Extracting from {source}")
        # TODO: implement extraction (CSV, DB, API, etc.)
        return pd.read_csv(source) if source.endswith(".csv") else pd.DataFrame()

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """Transform data — clean, validate, enrich."""
        logger.info(f"Transforming {len(df)} rows")
        # TODO: implement transformations
        df = df.dropna()
        df = df.drop_duplicates()
        return df

    def load(self, df: pd.DataFrame, destination: str) -> None:
        """Load processed data to destination."""
        logger.info(f"Loading {len(df)} rows to {destination}")
        df.to_csv(destination, index=False)
        # TODO: load to DB, cloud, etc.

    def run(self, source: str, destination: str) -> None:
        """Run full ETL pipeline."""
        df = self.extract(source)
        df = self.transform(df)
        self.load(df, destination)
        logger.info("Pipeline complete")


def main() -> None:
    pipeline = DataPipeline()
    pipeline.run("data/input/raw.csv", "data/output/processed.csv")


if __name__ == "__main__":
    main()
`,
    bot: `"""${cfg.name} — Bot."""

# TODO: implement bot logic
# See docs for your platform:
# Discord: https://discordpy.readthedocs.io/
# Telegram: https://python-telegram-bot.readthedocs.io/
# Slack: https://slack.dev/bolt-python/

import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> None:
    logger.info("Starting ${cfg.name} bot...")
    # TODO: implement bot


if __name__ == "__main__":
    main()
`,
    automation: `"""${cfg.name} — Task Automation."""

import schedule
import time
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def task() -> None:
    """Main scheduled task."""
    logger.info("Running task...")
    # TODO: implement task logic


def main() -> None:
    logger.info("Starting ${cfg.name} scheduler")
    schedule.every(10).minutes.do(task)
    # schedule.every().day.at("09:00").do(task)

    task()  # run once immediately
    while True:
        schedule.run_pending()
        time.sleep(1)


if __name__ == "__main__":
    main()
`,
    library: `"""${cfg.name} — Library."""

from typing import Any


class ${capitalize(cfg.name)}:
    """Main class for ${cfg.name}."""

    def __init__(self) -> None:
        self._initialized = False

    def init(self) -> None:
        """Initialize the library."""
        # TODO: setup logic
        self._initialized = True

    def process(self, data: Any) -> Any:
        """Process data."""
        if not self._initialized:
            raise RuntimeError("Not initialized. Call init() first.")
        # TODO: main processing logic
        return data
`,
  };

  return {
    path: cfg.type === "cli" ? `${cfg.name}/cli.py` : `${cfg.name}/main.py`,
    content: templates[cfg.type] ?? templates["cli"]!,
    needsLlm: true,
  };
}

function generateTests(cfg: PyProjectConfig): GenFile[] {
  return [
    {
      path: "tests/__init__.py",
      content: "",
      needsLlm: false,
    },
    {
      path: "tests/conftest.py",
      content: `"""Test fixtures."""

import pytest
${cfg.type === "api" && cfg.framework === "fastapi" ? `
from fastapi.testclient import TestClient
from ${cfg.name}.main import app


@pytest.fixture
def client():
    return TestClient(app)
` : `
@pytest.fixture
def sample_data():
    """Provide sample test data."""
    return {}
`}`,
      needsLlm: false,
    },
    {
      path: `tests/test_${cfg.name}.py`,
      content: cfg.type === "api" && cfg.framework === "fastapi" ? `"""API tests."""


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_not_found(client):
    response = client.get("/nonexistent")
    assert response.status_code == 404


# TODO: add domain-specific tests
` : `"""Tests for ${cfg.name}."""

import pytest
from ${cfg.name} import __version__


def test_version():
    assert __version__ == "0.1.0"


# TODO: add domain-specific tests
class Test${capitalize(cfg.name)}:
    def test_basic(self):
        assert True

    def test_edge_case(self):
        # TODO: test edge cases
        pass

    def test_error_handling(self):
        # TODO: test error paths
        pass
`,
      needsLlm: true,
    },
  ];
}

function generateExtras(cfg: PyProjectConfig): GenFile[] {
  const files: GenFile[] = [];

  // .gitignore
  files.push({
    path: ".gitignore",
    content: `__pycache__/
*.py[cod]
*$py.class
*.egg-info/
dist/
build/
.eggs/
.venv/
venv/
.env
.mypy_cache/
.pytest_cache/
.ruff_cache/
htmlcov/
*.db
data/
models/
*.log
.idea/
.vscode/
`,
    needsLlm: false,
  });

  // Makefile
  files.push({
    path: "Makefile",
    content: `.PHONY: install dev test lint format clean

install:
\tpip install -e .

dev:
\tpip install -e ".[dev]"

test:
\tpytest --cov=${cfg.name} --cov-report=term-missing

lint:
\truff check .
\tmypy ${cfg.name}/

format:
\truff format .
\truff check --fix .

${cfg.type === "api" ? `run:
\tuvicorn ${cfg.name}.main:app --reload --port 8000
` : cfg.type === "cli" ? `run:
\tpython -m ${cfg.name}.cli
` : `run:
\tpython -m ${cfg.name}.main
`}
clean:
\trm -rf build/ dist/ *.egg-info .mypy_cache .pytest_cache .ruff_cache htmlcov/
`,
    needsLlm: false,
  });

  // Dockerfile
  if (cfg.hasDocker) {
    files.push({
      path: "Dockerfile",
      content: `FROM python:${cfg.pythonVersion}-slim AS base
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY . .
RUN pip install --no-cache-dir -e .

${cfg.type === "api" ? `EXPOSE 8000
CMD ["uvicorn", "${cfg.name}.main:app", "--host", "0.0.0.0", "--port", "8000"]` : `CMD ["python", "-m", "${cfg.name}.main"]`}
`,
      needsLlm: false,
    });
  }

  // CI
  if (cfg.hasCI) {
    files.push({
      path: ".github/workflows/ci.yml",
      content: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "${cfg.pythonVersion}"
      - run: pip install -e ".[dev]"
      - run: ruff check .
      - run: mypy ${cfg.name}/
      - run: pytest --cov=${cfg.name}
`,
      needsLlm: false,
    });
  }

  // .env example
  files.push({
    path: ".env.example",
    content: `# ${cfg.name} configuration
# Copy to .env and fill in values
${cfg.type === "api" ? "PORT=8000\nDATABASE_URL=sqlite:///data.db" : ""}
${cfg.dependencies.includes("openai") ? "OPENAI_API_KEY=sk-..." : ""}
${cfg.dependencies.includes("web3") ? "WEB3_PROVIDER_URL=https://mainnet.infura.io/v3/YOUR_KEY\nPRIVATE_KEY=" : ""}
${cfg.type === "bot" ? "BOT_TOKEN=your-bot-token-here" : ""}
`,
    needsLlm: false,
  });

  // README
  files.push({
    path: "README.md",
    content: `# ${cfg.name}

${cfg.type === "api" ? "REST API" : cfg.type === "cli" ? "CLI tool" : cfg.type === "ml" ? "ML pipeline" : cfg.type === "scraper" ? "Web scraper" : "Python project"} built with KCode.

## Setup

\`\`\`bash
python -m venv .venv
source .venv/bin/activate  # or .venv\\Scripts\\activate on Windows
pip install -e ".[dev]"
\`\`\`

## Run

\`\`\`bash
make run
\`\`\`

## Test

\`\`\`bash
make test
\`\`\`

## Lint

\`\`\`bash
make lint
\`\`\`
${cfg.dependencies.length > 0 ? "\n## Dependencies\n\n" + cfg.dependencies.map(d => `- ${d}`).join("\n") + "\n" : ""}
*Generated by KCode — Astrolexis.space*
`,
    needsLlm: false,
  });

  return files;
}

function capitalize(s: string): string {
  return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

// ── Main Creator ───────────────────────────────────────────────

export interface PyProjectResult {
  config: PyProjectConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createPyProject(userRequest: string, cwd: string): PyProjectResult {
  const config = detectPyProject(userRequest);
  const files: GenFile[] = [];

  files.push(generatePyProject(config));
  files.push(generateInit(config));
  files.push(generateMain(config));
  files.push(...generateTests(config));
  files.push(...generateExtras(config));

  // Write files
  const projectPath = join(cwd, config.name);
  for (const file of files) {
    const fullPath = join(projectPath, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }

  const machineFiles = files.filter(f => !f.needsLlm).length;
  const llmFiles = files.filter(f => f.needsLlm).length;

  const prompt = `You are implementing a Python ${config.type} project.

PROJECT: ${config.name}
TYPE: ${config.type}
PYTHON: ${config.pythonVersion}
${config.framework ? `FRAMEWORK: ${config.framework}` : ""}
DEPENDENCIES: ${config.dependencies.join(", ") || "none"}

The machine created ${machineFiles} files (pyproject.toml, structure, tests, CI).
You need to implement business logic in ${llmFiles} files:

${files.filter(f => f.needsLlm).map(f => `- ${f.path}`).join("\n")}

USER REQUEST: "${userRequest}"

INSTRUCTIONS:
1. Implement the TODO sections
2. Use type hints everywhere (strict mypy)
3. Use modern Python (3.12+): match/case, walrus, dataclasses
4. Add proper error handling (custom exceptions where needed)
5. Fill test cases with meaningful assertions
6. Follow the existing project structure
7. Do NOT modify pyproject.toml or config files`;

  return { config, files, projectPath, prompt };
}
