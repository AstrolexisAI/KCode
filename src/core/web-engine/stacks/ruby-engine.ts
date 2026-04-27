// KCode - Ruby Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RubyProjectType = "api" | "web" | "cli" | "library" | "worker" | "custom";

interface RubyConfig {
  name: string;
  type: RubyProjectType;
  framework?: string;
  gems: string[];
}

function detectRubyProject(msg: string): RubyConfig {
  const lower = msg.toLowerCase();
  let type: RubyProjectType = "api";
  let framework: string | undefined;
  const gems: string[] = [];

  if (/\b(?:rails|full.?stack|mvc)\b/i.test(lower)) {
    type = "web";
    framework = "rails";
    gems.push("rails", "puma", "sqlite3");
  } else if (/\b(?:sinatra|api|rest|server)\b/i.test(lower)) {
    type = "api";
    framework = "sinatra";
    gems.push("sinatra", "sinatra-contrib", "puma", "rack", "rack-test");
  } else if (/\b(?:grape)\b/i.test(lower)) {
    type = "api";
    framework = "grape";
    gems.push("grape", "grape-entity", "rack");
  } else if (/\b(?:cli|console|command|tool|script)\b/i.test(lower)) {
    type = "cli";
    gems.push("thor", "tty-prompt", "pastel");
  } else if (/\b(?:gem|lib|library|package)\b/i.test(lower)) {
    type = "library";
  } else if (/\b(?:worker|sidekiq|job|queue|background)\b/i.test(lower)) {
    type = "worker";
    gems.push("sidekiq", "redis");
  } else {
    framework = "sinatra";
    gems.push("sinatra", "sinatra-contrib", "puma", "rack-test");
  }

  if (/\b(?:sequel|activerecord|database|db|postgres|mysql|sqlite)\b/i.test(lower)) {
    if (!gems.includes("rails")) gems.push("sequel", "sqlite3");
  }
  // rspec is included unconditionally — the regex test was redundant since the
  // `|| true` made the branch always-taken. Kept the explicit always-include
  // semantics so ruby projects always get rspec set up.
  gems.push("rspec");
  if (/\b(?:redis)\b/i.test(lower) && !gems.includes("redis")) gems.push("redis");
  if (/\b(?:faraday|http|client)\b/i.test(lower)) gems.push("faraday");
  if (/\b(?:jwt|auth|token)\b/i.test(lower)) gems.push("jwt");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, framework, gems: [...new Set(gems)] };
}

interface GenFile {
  path: string;
  content: string;
  needsLlm: boolean;
}
export interface RubyProjectResult {
  config: RubyConfig;
  files: GenFile[];
  projectPath: string;
  prompt: string;
}

export function createRubyProject(userRequest: string, cwd: string): RubyProjectResult {
  const cfg = detectRubyProject(userRequest);
  const files: GenFile[] = [];

  // Gemfile
  files.push({
    path: "Gemfile",
    content: `source "https://rubygems.org"

ruby ">= 3.3"

${cfg.gems.map((g) => `gem "${g}"`).join("\n")}

group :development, :test do
  gem "rspec" unless ${cfg.gems.includes("rspec")}
  gem "rubocop"
end
`,
    needsLlm: false,
  });

  // Main code
  if (cfg.type === "api" && cfg.framework === "sinatra") {
    files.push({
      path: "app.rb",
      content: `require "sinatra"
require "sinatra/json"
require "json"
require "logger"
require "securerandom"
require "time"

set :port, 10080
set :bind, "0.0.0.0"

LOGGER = Logger.new($stdout)
LOGGER.level = Logger::INFO

Item = Struct.new(:id, :name, :description, :created_at, keyword_init: true) do
  def to_h
    { id: id, name: name, description: description, created_at: created_at }
  end
end

ITEMS = {}
NEXT_ID = { value: 1 }

before do
  content_type :json
end

helpers do
  def parse_json_body
    body = request.body.read
    return {} if body.empty?
    JSON.parse(body)
  rescue JSON::ParserError
    halt 400, json(error: true, message: "Invalid JSON")
  end

  def find_item!(id)
    item = ITEMS[id.to_i]
    halt 404, json(error: true, message: "Item not found") unless item
    item
  end

  def validate_create!(data)
    errors = []
    errors << "name is required" unless data["name"].is_a?(String) && !data["name"].strip.empty?
    errors << "description must be a string" if data.key?("description") && !data["description"].is_a?(String)
    halt 422, json(error: true, errors: errors) unless errors.empty?
  end

  def validate_update!(data)
    errors = []
    errors << "name must be a non-empty string" if data.key?("name") && (!data["name"].is_a?(String) || data["name"].strip.empty?)
    errors << "description must be a string" if data.key?("description") && !data["description"].is_a?(String)
    halt 422, json(error: true, errors: errors) unless errors.empty?
  end
end

error do |e|
  LOGGER.error("Unhandled error: #{e.message}")
  status 500
  json error: true, message: "Internal server error"
end

get "/health" do
  json status: "ok"
end

get "/api/items" do
  LOGGER.info("Listing all items")
  json ITEMS.values.map(&:to_h)
end

get "/api/items/:id" do
  item = find_item!(params[:id])
  json item.to_h
end

post "/api/items" do
  data = parse_json_body
  validate_create!(data)

  id = NEXT_ID[:value]
  NEXT_ID[:value] += 1

  item = Item.new(
    id: id,
    name: data["name"].strip,
    description: data["description"]&.strip || "",
    created_at: Time.now.iso8601
  )
  ITEMS[id] = item

  LOGGER.info("Created item #{id}")
  status 201
  json item.to_h
end

put "/api/items/:id" do
  item = find_item!(params[:id])
  data = parse_json_body
  validate_update!(data)

  item.name = data["name"].strip if data.key?("name")
  item.description = data["description"].strip if data.key?("description")

  LOGGER.info("Updated item #{item.id}")
  json item.to_h
end

delete "/api/items/:id" do
  item = find_item!(params[:id])
  ITEMS.delete(item.id)

  LOGGER.info("Deleted item #{item.id}")
  json deleted: true
end
`,
      needsLlm: false,
    });

    files.push({
      path: "config.ru",
      content: `require_relative "app"
run Sinatra::Application
`,
      needsLlm: false,
    });
  } else if (cfg.type === "cli") {
    files.push({
      path: "lib/${cfg.name}/cli.rb",
      content: `require "thor"

module ${cap(cfg.name)}
  class CLI < Thor
    desc "run INPUT", "Run the main command"
    option :output, type: :string, default: "output.txt", aliases: "-o"
    option :verbose, type: :boolean, default: false, aliases: "-v"
    def run_command(input)
      puts "Processing: #{input}" if options[:verbose]

      # TODO: implement logic

      puts "Done!"
    end

    desc "version", "Show version"
    def version
      puts "${cfg.name} v0.1.0"
    end
  end
end
`,
      needsLlm: true,
    });

    files.push({
      path: `bin/${cfg.name}`,
      content: `#!/usr/bin/env ruby
require_relative "../lib/${cfg.name}/cli"
${cap(cfg.name)}::CLI.start(ARGV)
`,
      needsLlm: false,
    });
  } else if (cfg.type === "library") {
    files.push({
      path: `lib/${cfg.name}.rb`,
      content: `module ${cap(cfg.name)}
  class Error < StandardError; end
  VERSION = "0.1.0"

  class Client
    def initialize
      @initialized = false
    end

    def setup
      # TODO: setup
      @initialized = true
      self
    end

    def process(data)
      raise Error, "Not initialized. Call setup first." unless @initialized
      # TODO: main logic
      data
    end
  end
end
`,
      needsLlm: true,
    });

    files.push({
      path: `${cfg.name}.gemspec`,
      content: `Gem::Specification.new do |s|
  s.name        = "${cfg.name}"
  s.version     = "0.1.0"
  s.summary     = "${cfg.name} — A Ruby library"
  s.authors     = ["KCode"]
  s.files       = Dir["lib/**/*"]
  s.require_paths = ["lib"]
  s.required_ruby_version = ">= 3.3"
end
`,
      needsLlm: false,
    });
  } else if (cfg.type === "worker") {
    files.push({
      path: "app/workers/main_worker.rb",
      content: `require "sidekiq"

class MainWorker
  include Sidekiq::Job

  def perform(job_id, data)
    puts "Processing job #{job_id}..."

    # TODO: implement worker logic

    puts "Job #{job_id} done!"
  end
end
`,
      needsLlm: true,
    });
  } else {
    files.push({
      path: "app.rb",
      content: `# ${cfg.name}
# TODO: implement
puts "${cfg.name} started"
`,
      needsLlm: true,
    });
  }

  // RSpec
  if (cfg.type === "api" && cfg.framework === "sinatra") {
    files.push({
      path: `spec/${cfg.name}_spec.rb`,
      content: `require "spec_helper"
require "rack/test"
require_relative "../app"

RSpec.describe "${cfg.name} API" do
  include Rack::Test::Methods

  def app
    Sinatra::Application
  end

  before(:each) do
    ITEMS.clear
    NEXT_ID[:value] = 1
  end

  describe "GET /health" do
    it "returns ok status" do
      get "/health"
      expect(last_response.status).to eq(200)
      body = JSON.parse(last_response.body)
      expect(body["status"]).to eq("ok")
    end
  end

  describe "GET /api/items" do
    it "returns empty array when no items" do
      get "/api/items"
      expect(last_response.status).to eq(200)
      expect(JSON.parse(last_response.body)).to eq([])
    end

    it "returns all items" do
      post "/api/items", { name: "First", description: "Desc" }.to_json, "CONTENT_TYPE" => "application/json"
      post "/api/items", { name: "Second" }.to_json, "CONTENT_TYPE" => "application/json"
      get "/api/items"
      expect(last_response.status).to eq(200)
      items = JSON.parse(last_response.body)
      expect(items.length).to eq(2)
    end
  end

  describe "GET /api/items/:id" do
    it "returns an item by id" do
      post "/api/items", { name: "Widget", description: "A widget" }.to_json, "CONTENT_TYPE" => "application/json"
      item = JSON.parse(last_response.body)
      get "/api/items/#{item['id']}"
      expect(last_response.status).to eq(200)
      found = JSON.parse(last_response.body)
      expect(found["name"]).to eq("Widget")
    end

    it "returns 404 for missing item" do
      get "/api/items/999"
      expect(last_response.status).to eq(404)
    end
  end

  describe "POST /api/items" do
    it "creates an item with valid data" do
      post "/api/items", { name: "New Item", description: "A desc" }.to_json, "CONTENT_TYPE" => "application/json"
      expect(last_response.status).to eq(201)
      item = JSON.parse(last_response.body)
      expect(item["name"]).to eq("New Item")
      expect(item["description"]).to eq("A desc")
      expect(item).to have_key("id")
      expect(item).to have_key("created_at")
    end

    it "returns 422 when name is missing" do
      post "/api/items", { description: "no name" }.to_json, "CONTENT_TYPE" => "application/json"
      expect(last_response.status).to eq(422)
      body = JSON.parse(last_response.body)
      expect(body["errors"]).to include("name is required")
    end
  end

  describe "PUT /api/items/:id" do
    it "updates an existing item" do
      post "/api/items", { name: "Old", description: "Old desc" }.to_json, "CONTENT_TYPE" => "application/json"
      item = JSON.parse(last_response.body)
      put "/api/items/#{item['id']}", { name: "Updated" }.to_json, "CONTENT_TYPE" => "application/json"
      expect(last_response.status).to eq(200)
      updated = JSON.parse(last_response.body)
      expect(updated["name"]).to eq("Updated")
      expect(updated["description"]).to eq("Old desc")
    end

    it "returns 404 for missing item" do
      put "/api/items/999", { name: "x" }.to_json, "CONTENT_TYPE" => "application/json"
      expect(last_response.status).to eq(404)
    end
  end

  describe "DELETE /api/items/:id" do
    it "deletes an existing item" do
      post "/api/items", { name: "ToDelete" }.to_json, "CONTENT_TYPE" => "application/json"
      item = JSON.parse(last_response.body)
      delete "/api/items/#{item['id']}"
      expect(last_response.status).to eq(200)
      body = JSON.parse(last_response.body)
      expect(body["deleted"]).to eq(true)
      get "/api/items/#{item['id']}"
      expect(last_response.status).to eq(404)
    end

    it "returns 404 for missing item" do
      delete "/api/items/999"
      expect(last_response.status).to eq(404)
    end
  end
end
`,
      needsLlm: false,
    });

    files.push({
      path: "spec/spec_helper.rb",
      content: `require "rack/test"
require "json"

RSpec.configure do |config|
  config.expect_with :rspec do |c|
    c.syntax = :expect
  end
  config.include Rack::Test::Methods
end
`,
      needsLlm: false,
    });
  } else {
    files.push({
      path: "spec/spec_helper.rb",
      content: `RSpec.configure do |config|
  config.expect_with :rspec do |c|
    c.syntax = :expect
  end
end
`,
      needsLlm: false,
    });

    files.push({
      path: `spec/${cfg.name}_spec.rb`,
      content: `require "spec_helper"

RSpec.describe "${cfg.name}" do
  it "works" do
    expect(true).to be true
  end

  # TODO: add tests
end
`,
      needsLlm: true,
    });
  }

  // Extras
  files.push({
    path: ".gitignore",
    content: ".bundle/\nvendor/\n*.gem\n.env\nGemfile.lock\ntmp/\n",
    needsLlm: false,
  });
  files.push({ path: ".ruby-version", content: "3.3.0\n", needsLlm: false });
  files.push({
    path: "Dockerfile",
    content: `FROM ruby:3.3-slim
WORKDIR /app
COPY Gemfile* ./
RUN bundle install --without development test
COPY . .
EXPOSE 10080
CMD ["ruby", "app.rb"]
`,
    needsLlm: false,
  });
  files.push({
    path: "Rakefile",
    content: `require "rspec/core/rake_task"\nRSpec::Core::RakeTask.new(:spec)\ntask default: :spec\n`,
    needsLlm: false,
  });
  files.push({
    path: ".github/workflows/ci.yml",
    content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ruby/setup-ruby@v1\n        with: { ruby-version: "3.3", bundler-cache: true }\n      - run: bundle exec rspec\n`,
    needsLlm: false,
  });
  files.push({
    path: "README.md",
    content: `# ${cfg.name}\n\nRuby ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\nbundle install\nruby app.rb\nbundle exec rspec\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`,
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
    prompt: `Implement Ruby ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"`,
  };
}

function cap(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
