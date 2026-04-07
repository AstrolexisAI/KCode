// KCode - Lua Project Engine

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LuaProjectType = "script" | "game" | "neovim" | "roblox" | "library" | "server" | "embedded";

interface LuaConfig { name: string; type: LuaProjectType; framework?: string; deps: string[]; }

function detectLuaProject(msg: string): LuaConfig {
  const lower = msg.toLowerCase();
  let type: LuaProjectType = "script";
  let framework: string | undefined;
  const deps: string[] = [];

  if (/\b(?:love2?d|game|2d|sprite|physics)\b/i.test(lower)) {
    type = "game"; framework = "love2d";
  }
  else if (/\b(?:neovim|nvim|vim\s*plugin|editor\s*plugin)\b/i.test(lower)) {
    type = "neovim"; framework = "neovim";
  }
  else if (/\b(?:roblox|rblx|luau|studio)\b/i.test(lower)) {
    type = "roblox"; framework = "roblox";
  }
  else if (/\b(?:lapis|openresty|nginx|web|api|rest|server|http)\b/i.test(lower)) {
    type = "server";
    if (/\b(?:lapis)\b/i.test(lower)) {
      framework = "lapis";
      deps.push("lapis");
    } else {
      framework = "openresty";
    }
  }
  else if (/\b(?:lib|library|module|package|rock)\b/i.test(lower)) { type = "library"; }
  else if (/\b(?:embedded|esp|iot|nodemcu|firmware)\b/i.test(lower)) { type = "embedded"; }
  else if (/\b(?:script|cli|tool|command|automate)\b/i.test(lower)) { type = "script"; }

  if (/\b(?:luasocket|socket|network)\b/i.test(lower) && !deps.includes("luasocket")) deps.push("luasocket");
  if (/\b(?:lfs|filesystem|file\s*system)\b/i.test(lower)) deps.push("lfs");
  if (/\b(?:cjson|json)\b/i.test(lower)) deps.push("cjson");
  if (/\b(?:lpeg|peg|parsing|grammar)\b/i.test(lower)) deps.push("lpeg");
  if (/\b(?:penlight|pl)\b/i.test(lower)) deps.push("penlight");
  if (/\b(?:luarocks)\b/i.test(lower) && !deps.includes("luarocks")) deps.push("luarocks");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? (type === "library" ? "mylib" : "myapp");

  return { name, type, framework, deps: [...new Set(deps)] };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface LuaProjectResult { config: LuaConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createLuaProject(userRequest: string, cwd: string): LuaProjectResult {
  const cfg = detectLuaProject(userRequest);
  const files: GenFile[] = [];
  const snake = cfg.name.replace(/-/g, "_");

  // Rockspec
  files.push({ path: `${snake}-0.1.0-1.rockspec`, content: `package = "${snake}"
version = "0.1.0-1"
source = {
  url = "git+https://github.com/user/${snake}.git",
  tag = "v0.1.0",
}
description = {
  summary = "${cfg.name} -- A Lua ${cfg.type} project",
  license = "MIT",
}
dependencies = {
  "lua >= 5.1",
${cfg.deps.map(d => `  "${d}",`).join("\n")}
}
build = {
  type = "builtin",
  modules = {
    ["${snake}"] = "src/${snake}/init.lua",
  },
}
`, needsLlm: false });

  // Main code per type
  if (cfg.type === "game" && cfg.framework === "love2d") {
    files.push({ path: "conf.lua", content: `function love.conf(t)
  t.title = "${cfg.name}"
  t.version = "11.5"
  t.window.width = 800
  t.window.height = 600
  t.window.resizable = true
end
`, needsLlm: false });

    files.push({ path: "main.lua", content: `-- ${cfg.name} -- Love2D game

local player = { x = 400, y = 300, speed = 200 }

function love.load()
  love.graphics.setBackgroundColor(0.1, 0.1, 0.2)
end

function love.update(dt)
  if love.keyboard.isDown("left") then player.x = player.x - player.speed * dt end
  if love.keyboard.isDown("right") then player.x = player.x + player.speed * dt end
  if love.keyboard.isDown("up") then player.y = player.y - player.speed * dt end
  if love.keyboard.isDown("down") then player.y = player.y + player.speed * dt end

  -- TODO: add game logic
end

function love.draw()
  love.graphics.setColor(1, 1, 1)
  love.graphics.rectangle("fill", player.x - 16, player.y - 16, 32, 32)

  love.graphics.setColor(0.8, 0.8, 0.8)
  love.graphics.print("${cfg.name}", 10, 10)

  -- TODO: add rendering
end
`, needsLlm: true });

  } else if (cfg.type === "neovim") {
    files.push({ path: `lua/${snake}/init.lua`, content: `-- ${cfg.name} -- Neovim plugin

local M = {}

M.config = {
  enabled = true,
}

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})

  if M.config.enabled then
    -- TODO: setup keymaps, commands, autocommands
    vim.api.nvim_create_user_command("${cap(cfg.name)}", function(args)
      M.run(args.args)
    end, { nargs = "?" })
  end
end

function M.run(input)
  vim.notify("${cfg.name}: " .. (input or "running"), vim.log.levels.INFO)

  -- TODO: implement plugin logic
end

return M
`, needsLlm: true });

    files.push({ path: `plugin/${snake}.vim`, content: `" ${cfg.name} -- Neovim plugin loader
if exists('g:loaded_${snake}')
  finish
endif
let g:loaded_${snake} = 1

lua require('${snake}').setup()
`, needsLlm: false });

  } else if (cfg.type === "roblox") {
    files.push({ path: "src/init.lua", content: `-- ${cfg.name} -- Roblox module

local ${cap(cfg.name)} = {}
${cap(cfg.name)}.__index = ${cap(cfg.name)}

function ${cap(cfg.name)}.new()
  local self = setmetatable({}, ${cap(cfg.name)})
  self._initialized = false
  return self
end

function ${cap(cfg.name)}:Init()
  -- TODO: initialize
  self._initialized = true
  return self
end

function ${cap(cfg.name)}:Start()
  assert(self._initialized, "${cfg.name} must be initialized first")
  -- TODO: start game logic
end

return ${cap(cfg.name)}
`, needsLlm: true });

  } else if (cfg.type === "server") {
    if (cfg.framework === "lapis") {
      files.push({ path: "app.lua", content: `local lapis = require("lapis")
local app = lapis.Application()

app:get("/", function(self)
  return { json = { status = "ok", name = "${cfg.name}" } }
end)

app:get("/health", function(self)
  return { json = { status = "ok" } }
end)

-- TODO: add routes
app:get("/api/items", function(self)
  return { json = { { id = 1, name = "Sample" } } }
end)

app:post("/api/items", function(self)
  local body = self.params
  return { json = body }
end)

return app
`, needsLlm: true });

      files.push({ path: "config.lua", content: `local config = require("lapis.config")

config("development", function()
  port(10080)
end)

config("production", function()
  port(10080)
  code_cache("on")
end)
`, needsLlm: false });

    } else {
      files.push({ path: "app.lua", content: `-- ${cfg.name} -- OpenResty server

local cjson = require("cjson")

local _M = {}

function _M.health()
  ngx.header.content_type = "application/json"
  ngx.say(cjson.encode({ status = "ok" }))
end

function _M.index()
  ngx.header.content_type = "application/json"
  ngx.say(cjson.encode({ name = "${cfg.name}", version = "0.1.0" }))
end

-- TODO: add handlers

return _M
`, needsLlm: true });

      files.push({ path: "nginx.conf", content: `worker_processes 1;

events {
  worker_connections 1024;
}

http {
  lua_package_path "$prefix/?.lua;;";

  server {
    listen 10080;

    location /health {
      content_by_lua_block {
        require("app").health()
      }
    }

    location / {
      content_by_lua_block {
        require("app").index()
      }
    }
  }
}
`, needsLlm: false });
    }

  } else if (cfg.type === "library") {
    files.push({ path: `src/${snake}/init.lua`, content: `-- ${cfg.name} -- Lua library

local ${cap(cfg.name)} = {}
${cap(cfg.name)}.__index = ${cap(cfg.name)}
${cap(cfg.name)}._VERSION = "0.1.0"

function ${cap(cfg.name)}.new(opts)
  local self = setmetatable({}, ${cap(cfg.name)})
  self._initialized = false
  self._opts = opts or {}
  return self
end

function ${cap(cfg.name)}:setup()
  -- TODO: setup
  self._initialized = true
  return self
end

function ${cap(cfg.name)}:process(data)
  assert(self._initialized, "Not initialized. Call :setup() first.")
  -- TODO: main logic
  return data
end

return ${cap(cfg.name)}
`, needsLlm: true });

  } else if (cfg.type === "embedded") {
    files.push({ path: "main.lua", content: `-- ${cfg.name} -- Embedded Lua script

local config = {
  pin = 4,
  interval = 1000,
}

local function setup()
  -- TODO: hardware init
  print("${cfg.name} initialized")
end

local function loop()
  -- TODO: main loop
  print("tick")
end

-- Entry
setup()
while true do
  loop()
  -- TODO: replace with platform sleep
end
`, needsLlm: true });

  } else {
    // script (default)
    files.push({ path: "main.lua", content: `-- ${cfg.name} -- Lua script

local function parse_args(args)
  local opts = { verbose = false }
  local positional = {}
  for i = 1, #args do
    if args[i] == "-v" or args[i] == "--verbose" then
      opts.verbose = true
    else
      table.insert(positional, args[i])
    end
  end
  return opts, positional
end

local function main(args)
  local opts, positional = parse_args(args)

  if #positional == 0 then
    print("Usage: lua main.lua [options] <input>")
    print("  -v, --verbose  Enable verbose output")
    os.exit(1)
  end

  if opts.verbose then
    print("Processing: " .. positional[1])
  end

  -- TODO: implement logic

  print("Done!")
end

main(arg)
`, needsLlm: true });
  }

  // Busted tests
  files.push({ path: "spec/main_spec.lua", content: `describe("${cfg.name}", function()
  it("works", function()
    assert.is_true(true)
  end)

  -- TODO: add tests
end)
`, needsLlm: true });

  // .luacheckrc
  files.push({ path: ".luacheckrc", content: `std = "lua51+lua52+lua53"
${cfg.type === "game" ? 'globals = { "love" }\n' : ""}${cfg.type === "neovim" ? 'read_globals = { "vim" }\n' : ""}${cfg.type === "roblox" ? 'read_globals = { "game", "script", "workspace", "Instance" }\n' : ""}max_line_length = 120
ignore = { "212" }
`, needsLlm: false });

  // Makefile
  const runCmd = cfg.type === "game" ? "\tlove ." : cfg.type === "server" && cfg.framework === "lapis" ? "\tlapis server" : cfg.type === "server" ? "\topenresty -p . -c nginx.conf" : "\tlua main.lua";
  const lintTarget = cfg.type === "game" || cfg.type === "script" || cfg.type === "embedded" ? "main.lua" : "src/";
  files.push({ path: "Makefile", content: `.PHONY: test lint run install

test:
\tbusted spec/

lint:
\tluacheck ${lintTarget} spec/

run:
${runCmd}

install:
\tluarocks install --only-deps ${snake}-0.1.0-1.rockspec
`, needsLlm: false });

  // Extras
  files.push({ path: ".gitignore", content: `*.rock\n*.src.rock\nluarocks/\n.luarocks/\nlua_modules/\n.env\n*.o\n*.so\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nLua ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. Built with KCode.\n\n\`\`\`bash\nluarocks install --only-deps ${snake}-0.1.0-1.rockspec\nmake run\nmake test\n\`\`\`\n\n*Astrolexis.space -- Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement Lua ${cfg.type}${cfg.framework ? " (" + cfg.framework + ")" : ""}. ${m} files machine. USER: "${userRequest}"` };
}

function cap(s: string): string { return s.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(""); }
