// KCode - Ruby Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RubyProjectType = "api" | "web" | "cli" | "library" | "worker" | "custom";

interface RubyConfig { name: string; type: RubyProjectType; framework?: string; gems: string[]; }

function detectRubyProject(msg: string): RubyConfig {
  const lower = msg.toLowerCase();
  let type: RubyProjectType = "api";
  let framework: string | undefined;
  const gems: string[] = [];

  if (/\b(?:rails|full.?stack|mvc)\b/i.test(lower)) {
    type = "web"; framework = "rails";
    gems.push("rails", "puma", "sqlite3");
  }
  else if (/\b(?:sinatra|api|rest|server)\b/i.test(lower)) {
    type = "api"; framework = "sinatra";
    gems.push("sinatra", "sinatra-contrib", "puma", "rack");
  }
  else if (/\b(?:grape)\b/i.test(lower)) {
    type = "api"; framework = "grape";
    gems.push("grape", "grape-entity", "rack");
  }
  else if (/\b(?:cli|console|command|tool|script)\b/i.test(lower)) {
    type = "cli";
    gems.push("thor", "tty-prompt", "pastel");
  }
  else if (/\b(?:gem|lib|library|package)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:worker|sidekiq|job|queue|background)\b/i.test(lower)) {
    type = "worker";
    gems.push("sidekiq", "redis");
  }
  else {
    framework = "sinatra";
    gems.push("sinatra", "sinatra-contrib", "puma");
  }

  if (/\b(?:sequel|activerecord|database|db|postgres|mysql|sqlite)\b/i.test(lower)) {
    if (!gems.includes("rails")) gems.push("sequel", "sqlite3");
  }
  if (/\b(?:rspec)\b/i.test(lower) || true) gems.push("rspec");
  if (/\b(?:redis)\b/i.test(lower) && !gems.includes("redis")) gems.push("redis");
  if (/\b(?:faraday|http|client)\b/i.test(lower)) gems.push("faraday");
  if (/\b(?:jwt|auth|token)\b/i.test(lower)) gems.push("jwt");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, framework, gems: [...new Set(gems)] };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface RubyProjectResult { config: RubyConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createRubyProject(userRequest: string, cwd: string): RubyProjectResult {
  const cfg = detectRubyProject(userRequest);
  const files: GenFile[] = [];

  // Gemfile
  files.push({ path: "Gemfile", content: `source "https://rubygems.org"

ruby ">= 3.3"

${cfg.gems.map(g => `gem "${g}"`).join("\n")}

group :development, :test do
  gem "rspec" unless ${cfg.gems.includes("rspec")}
  gem "rubocop"
end
`, needsLlm: false });

  // Main code
  if (cfg.type === "api" && cfg.framework === "sinatra") {
    files.push({ path: "app.rb", content: `require "sinatra"
require "sinatra/json"

set :port, 10080
set :bind, "0.0.0.0"

get "/health" do
  json status: "ok"
end

# TODO: add routes
get "/api/items" do
  json [{ id: 1, name: "Sample" }]
end

post "/api/items" do
  body = JSON.parse(request.body.read)
  json body.merge("id" => 1)
end
`, needsLlm: true });

    files.push({ path: "config.ru", content: `require_relative "app"
run Sinatra::Application
`, needsLlm: false });

  } else if (cfg.type === "cli") {
    files.push({ path: "lib/${cfg.name}/cli.rb", content: `require "thor"

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
`, needsLlm: true });

    files.push({ path: `bin/${cfg.name}`, content: `#!/usr/bin/env ruby
require_relative "../lib/${cfg.name}/cli"
${cap(cfg.name)}::CLI.start(ARGV)
`, needsLlm: false });

  } else if (cfg.type === "library") {
    files.push({ path: `lib/${cfg.name}.rb`, content: `module ${cap(cfg.name)}
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
`, needsLlm: true });

    files.push({ path: `${cfg.name}.gemspec`, content: `Gem::Specification.new do |s|
  s.name        = "${cfg.name}"
  s.version     = "0.1.0"
  s.summary     = "${cfg.name} — A Ruby library"
  s.authors     = ["KCode"]
  s.files       = Dir["lib/**/*"]
  s.require_paths = ["lib"]
  s.required_ruby_version = ">= 3.3"
end
`, needsLlm: false });

  } else if (cfg.type === "worker") {
    files.push({ path: "app/workers/main_worker.rb", content: `require "sidekiq"

class MainWorker
  include Sidekiq::Job

  def perform(job_id, data)
    puts "Processing job #{job_id}..."

    # TODO: implement worker logic

    puts "Job #{job_id} done!"
  end
end
`, needsLlm: true });

  } else {
    files.push({ path: "app.rb", content: `# ${cfg.name}
# TODO: implement
puts "${cfg.name} started"
`, needsLlm: true });
  }

  // RSpec
  files.push({ path: "spec/spec_helper.rb", content: `RSpec.configure do |config|
  config.expect_with :rspec do |c|
    c.syntax = :expect
  end
end
`, needsLlm: false });

  files.push({ path: `spec/${cfg.name}_spec.rb`, content: `require "spec_helper"

RSpec.describe "${cfg.name}" do
  it "works" do
    expect(true).to be true
  end

  # TODO: add tests
end
`, needsLlm: true });

  // Extras
  files.push({ path: ".gitignore", content: ".bundle/\nvendor/\n*.gem\n.env\nGemfile.lock\ntmp/\n", needsLlm: false });
  files.push({ path: ".ruby-version", content: "3.3.0\n", needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM ruby:3.3-slim
WORKDIR /app
COPY Gemfile* ./
RUN bundle install --without development test
COPY . .
EXPOSE 10080
CMD ["ruby", "app.rb"]
`, needsLlm: false });
  files.push({ path: "Rakefile", content: `require "rspec/core/rake_task"\nRSpec::Core::RakeTask.new(:spec)\ntask default: :spec\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ruby/setup-ruby@v1\n        with: { ruby-version: "3.3", bundler-cache: true }\n      - run: bundle exec rspec\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nRuby ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\nbundle install\nruby app.rb\nbundle exec rspec\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement Ruby ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"` };
}

function cap(s: string): string { return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(""); }
