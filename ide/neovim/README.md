# KCode Neovim Plugin

AI coding assistant integration for Neovim, connecting to the KCode HTTP API.

## Requirements

- Neovim 0.8+ (0.10+ recommended for async support)
- `curl` installed and available in PATH
- KCode server running (`kcode serve` or `kcode server`)

## Installation

### lazy.nvim

```lua
{
  "astrolexis/kcode",
  config = function()
    require("kcode").setup({
      server_url = "http://localhost:10091",
    })
  end,
}
```

### packer.nvim

```lua
use {
  "astrolexis/kcode",
  config = function()
    require("kcode").setup()
  end,
}
```

### vim-plug

```vim
Plug 'astrolexis/kcode'
```

Then in your `init.lua`:

```lua
require("kcode").setup()
```

## Configuration

```lua
require("kcode").setup({
  -- KCode server URL
  server_url = "http://localhost:10091",

  -- API key (if authentication is enabled)
  api_key = "",

  -- Automatically check connection on startup
  auto_connect = true,

  -- Keymaps (set to false to disable all, or set individual keys to false)
  keymaps = {
    ask = "<leader>ka",       -- Normal mode: open prompt
    explain = "<leader>ke",   -- Visual mode: explain selection
    commit = "<leader>kc",    -- Normal mode: generate commit message
    test = "<leader>kt",      -- Normal/Visual mode: generate tests
  },

  -- UI display options
  ui = {
    border = "rounded",       -- Border style: "rounded", "single", "double", "none"
    width = 0.6,              -- Float window width (percentage of screen)
    height = 0.6,             -- Float window height (percentage of screen)
    position = "float",       -- Display mode: "float", "split", "vsplit"
  },
})
```

## Commands

| Command | Description |
|---------|-------------|
| `:KCode [prompt]` | Ask KCode a question. If no prompt given, opens an input dialog. |
| `:KCodeExplain` | Explain the visually selected code. |
| `:KCodeCommit` | Generate a commit message from the current git diff. |
| `:KCodeTest` | Generate tests for the selection or current file. |
| `:KCodeStatus` | Check KCode server connection status. |
| `:KCodeModels` | List available models. |

## Default Keymaps

| Key | Mode | Action |
|-----|------|--------|
| `<leader>ka` | Normal | Ask KCode |
| `<leader>ke` | Visual | Explain selection |
| `<leader>kc` | Normal | Generate commit message |
| `<leader>kt` | Normal/Visual | Generate tests |

All keymaps can be customized or disabled in the setup configuration.

## How It Works

The plugin communicates with the KCode HTTP API server. Make sure KCode is running before using the plugin:

```bash
# Start the KCode HTTP API server
kcode serve

# Or start KCode with the server flag
kcode --serve
```

Responses are displayed in a floating window (default) with markdown syntax highlighting. Press `q` or `<Esc>` to close the response window.

## License

AGPL-3.0-only. Copyright Astrolexis.
