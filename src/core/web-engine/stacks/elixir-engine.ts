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
  require Logger

  @impl true
  def start(_type, _args) do
    children = [
      ${mod}.Store,
      {Plug.Cowboy, scheme: :http, plug: ${mod}.Router, options: [port: 10080]}
    ]

    opts = [strategy: :one_for_one, name: ${mod}.Supervisor]
    Logger.info("Starting ${mod} on port 10080")
    Supervisor.start_link(children, opts)
  end
end
`, needsLlm: false });

    files.push({ path: `lib/${snake}/item.ex`, content: `defmodule ${mod}.Item do
  @moduledoc "Item struct with id, name, description, and inserted_at fields."

  @derive Jason.Encoder
  defstruct [:id, :name, :description, :inserted_at]

  @type t :: %__MODULE__{
    id: pos_integer(),
    name: String.t(),
    description: String.t(),
    inserted_at: String.t()
  }

  @spec new(pos_integer(), String.t(), String.t()) :: t()
  def new(id, name, description \\\\ "") do
    %__MODULE__{
      id: id,
      name: name,
      description: description,
      inserted_at: DateTime.utc_now() |> DateTime.to_iso8601()
    }
  end
end
`, needsLlm: false });

    files.push({ path: `lib/${snake}/store.ex`, content: `defmodule ${mod}.Store do
  @moduledoc "Agent-based in-memory store for items."

  use Agent

  alias ${mod}.Item

  def start_link(_opts) do
    Agent.start_link(fn -> %{items: %{}, next_id: 1} end, name: __MODULE__)
  end

  @spec list() :: [Item.t()]
  def list do
    Agent.get(__MODULE__, fn %{items: items} ->
      items |> Map.values() |> Enum.sort_by(& &1.id)
    end)
  end

  @spec get(pos_integer()) :: {:ok, Item.t()} | :not_found
  def get(id) do
    Agent.get(__MODULE__, fn %{items: items} ->
      case Map.fetch(items, id) do
        {:ok, item} -> {:ok, item}
        :error -> :not_found
      end
    end)
  end

  @spec create(String.t(), String.t()) :: Item.t()
  def create(name, description \\\\ "") do
    Agent.get_and_update(__MODULE__, fn %{items: items, next_id: id} = _state ->
      item = Item.new(id, name, description)
      {item, %{items: Map.put(items, id, item), next_id: id + 1}}
    end)
  end

  @spec update(pos_integer(), map()) :: {:ok, Item.t()} | :not_found
  def update(id, attrs) do
    Agent.get_and_update(__MODULE__, fn %{items: items} = state ->
      case Map.fetch(items, id) do
        {:ok, item} ->
          updated =
            item
            |> then(fn i -> if Map.has_key?(attrs, "name"), do: %{i | name: attrs["name"]}, else: i end)
            |> then(fn i -> if Map.has_key?(attrs, "description"), do: %{i | description: attrs["description"]}, else: i end)
          {{:ok, updated}, %{state | items: Map.put(items, id, updated)}}
        :error ->
          {:not_found, state}
      end
    end)
  end

  @spec delete(pos_integer()) :: :ok | :not_found
  def delete(id) do
    Agent.get_and_update(__MODULE__, fn %{items: items} = state ->
      if Map.has_key?(items, id) do
        {:ok, %{state | items: Map.delete(items, id)}}
      else
        {:not_found, state}
      end
    end)
  end

  @spec clear() :: :ok
  def clear do
    Agent.update(__MODULE__, fn _state -> %{items: %{}, next_id: 1} end)
  end
end
`, needsLlm: false });

    files.push({ path: `lib/${snake}/router.ex`, content: `defmodule ${mod}.Router do
  use Plug.Router
  require Logger

  alias ${mod}.Store

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason

  plug :match
  plug :dispatch

  get "/health" do
    send_json(conn, 200, %{status: "ok"})
  end

  get "/api/items" do
    Logger.info("Listing all items")
    items = Store.list()
    send_json(conn, 200, items)
  end

  get "/api/items/:id" do
    id = String.to_integer(id)
    case Store.get(id) do
      {:ok, item} ->
        send_json(conn, 200, item)
      :not_found ->
        Logger.info("Item not found: \#{id}")
        send_json(conn, 404, %{error: true, message: "Item not found"})
    end
  end

  post "/api/items" do
    case validate_create(conn.body_params) do
      {:ok, name, description} ->
        item = Store.create(name, description)
        Logger.info("Created item \#{item.id}")
        send_json(conn, 201, item)
      {:error, errors} ->
        Logger.info("Validation failed: \#{inspect(errors)}")
        send_json(conn, 422, %{error: true, errors: errors})
    end
  end

  put "/api/items/:id" do
    id = String.to_integer(id)
    case validate_update(conn.body_params) do
      {:ok, attrs} ->
        case Store.update(id, attrs) do
          {:ok, item} ->
            Logger.info("Updated item \#{id}")
            send_json(conn, 200, item)
          :not_found ->
            send_json(conn, 404, %{error: true, message: "Item not found"})
        end
      {:error, errors} ->
        send_json(conn, 422, %{error: true, errors: errors})
    end
  end

  delete "/api/items/:id" do
    id = String.to_integer(id)
    case Store.delete(id) do
      :ok ->
        Logger.info("Deleted item \#{id}")
        send_json(conn, 200, %{deleted: true})
      :not_found ->
        send_json(conn, 404, %{error: true, message: "Item not found"})
    end
  end

  match _ do
    send_json(conn, 404, %{error: true, message: "Not found"})
  end

  defp send_json(conn, status, data) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(data))
  end

  defp validate_create(params) do
    errors = []
    errors = if !is_binary(params["name"]) or String.trim(params["name"] || "") == "" do
      ["name is required and must be a string" | errors]
    else
      errors
    end
    errors = if Map.has_key?(params, "description") and !is_binary(params["description"]) do
      ["description must be a string" | errors]
    else
      errors
    end
    if errors == [] do
      {:ok, String.trim(params["name"]), params["description"] || ""}
    else
      {:error, Enum.reverse(errors)}
    end
  end

  defp validate_update(params) do
    errors = []
    errors = if Map.has_key?(params, "name") and (!is_binary(params["name"]) or String.trim(params["name"]) == "") do
      ["name must be a non-empty string" | errors]
    else
      errors
    end
    errors = if Map.has_key?(params, "description") and !is_binary(params["description"]) do
      ["description must be a string" | errors]
    else
      errors
    end
    if errors == [] do
      {:ok, params}
    else
      {:error, Enum.reverse(errors)}
    end
  end
end
`, needsLlm: false });

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
  if (cfg.type === "api" && cfg.framework === "plug") {
    files.push({ path: `test/${snake}_test.exs`, content: `defmodule ${mod}Test do
  use ExUnit.Case, async: true
  use Plug.Test

  alias ${mod}.Router
  alias ${mod}.Store

  @opts Router.init([])

  setup do
    Store.clear()
    :ok
  end

  test "GET /health returns ok" do
    conn = conn(:get, "/health") |> Router.call(@opts)
    assert conn.status == 200
    assert %{"status" => "ok"} = Jason.decode!(conn.resp_body)
  end

  test "GET /api/items returns empty list" do
    conn = conn(:get, "/api/items") |> Router.call(@opts)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == []
  end

  test "POST /api/items creates an item" do
    conn =
      conn(:post, "/api/items", Jason.encode!(%{name: "Widget", description: "A widget"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    assert conn.status == 201
    body = Jason.decode!(conn.resp_body)
    assert body["name"] == "Widget"
    assert body["description"] == "A widget"
    assert is_integer(body["id"])
    assert body["inserted_at"]
  end

  test "POST /api/items returns 422 when name missing" do
    conn =
      conn(:post, "/api/items", Jason.encode!(%{description: "no name"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    assert conn.status == 422
    body = Jason.decode!(conn.resp_body)
    assert body["error"] == true
    assert is_list(body["errors"])
  end

  test "GET /api/items/:id returns an item" do
    conn =
      conn(:post, "/api/items", Jason.encode!(%{name: "Gadget"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    %{"id" => id} = Jason.decode!(conn.resp_body)

    conn = conn(:get, "/api/items/\#{id}") |> Router.call(@opts)
    assert conn.status == 200
    assert %{"name" => "Gadget"} = Jason.decode!(conn.resp_body)
  end

  test "GET /api/items/:id returns 404 for missing item" do
    conn = conn(:get, "/api/items/999") |> Router.call(@opts)
    assert conn.status == 404
  end

  test "PUT /api/items/:id updates an item" do
    conn =
      conn(:post, "/api/items", Jason.encode!(%{name: "Old", description: "Old desc"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    %{"id" => id} = Jason.decode!(conn.resp_body)

    conn =
      conn(:put, "/api/items/\#{id}", Jason.encode!(%{name: "New"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["name"] == "New"
    assert body["description"] == "Old desc"
  end

  test "PUT /api/items/:id returns 404 for missing item" do
    conn =
      conn(:put, "/api/items/999", Jason.encode!(%{name: "x"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    assert conn.status == 404
  end

  test "DELETE /api/items/:id deletes an item" do
    conn =
      conn(:post, "/api/items", Jason.encode!(%{name: "ToDelete"}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)

    %{"id" => id} = Jason.decode!(conn.resp_body)

    conn = conn(:delete, "/api/items/\#{id}") |> Router.call(@opts)
    assert conn.status == 200
    assert %{"deleted" => true} = Jason.decode!(conn.resp_body)

    conn = conn(:get, "/api/items/\#{id}") |> Router.call(@opts)
    assert conn.status == 404
  end

  test "DELETE /api/items/:id returns 404 for missing item" do
    conn = conn(:delete, "/api/items/999") |> Router.call(@opts)
    assert conn.status == 404
  end

  test "GET /api/items returns all created items" do
    for name <- ["One", "Two", "Three"] do
      conn(:post, "/api/items", Jason.encode!(%{name: name}))
      |> put_req_header("content-type", "application/json")
      |> Router.call(@opts)
    end

    conn = conn(:get, "/api/items") |> Router.call(@opts)
    assert conn.status == 200
    assert length(Jason.decode!(conn.resp_body)) == 3
  end

  test "unknown route returns 404" do
    conn = conn(:get, "/nonexistent") |> Router.call(@opts)
    assert conn.status == 404
  end
end
`, needsLlm: false });
  } else {
    files.push({ path: `test/${snake}_test.exs`, content: `defmodule ${mod}Test do
  use ExUnit.Case

  test "basic" do
    assert true
  end

  # TODO: add tests
end
`, needsLlm: true });
  }

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
