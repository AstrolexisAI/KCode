import type { Command } from "commander";

export function registerCompletionsCommand(program: Command): void {
  program
    .command("completions <shell>")
    .description("Generate shell completion script (bash or zsh)")
    .action((shell: string) => {
      if (shell === "bash") {
        console.log(`# KCode bash completion - add to ~/.bashrc:
# eval "$(kcode completions bash)"

_kcode_completions() {
  local cur prev commands subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="models setup server activate pro stats doctor teach init resume search watch new update benchmark completions serve history"

  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  case "$prev" in
    models)
      COMPREPLY=( $(compgen -W "list add remove set-default" -- "$cur") )
      ;;
    new)
      COMPREPLY=( $(compgen -W "api cli web library" -- "$cur") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -f -- "$cur") )
      ;;
  esac
}
complete -F _kcode_completions kcode`);
      } else if (shell === "zsh") {
        console.log(`#compdef kcode
# KCode zsh completion - add to ~/.zshrc:
# eval "$(kcode completions zsh)"

_kcode() {
  local -a commands
  commands=(
    'models:Manage registered LLM models'
    'setup:Run the setup wizard'
    'server:Manage local inference server'
    'init:Initialize a new project'
    'resume:List and resume sessions'
    'search:Search session transcripts'
    'watch:Watch for file changes'
    'new:Create project from template'
    'update:Check for updates'
    'benchmark:Show benchmark results'
    'completions:Generate shell completions'
    'serve:Start HTTP API server'
    'history:Browse session history'
  )

  _arguments -C \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        models)
          _values 'subcommand' list add remove set-default
          ;;
        new)
          _values 'template' api cli web library
          ;;
        completions)
          _values 'shell' bash zsh
          ;;
        *)
          _files
          ;;
      esac
      ;;
  esac
}

_kcode`);
      } else {
        console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
        process.exit(1);
      }
    });
}
