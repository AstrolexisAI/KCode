// KCode - Shell Completion Generator
// Generates completion scripts for bash, zsh, and fish.

export type Shell = "bash" | "zsh" | "fish";

export interface CompletionSpec {
  subcommands: Array<{ name: string; description: string }>;
  globalFlags: Array<{ name: string; short?: string; description: string; takesValue: boolean }>;
}

// ─── Main generator ────────────────────────────────────────────

export function generateCompletions(shell: Shell, spec: CompletionSpec): string {
  switch (shell) {
    case "bash":
      return generateBashCompletions(spec);
    case "zsh":
      return generateZshCompletions(spec);
    case "fish":
      return generateFishCompletions(spec);
  }
}

// ─── Default spec from KCode CLI ───────────────────────────────

export function getDefaultSpec(): CompletionSpec {
  return {
    subcommands: [
      { name: "models", description: "Manage AI models" },
      { name: "setup", description: "Initial setup wizard" },
      { name: "server", description: "Manage local inference server" },
      { name: "pro", description: "KCode Pro license management" },
      { name: "stats", description: "Show usage statistics" },
      { name: "doctor", description: "Diagnose environment issues" },
      { name: "teach", description: "Teach KCode about your project" },
      { name: "init", description: "Initialize project configuration" },
      { name: "new", description: "Create a new project from description" },
      { name: "resume", description: "Resume a previous session" },
      { name: "search", description: "Search past conversations" },
      { name: "watch", description: "Watch mode for file changes" },
      { name: "update", description: "Update KCode to latest version" },
      { name: "benchmark", description: "Run model benchmarks" },
      { name: "completions", description: "Generate shell completions" },
      { name: "history", description: "Browse session history" },
      { name: "serve", description: "Start HTTP API server" },
      { name: "remote", description: "Connect to remote KCode instance" },
      { name: "daemon", description: "Run as background daemon" },
      { name: "mesh", description: "P2P agent mesh operations" },
      { name: "distill", description: "Distill model knowledge" },
      { name: "dashboard", description: "Show project dashboard" },
      { name: "template", description: "Smart project templates" },
      { name: "plugin", description: "Manage plugins" },
      { name: "mcp", description: "Manage MCP servers" },
    ],
    globalFlags: [
      { name: "--model", short: "-m", description: "Override AI model", takesValue: true },
      { name: "--permission", short: "-p", description: "Permission mode", takesValue: true },
      { name: "--continue", short: "-c", description: "Continue last session", takesValue: false },
      { name: "--print", description: "Print mode (no UI)", takesValue: false },
      { name: "--thinking", description: "Enable extended thinking", takesValue: false },
      { name: "--voice", description: "Enable voice input", takesValue: false },
      { name: "--effort", description: "Reasoning effort level", takesValue: true },
      { name: "--theme", description: "Set color theme", takesValue: true },
      { name: "--sandbox", description: "Run in sandbox mode", takesValue: false },
      { name: "--offline", description: "Force offline mode", takesValue: false },
      { name: "--verbose", description: "Verbose output", takesValue: false },
      { name: "--version", short: "-v", description: "Show version", takesValue: false },
      { name: "--help", short: "-h", description: "Show help", takesValue: false },
    ],
  };
}

// ─── Bash ──────────────────────────────────────────────────────

function generateBashCompletions(spec: CompletionSpec): string {
  const cmds = spec.subcommands.map((c) => c.name).join(" ");
  const flags = spec.globalFlags.map((f) => f.name).join(" ");
  const shorts = spec.globalFlags
    .filter((f) => f.short)
    .map((f) => f.short)
    .join(" ");

  return `# KCode Bash Completions
# Add to ~/.bashrc: eval "$(kcode completions bash)"

_kcode_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local prev=\${COMP_WORDS[COMP_CWORD-1]}

  # Subcommands
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${cmds}" -- "$cur"))
    return
  fi

  # Flags
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${flags} ${shorts}" -- "$cur"))
    return
  fi

  # Permission mode values
  if [[ "$prev" == "--permission" || "$prev" == "-p" ]]; then
    COMPREPLY=($(compgen -W "ask auto plan deny acceptEdits" -- "$cur"))
    return
  fi

  # Effort level values
  if [[ "$prev" == "--effort" ]]; then
    COMPREPLY=($(compgen -W "low medium high max" -- "$cur"))
    return
  fi

  # Default to file completion
  COMPREPLY=($(compgen -f -- "$cur"))
}

complete -F _kcode_completions kcode
`;
}

// ─── Zsh ───────────────────────────────────────────────────────

function generateZshCompletions(spec: CompletionSpec): string {
  let output = `#compdef kcode
# KCode Zsh Completions
# Add to ~/.zshrc: eval "$(kcode completions zsh)"
# Or save to a file in your fpath: kcode completions zsh > ~/.zsh/completions/_kcode

_kcode() {
  local -a subcommands
  subcommands=(
`;

  for (const cmd of spec.subcommands) {
    const desc = cmd.description.replace(/'/g, "'\\''");
    output += `    '${cmd.name}:${desc}'\n`;
  }

  output += `  )

  local -a global_flags
  global_flags=(
`;

  for (const flag of spec.globalFlags) {
    const desc = flag.description.replace(/'/g, "'\\''");
    if (flag.takesValue) {
      output += `    '${flag.name}[${desc}]:value:'\n`;
    } else {
      output += `    '${flag.name}[${desc}]'\n`;
    }
    if (flag.short) {
      output += `    '${flag.short}[${desc}]'\n`;
    }
  }

  output += `  )

  _arguments -C \\
    $global_flags \\
    '1:command:->command' \\
    '*::arg:->args'

  case "$state" in
    command)
      _describe "kcode commands" subcommands
      ;;
    args)
      case \${words[1]} in
        completions)
          _values 'shell' bash zsh fish
          ;;
        template)
          _values 'action' list show create add remove
          ;;
        *)
          _files
          ;;
      esac
      ;;
  esac
}

_kcode "$@"
`;

  return output;
}

// ─── Fish ──────────────────────────────────────────────────────

function generateFishCompletions(spec: CompletionSpec): string {
  let output = `# KCode Fish Completions
# Save to: ~/.config/fish/completions/kcode.fish
# Or run: kcode completions fish | source

# Disable file completions by default
complete -c kcode -f

# Subcommands
`;

  for (const cmd of spec.subcommands) {
    const desc = cmd.description.replace(/"/g, '\\"');
    output += `complete -c kcode -n "__fish_use_subcommand" -a "${cmd.name}" -d "${desc}"\n`;
  }

  output += "\n# Global flags\n";

  for (const flag of spec.globalFlags) {
    const desc = flag.description.replace(/"/g, '\\"');
    const longName = flag.name.replace(/^--/, "");
    const shortOpt = flag.short ? ` -s ${flag.short.replace(/^-/, "")}` : "";
    const requiresArg = flag.takesValue ? " -r" : "";
    output += `complete -c kcode -l "${longName}"${shortOpt}${requiresArg} -d "${desc}"\n`;
  }

  // Completions subcommand
  output += `\n# completions subcommand\n`;
  output += `complete -c kcode -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"\n`;

  // Permission values
  output += `\n# Permission mode values\n`;
  output += `complete -c kcode -n "__fish_seen_subcommand_from --permission -p" -a "ask auto plan deny acceptEdits"\n`;

  // Effort values
  output += `complete -c kcode -n "__fish_seen_subcommand_from --effort" -a "low medium high max"\n`;

  return output;
}
