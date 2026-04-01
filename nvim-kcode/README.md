# nvim-kcode

Neovim plugin for [KCode](https://github.com/astrolexis/kcode) -- a terminal-based AI coding assistant supporting local LLMs and cloud APIs.

Communicates with the KCode HTTP API to provide chat, code explanations, fixes, reviews, and test generation directly inside Neovim.

## Requirements

- Neovim >= 0.9
- `curl` available on PATH
- KCode installed and running its HTTP server:
  ```bash
  kcode serve
  ```

## Installation

### lazy.nvim

```lua
{
  "astrolexis/nvim-kcode",
  config = function()
    require("kcode").setup({
      -- server_url = "http://localhost:10091",
    })
  end,
}
```

### packer.nvim

```lua
use {
  "astrolexis/nvim-kcode",
  config = function()
    require("kcode").setup()
  end,
}
```

### vim-plug

```vim
Plug 'astrolexis/nvim-kcode'

" In your init.vim / init.lua:
lua require("kcode").setup()
```

## Configuration

All options and their defaults:

```lua
require("kcode").setup({
  -- KCode HTTP API server URL (must match `kcode serve` address)
  server_url = "http://localhost:10091",

  -- Override the default model (empty = use server default)
  model = "",

  -- Working directory sent with prompts (empty = Neovim cwd)
  cwd = "",

  -- Chat split direction: "vertical" | "horizontal"
  split = "vertical",

  -- Chat split size (columns for vertical, rows for horizontal)
  split_size = 80,

  -- Timeout in seconds for non-streaming requests
  timeout = 30,

  -- Automatically include current file as context in code actions
  auto_attach_file = true,

  -- Syntax highlighting in chat buffer (uses markdown filetype)
  chat_syntax = true,

  -- Default keymaps (set individual keys to false to disable)
  keymaps = {
    chat_toggle = "<leader>kc",  -- Toggle chat window
    explain     = "<leader>ke",  -- Explain selected code
    fix         = "<leader>kf",  -- Fix selected code
    review      = "<leader>kr",  -- Review selected code
    tests       = "<leader>kt",  -- Generate tests for selection
  },
})
```

To disable all default keymaps:

```lua
require("kcode").setup({
  keymaps = false,
})
```

## Commands

| Command | Description |
|---|---|
| `:KCode [message]` | Toggle chat, or send a message |
| `:KCodeChat [message]` | Open chat window, optionally send a message |
| `:KCodeExplain` | Explain visually selected code |
| `:KCodeFix` | Fix/improve visually selected code |
| `:KCodeReview` | Code review visually selected code |
| `:KCodeTests` | Generate tests for visually selected code |
| `:KCodeHealth` | Check KCode server connectivity |

## Suggested Keybindings

The plugin sets default keymaps via the `keymaps` config option. You can override them or add your own:

```lua
-- Example: custom keymaps
vim.keymap.set("n", "<C-k>",     function() require("kcode.chat").toggle() end, { desc = "KCode chat" })
vim.keymap.set("v", "<C-k>e",    function() require("kcode.actions").explain_selection() end, { desc = "KCode explain" })
vim.keymap.set("v", "<C-k>f",    function() require("kcode.actions").fix_selection() end, { desc = "KCode fix" })
vim.keymap.set("v", "<C-k>r",    function() require("kcode.actions").review_selection() end, { desc = "KCode review" })
vim.keymap.set("v", "<C-k>t",    function() require("kcode.actions").generate_tests() end, { desc = "KCode tests" })
```

## Usage

1. Start the KCode server in a terminal:
   ```bash
   kcode serve
   ```

2. Open Neovim and run `:KCodeHealth` to verify connectivity.

3. Use `:KCode` or `<leader>kc` to open the chat window.

4. Select code in visual mode and run `:KCodeExplain`, `:KCodeFix`, `:KCodeReview`, or `:KCodeTests`.

## Architecture

```
nvim-kcode/
  lua/kcode/
    init.lua      -- Plugin entry point, setup(), command registration
    config.lua    -- Configuration defaults and merge logic
    chat.lua      -- Chat buffer, streaming SSE via curl, session management
    actions.lua   -- Code actions (explain, fix, review, tests)
  plugin/
    kcode.vim     -- Auto-load Vim commands (works before setup)
```

The plugin communicates with the KCode HTTP API (`/api/prompt`, `/api/health`) using `curl` via `vim.fn.jobstart` (async streaming) and `vim.fn.system` (synchronous). Responses are streamed as Server-Sent Events into a markdown-highlighted split buffer.

## License

AGPL-3.0-only. Copyright Astrolexis.
