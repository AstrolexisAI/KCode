# KCode - VS Code Extension

Local AI coding assistant powered by KCode and your own GPU.

## Features

- **Sidebar Chat**: Conversational AI assistant in the VS Code sidebar
- **Context Menu Actions**: Right-click selected code to Explain, Fix, or Generate Tests
- **Terminal Integration**: Open KCode in an interactive terminal
- **Keyboard Shortcut**: `Ctrl+Shift+K` (`Cmd+Shift+K` on Mac) to send a prompt

## Requirements

- [KCode CLI](https://github.com/astrolexis/kcode) installed and available in PATH (or configure `kcode.binaryPath`)
- A local LLM backend (Ollama, llama.cpp, etc.)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `kcode.binaryPath` | `kcode` | Path to the KCode binary |
| `kcode.model` | (empty) | Override the default model |
| `kcode.permissionMode` | `acceptEdits` | Permission mode: ask, auto, plan, deny, acceptEdits |

## Development

```bash
cd vscode-extension
npm install
npm run compile
```

Press F5 in VS Code to launch the Extension Development Host.

## Packaging

```bash
npm run package
```

This produces a `.vsix` file you can install with `code --install-extension kcode-0.1.0.vsix`.
