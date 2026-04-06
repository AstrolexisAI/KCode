// KCode - Elixir Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ElixirProjectType = "api" | "web" | "cli" | "library" | "worker" | "liveview" | "custom";

interface ElixirConfig { name: string; type: ElixirProjectType; framework?: string; deps: Array<{ name: string; version: string }>; }

function detectElixirProject(msg: string): ElixirConfig {
  const lower = msg.toLowerCase();
  let type: ElixirProjectType = "api";
  let framework: string | undefined;
  const deps: Array<{ name: string; version: string }> = [];

  if (/\b(?:phoenix|liveview|live.?view)\b/i.test(lower)) {
    if (/\b(?:liveview|live.?view|realtime|interactive)\b/i.test(lower)) {
      type = "liveview"; framework = "phoenix";
    } else {
      type = "web"; framework = "phoenix";
    }
    deps.push({ name: "phoenix", version: "~> 1.7" }, { name: "phoenix_html", version: "~> 4.1" }, { name: "phoenix_live_view", version: "~> 1.0" }, { name: "jason", version: "~> 1.4" }, { name: "plug_cowboy", version: "~> 2.7" });
  }
  else if (/\b(?:api|rest|server|http|plug)\b/i.test(lower)) {
    type = "api"; framework = "plug";
    deps.push({ name: "plug_cowboy", version: "~> 2.7" }, { name: "jason", version: "~> 1.4" });
  }
  else if (/\b(?:cli|escript|command|tool)\b/i.test(lower)) { type = "cli"; }
  else if (/\b(?:lib|library|hex|package)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:worker|genserver|otp|agent|supervisor)\b/i.test(lower)) { type = "worker"; }
  else {
    framework = "plug";
    deps.push({ name: "plug_cowboy", version: "~> 2.7" }, { name: "jason", version: "~> 1.4" });
  }

  if (/\b(?:ecto|database|db|postgres|mysql)\b/i.test(lower)) {
    deps.push({ name: "ecto_sql", version: "~> 3.12" }, { name: "postgrex", version: "~> 0.19" });
  }
  if (/\b(?:tesla|http\s*client|request)\b/i.test(lower)) deps.push({ name: "tesla", version: "~> 1.12" });
  if (/\b(?:oban|job|queue|background)\b/i.test(lower)) deps.push({ name: "oban", version: "~> 2.18" });
  if (/\b(?:broadway|pipeline|event)\b/i.test(lower)) deps.push({ name: "broadway", version: "~> 1.1" });

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, framework, deps: dedup(deps) };
}

function dedup(deps: Array<{ name: string; version: string }>): Array<{ name: string; version: string }> {
  const seen = new Set<string>();
  return deps.filter(d => { if (seen.has(d.name)) return false; seen.add(d.name); return true; });
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface ElixirProjectResult { config: ElixirConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createElixirProject(userRequest: string, cwd: string): ElixirProjectResult {
  const cfg = detectElixirProject(userRequest);
  const files: GenFile[] = [];
  const mod = cap(cfg.name);
  const snake = cfg.name.replace(/-/g, "_");

  // mix.exs
  files.push({ path: "mix.exs", content: `defmodule ${mod}.MixProject do
  use Mix.Project

  def project do
    [
      app: :${snake},
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps()${cfg.type === "cli" ? ',\n      escript: [main_module: ' + mod + '.CLI]' : ""}
    ]
  end

  def application do
    [
      extra_applications: [:logger]${cfg.type !== "library" && cfg.type !== "cli" ? ',\n      mod: {' + mod + '.Application, []}' : ""}
    ]
  end

  defp deps do
    [
${cfg.deps.map(d => `      {:${d.name}, "${d.version}"},`).join("\n")}
    ]
  end
end
`, needsLlm: false });

  // Source code
  if (cfg.type === "api" && cfg.framework === "plug") {
    files.push({ path: `lib/${snake}/application.ex`, content: `defmodule ${mod}.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Plug.Cowboy, scheme: :http, plug: ${mod}.Router, options: [port: 10080]}
    ]

    opts = [strategy: :one_for_one, name: ${mod}.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
`, needsLlm: false });

    files.push({ path: `lib/${snake}/router.ex`, content: `defmodule ${mod}.Router do
  use Plug.Router

  plug :match
  plug :dispatch
  plug Plug.Parsers, parsers: [:json], json_decoder: Jason

  get "/health" do
    send_json(conn, 200, %{status: "ok"})
  end

  # TODO: add routes
  get "/api/items" do
    send_json(conn, 200, [%{id: 1, name: "Sample"}])
  end

  post "/api/items" do
    send_json(conn, 201, conn.body_params)
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end

  defp send_json(conn, status, data) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(data))
  end
end
`, needsLlm: true });

  } else if (cfg.type === "cli") {
    files.push({ path: `lib/${snake}/cli.ex`, content: `defmodule ${mod}.CLI do
  def main(args) do
    case args do
      [input | _rest] ->
        IO.puts("Processing: #{input}")

        # TODO: implement logic

        IO.puts("Done!")

      [] ->
        IO.puts("Usage: ${snake} <input>")
        System.halt(1)
    end
  end
end
`, needsLlm: true });

  } else if (cfg.type === "library") {
    files.push({ path: `lib/${snake}.ex`, content: `defmodule ${mod} do
  @moduledoc """
  ${mod} — Main module.
  """

  defstruct initialized: false

  @type t :: %__MODULE__{initialized: boolean()}

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @spec setup(t()) :: {:ok, t()} | {:error, String.t()}
  def setup(%__MODULE__{} = state) do
    # TODO: setup
    {:ok, %{state | initialized: true}}
  end

  @spec process(t(), any()) :: {:ok, any()} | {:error, String.t()}
  def process(%__MODULE__{initialized: true}, data) do
    # TODO: main logic
    {:ok, data}
  end

  def process(%__MODULE__{initialized: false}, _data) do
    {:error, "Not initialized. Call setup/1 first."}
  end
end
`, needsLlm: true });

  } else if (cfg.type === "worker") {
    files.push({ path: `lib/${snake}/application.ex`, content: `defmodule ${mod}.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      ${mod}.Worker
    ]

    opts = [strategy: :one_for_one, name: ${mod}.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
`, needsLlm: false });

    files.push({ path: `lib/${snake}/worker.ex`, content: `defmodule ${mod}.Worker do
  use GenServer
  require Logger

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  @impl true
  def init(state) do
    Logger.info("${mod} worker started")
    schedule_work()
    {:ok, state}
  end

  @impl true
  def handle_info(:work, state) do
    Logger.info("Processing job at #{DateTime.utc_now()}")

    # TODO: implement worker logic

    schedule_work()
    {:noreply, state}
  end

  defp schedule_work do
    Process.send_after(self(), :work, :timer.seconds(10))
  end
end
`, needsLlm: true });

  } else {
    // Phoenix/LiveView — simplified scaffold
    files.push({ path: `lib/${snake}/application.ex`, content: `defmodule ${mod}.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Plug.Cowboy, scheme: :http, plug: ${mod}.Router, options: [port: 10080]}
    ]

    opts = [strategy: :one_for_one, name: ${mod}.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
`, needsLlm: false });

    files.push({ path: `lib/${snake}/router.ex`, content: `defmodule ${mod}.Router do
  use Plug.Router

  plug :match
  plug :dispatch

  get "/health" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{status: "ok"}))
  end

  # TODO: add Phoenix routes

  match _ do
    send_resp(conn, 404, "Not found")
  end
end
`, needsLlm: true });
  }

  // Tests
  files.push({ path: `test/${snake}_test.exs`, content: `defmodule ${mod}Test do
  use ExUnit.Case

  test "basic" do
    assert true
  end

  # TODO: add tests
end
`, needsLlm: true });

  files.push({ path: "test/test_helper.exs", content: `ExUnit.start()\n`, needsLlm: false });

  // Config
  files.push({ path: "config/config.exs", content: `import Config

config :${snake},
  port: 10080

config :logger, :console,
  format: "$time $metadata[$level] $message\\n"
`, needsLlm: false });

  // Extras
  files.push({ path: ".gitignore", content: "_build/\ndeps/\n*.beam\n.env\n*.ez\nerl_crash.dump\n", needsLlm: false });
  files.push({ path: ".formatter.exs", content: `[\n  inputs: ["{mix,.formatter}.exs", "{config,lib,test}/**/*.{ex,exs}"]\n]\n`, needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM elixir:1.17-slim AS builder\nWORKDIR /app\nENV MIX_ENV=prod\nCOPY mix.exs mix.lock ./\nRUN mix deps.get --only prod && mix deps.compile\nCOPY . .\nRUN mix compile && mix release\n\nFROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses5 locales && rm -rf /var/lib/apt/lists/*\nCOPY --from=builder /app/_build/prod/rel/${snake} /app\nEXPOSE 10080\nCMD ["/app/bin/${snake}", "start"]\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: erlef/setup-beam@v1\n        with: { elixir-version: "1.17", otp-version: "27" }\n      - run: mix deps.get\n      - run: mix test\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nElixir ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\nmix deps.get\nmix run --no-halt\nmix test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement Elixir ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"` };
}

function cap(s: string): string { return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(""); }
