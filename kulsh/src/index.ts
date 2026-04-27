#!/usr/bin/env bun
import * as readline from 'readline';
import { execute } from './executor.js';
import { history } from './history.js';
import { env } from './env.js';
import { completer } from './completer.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: completer,
  terminal: true,
  prompt: 'kulsh> ',
});

let isRunning = true;

// Load history
history.load();

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\n^C');
  rl.prompt();
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM. Saving history...');
  history.save();
  process.exit(0);
});

function parseArgs(): void {
  const args = process.argv.slice(2);
  
  if (args[0] === '-c' && args[1]) {
    // Non-interactive: kulsh -c "command"
    execute(args[1]);
    process.exit(0);
  } 
  else if (args.length === 1 && args[0].endsWith('.ksh')) {
    // TODO: Execute script file line by line
    console.error('Script execution (.ksh) not yet implemented.');
    process.exit(1);
  }
}

function startREPL(): void {
  console.log('🐚 kulsh — Minimal KULVEX Shell (v0.1.0)');
  console.log('Type "exit" or Ctrl+D to quit. "kulvex status" for system info.\n');

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (trimmed) {
      history.add(trimmed);
      execute(trimmed);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    history.save();
    console.log('\n👋 Goodbye from kulsh!');
    process.exit(0);
  });

  rl.prompt();
}

// Handle non-interactive mode
if (process.argv.length > 2) {
  parseArgs();
} else {
  startREPL();
}