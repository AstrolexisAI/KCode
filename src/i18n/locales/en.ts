// KCode - English (base locale)

export default {
  // General
  welcome: "Welcome to KCode",
  goodbye: "Goodbye",
  error: "Error",
  warning: "Warning",
  success: "Success",
  loading: "Loading...",
  cancel: "Cancel",
  confirm: "Confirm",
  yes: "Yes",
  no: "No",
  unknown: "Unknown",

  // Session
  "session.started": "Session started",
  "session.resumed": "Session resumed",
  "session.ended": "Session ended",
  "session.cost": "Session cost: ${cost}",
  "session.tokens": "{count} tokens used",
  "session.model": "Model: {model}",
  "session.duration": "Duration: {duration}",

  // Permission
  "permission.ask": "Allow {tool} to execute?",
  "permission.allow": "Allow",
  "permission.deny": "Deny",
  "permission.always": "Always allow",
  "permission.never": "Never allow",
  "permission.bash.dangerous": "This command could be dangerous: {command}",
  "permission.edit.confirm": "Allow editing {file}?",
  "permission.write.confirm": "Allow writing {file}?",

  // Tools
  "tool.executing": "Executing {tool}...",
  "tool.completed": "{tool} completed in {duration}ms",
  "tool.error": "{tool} failed: {error}",
  "tool.cancelled": "{tool} cancelled",
  "tool.timeout": "{tool} timed out after {timeout}ms",
  "tool.notFound": "Tool not found: {tool}",

  // Compaction
  "compact.starting": "Compacting context...",
  "compact.done": "Context compacted ({strategy})",
  "compact.strategy": "Strategy: {strategy}",
  "compact.tokensSaved": "{count} tokens saved",

  // Offline
  "offline.active": "Offline mode active",
  "offline.inactive": "Offline mode inactive",
  "offline.no_model": "No local model available",
  "offline.blocked": "Blocked: {url} (offline mode active)",
  "offline.fallback": "Falling back to local model",

  // Setup
  "setup.detecting": "Detecting hardware...",
  "setup.recommended": "Recommended: {model}",
  "setup.configuring": "Configuring...",
  "setup.done": "Setup complete",
  "setup.error": "Setup error: {error}",
  "setup.gpu.detected": "GPU detected: {gpu}",
  "setup.gpu.none": "No GPU detected",
  "setup.ram.detected": "RAM: {ram}GB",

  // Plugin
  "plugin.installing": "Installing {name}...",
  "plugin.installed": "{name} v{version} installed",
  "plugin.removed": "{name} removed",
  "plugin.error": "Plugin error: {error}",
  "plugin.validating": "Validating plugin...",
  "plugin.publishing": "Publishing plugin...",
  "plugin.updated": "{name} updated to v{version}",

  // Search
  "search.results": "{count} results found",
  "search.no_results": "No results found",
  "search.searching": "Searching...",
  "search.indexed": "{count} files indexed",

  // Git
  "git.committing": "Creating commit...",
  "git.committed": "Committed: {hash}",
  "git.pushing": "Pushing to remote...",
  "git.pushed": "Pushed to {branch}",
  "git.status.clean": "Working tree clean",
  "git.status.dirty": "{count} files changed",

  // Doctor
  "doctor.checking": "Running diagnostics...",
  "doctor.passed": "All checks passed",
  "doctor.warning": "{count} warnings found",
  "doctor.failed": "{count} issues found",

  // Memory
  "memory.saved": "Memory saved: {title}",
  "memory.updated": "Memory updated: {title}",
  "memory.deleted": "Memory deleted: {title}",
  "memory.listing": "Listing memories...",

  // Plan
  "plan.created": "Plan created: {title}",
  "plan.updated": "Plan updated",
  "plan.step.completed": "Step completed: {step}",
  "plan.step.failed": "Step failed: {step}",

  // Plurals
  "files.one": "{count} file",
  "files.other": "{count} files",
  "sessions.one": "{count} session",
  "sessions.other": "{count} sessions",
  "tokens.one": "{count} token",
  "tokens.other": "{count} tokens",
  "plugins.one": "{count} plugin",
  "plugins.other": "{count} plugins",
  "errors.one": "{count} error",
  "errors.other": "{count} errors",
  "tests.one": "{count} test",
  "tests.other": "{count} tests",

  // Dashboard
  "dashboard.tests.passing": "{count} tests passing",
  "dashboard.tests.failing": "{count} tests failing",
  "dashboard.todos": "{count} TODOs pending",
  "dashboard.coverage": "{coverage}% coverage",

  // Stats
  "stats.title": "Statistics",
  "stats.sessions": "Sessions: {count}",
  "stats.tools": "Tool calls: {count}",
  "stats.tokens": "Tokens: {count}",
  "stats.cost": "Cost: ${cost}",
  "stats.period": "Period: last {days} days",
};
