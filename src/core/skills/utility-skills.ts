// KCode - Text/data/misc utility skills

import type { SkillDefinition } from "../builtin-skills";

export const utilitySkills: SkillDefinition[] = [
  {
    name: "context",
    description: "Show context window usage",
    aliases: ["ctx", "tokens"],
    args: [],
    template: `__builtin_context__`,
  },
  {
    name: "telemetry",
    description: "Show or toggle anonymous analytics opt-in",
    aliases: [],
    template: `__builtin_telemetry__`,
  },
  {
    name: "models",
    description: "List registered models",
    aliases: ["model"],
    template: `__builtin_models__`,
  },
  {
    name: "change-review",
    description: "Review working tree changes with risk classification and suggestions",
    aliases: ["cr", "review-changes"],
    args: ["--staged (optional, review only staged changes)"],
    template: `__builtin_change_review__`,
  },
  {
    name: "gallery",
    description: "Browse prompt templates by category with previews",
    aliases: ["templates-gallery", "tpl-browse"],
    args: [],
    template: `__builtin_gallery__`,
  },
  {
    name: "project-cost",
    description: "Project estimated cost for N more messages",
    aliases: ["cost-forecast", "forecast"],
    args: ["number of messages"],
    template: `__builtin_project_cost__`,
  },
  {
    name: "workspace",
    description: "Switch working directory without restarting",
    aliases: ["cwd", "cd"],
    args: ["directory path"],
    template: `__builtin_workspace__`,
  },
  {
    name: "filesize",
    description: "Show files sorted by size with visual bars",
    aliases: ["sizes", "du"],
    args: ["glob pattern (default: **/*.*)"],
    template: `__builtin_filesize__`,
  },
  {
    name: "contributors",
    description: "Show git contributor stats",
    aliases: ["authors", "who-wrote"],
    args: [],
    template: `__builtin_contributors__`,
  },
  {
    name: "regex",
    description: "Test a regex against text or a file",
    aliases: ["rx", "regexp"],
    args: ["pattern text-or-file"],
    template: `__builtin_regex__`,
  },
  {
    name: "processes",
    description: "List project-related running processes",
    aliases: ["ps", "procs"],
    args: [],
    template: `Show running processes filtered by developer-relevant programs.

Run: ps aux | grep -E '(node|bun|python|deno|java|go |ruby|cargo|docker|nginx|postgres|mysql|redis|mongod|ollama|llama)' | grep -v grep

Format the output as a clean table showing PID, CPU%, MEM%, and command. Highlight any processes using high CPU or memory.`,
  },
  {
    name: "filediff",
    description: "Compare two files with unified diff",
    aliases: ["fdiff", "compare-files"],
    args: ["file1 file2"],
    template: `__builtin_filediff__`,
  },
  {
    name: "crons",
    description: "List user crontabs and systemd timers",
    aliases: ["schedules", "timers"],
    args: [],
    template: `__builtin_crons__`,
  },
  {
    name: "ports",
    description: "Show ports in use with associated processes",
    aliases: ["listening", "netstat"],
    args: [],
    template: `__builtin_ports__`,
  },
  {
    name: "tags",
    description: "List, create, or compare git tags",
    aliases: ["tag", "releases"],
    args: ["list | create <name> [message] | log <tag1>..<tag2>"],
    template: `__builtin_tags__`,
  },
  {
    name: "file-history",
    description: "Show commit history for a specific file",
    aliases: ["fhist", "file-log"],
    args: ["file path"],
    template: `__builtin_file_history__`,
  },
  {
    name: "copy",
    description: "Copy text or file content to system clipboard",
    aliases: ["clip-copy", "yank"],
    args: ["text or file path"],
    template: `__builtin_copy__`,
  },
  {
    name: "json",
    description: "Parse, validate, and inspect JSON files or text",
    aliases: ["json-inspect", "jq"],
    args: ["file path or JSON text"],
    template: `__builtin_json__`,
  },
  {
    name: "disk",
    description: "Show project disk usage by directory",
    aliases: ["disk-usage", "space"],
    args: [],
    template: `__builtin_disk__`,
  },
  {
    name: "http",
    description: "Make quick HTTP requests (GET/POST)",
    aliases: ["curl", "request"],
    args: ["[GET|POST|PUT|DELETE] <url> [body]"],
    template: `__builtin_http__`,
  },
  {
    name: "encode",
    description: "Encode/decode Base64, URL, or hex",
    aliases: ["decode", "base64"],
    args: ["base64|url|hex encode|decode <text>"],
    template: `__builtin_encode__`,
  },
  {
    name: "checksum",
    description: "Generate checksums for files or text",
    aliases: ["hash", "sha"],
    args: ["[md5|sha256|sha512] <file or text>"],
    template: `__builtin_checksum__`,
  },
  {
    name: "weather",
    description: "Show current weather in terminal",
    aliases: ["wttr"],
    args: ["city (optional)"],
    template: `Show weather for: {{args}}. IMPORTANT: The city name must contain only letters, spaces, hyphens, and periods. Sanitize before using in any command. Reject input containing shell metacharacters.

{{#if args}}After validating the city name, run: curl -s "wttr.in/<sanitized city>?format=3"{{/if}}
{{^if args}}Run: curl -s "wttr.in/?format=3"{{/if}}

If the user wants more detail, also run: curl -s "wttr.in/<sanitized city>" for the full forecast. Display the result as-is since wttr.in outputs nicely formatted text.`,
  },
  {
    name: "lorem",
    description: "Generate placeholder text",
    aliases: ["placeholder", "filler"],
    args: ["words|sentences|paragraphs [count]"],
    template: `__builtin_lorem__`,
  },
  {
    name: "uuid",
    description: "Generate random UUIDs (v4)",
    aliases: ["guid", "id"],
    args: ["count (default: 1)"],
    template: `Generate random UUID(s).

{{#if args}}Generate {{args}} UUIDs.{{/if}}
{{^if args}}Generate 1 UUID.{{/if}}

Try: uuidgen (run it N times, one per line). If uuidgen is not available, use: node -e "for(let i=0;i<N;i++) console.log(crypto.randomUUID())"

Display each UUID on its own line.`,
  },
  {
    name: "color",
    description: "Convert between color formats (hex/rgb/hsl)",
    aliases: ["hex-color", "rgb"],
    args: ["color value (#fff, rgb(…), hsl(…))"],
    template: `__builtin_color__`,
  },
  {
    name: "timestamp",
    description: "Convert between epoch and human-readable dates",
    aliases: ["epoch", "unixtime"],
    args: ["epoch seconds or date string (optional)"],
    template: `__builtin_timestamp__`,
  },
  {
    name: "csv",
    description: "Inspect CSV/TSV files with tabular preview",
    aliases: ["tsv", "table"],
    args: ["file path"],
    template: `__builtin_csv__`,
  },
  {
    name: "ip",
    description: "Show public IP, local IP, and network interfaces",
    aliases: ["myip", "network"],
    args: [],
    template: `__builtin_ip__`,
  },
  {
    name: "count",
    description: "Count lines, words, chars, and files by extension",
    aliases: ["wc", "lines"],
    args: ["file or directory (default: .)"],
    template: `__builtin_count__`,
  },
  {
    name: "random",
    description: "Generate random numbers, roll dice, or pick from list",
    aliases: ["rand", "dice"],
    args: ["[min-max | NdM | item1,item2,...]"],
    template: `__builtin_random__`,
  },
  {
    name: "diff-stats",
    description: "Show repository activity summary and stats",
    aliases: ["gitstats", "repo-stats"],
    args: [],
    template: `__builtin_diff_stats__`,
  },
  {
    name: "serve",
    description: "Serve current directory as static HTTP",
    aliases: ["preview", "static"],
    args: ["port (default: 10080)"],
    template: `Start a static HTTP server for the current directory.

{{#if args}}Use port {{args}}.{{/if}}
{{^if args}}Use port 10080.{{/if}}

Try in order:
1. python3 -m http.server PORT (most commonly available)
2. npx serve -l PORT (if Node.js/npm available)
3. bun serve (if in a Bun project)

Run the server in the background. Report the URL (http://localhost:PORT) to the user.`,
  },
  {
    name: "open",
    description: "Open file or URL in system application",
    aliases: ["browse", "xdg"],
    args: ["file path or URL"],
    template: `__builtin_open__`,
  },
  {
    name: "qr",
    description: "Generate QR code in terminal",
    aliases: ["qrcode"],
    args: ["text or URL"],
    template: `Generate a QR code in the terminal for: {{args}}. IMPORTANT: Validate the input contains only alphanumeric characters, common URL characters (:/.-_~?&=%+#@), and spaces. Strip or reject any shell metacharacters before using in commands.

Try in order:
1. qrencode -t ANSI "<sanitized input>" (if qrencode is installed)
2. node -e "..." using a simple QR generation approach with the sanitized input
3. curl "https://qrencode.org/api/?text=<url-encoded sanitized input>" as last resort

Display the QR code directly in the terminal output.`,
  },
  {
    name: "calc",
    description: "Evaluate math expressions safely",
    aliases: ["math", "eval"],
    args: ["expression"],
    template: `Evaluate: {{args}}. IMPORTANT: Validate the expression contains only numbers, operators (+, -, *, /, %, **), parentheses, decimal points, and math functions (Math.sqrt, Math.PI, etc.) before executing. Never pass raw user input to shell commands.

Use: node -e "console.log(<sanitized expression>)" for basic arithmetic.
For more complex math, use: python3 -c "import math; print(<sanitized expression>)"

Display the result clearly. If the expression is invalid or contains non-math characters, explain the error instead of executing.`,
  },
  {
    name: "stopwatch",
    description: "Start a countdown timer",
    aliases: ["timer", "sw"],
    args: ["duration (e.g., 30s, 5m, 1h)"],
    template: `Start a timer/stopwatch.

{{#if args}}Parse the duration "{{args}}" (e.g., 30s, 5m, 1h) and run a countdown using: sleep <seconds> then notify the user when time is up.{{/if}}
{{^if args}}Start a stopwatch by recording the start time. Use: date +%s to get epoch. Show elapsed time when the user asks to stop.{{/if}}

Display the duration clearly when complete. Use terminal bell (echo -e '\\a') to alert when the timer finishes.`,
  },
  {
    name: "password",
    description: "Generate secure random passwords",
    aliases: ["passwd", "pwgen"],
    args: ["[length] [--no-symbols] [--count N]"],
    template: `Generate secure random password(s).

{{#if args}}Parse options from: {{args}} — look for length (number), --no-symbols, --count N.{{/if}}
{{^if args}}Default: 1 password, 20 characters, with symbols.{{/if}}

Use: node -e "const crypto=require('crypto');const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';let p='';const bytes=crypto.randomBytes(LENGTH);for(let i=0;i<LENGTH;i++)p+=c[bytes[i]%c.length];console.log(p)"

Or use: openssl rand -base64 LENGTH | head -c LENGTH

Display each password on its own line. Warn that passwords are shown in plain text.`,
  },
  {
    name: "mirrors",
    description: "Show and manage git remotes",
    aliases: ["remotes", "upstream"],
    args: ["list | add <name> <url> | remove <name>"],
    template: `__builtin_mirrors__`,
  },
  {
    name: "sort-lines",
    description: "Sort lines of a file",
    aliases: ["sort", "sortfile"],
    args: ["file [--reverse] [--numeric] [--unique]"],
    template: `__builtin_sort_lines__`,
  },
  {
    name: "montecarlo",
    description: "Run Monte Carlo simulations",
    aliases: ["simulate", "mc"],
    args: ["pi | coin [N] | dice NdM [N]"],
    template: `__builtin_montecarlo__`,
  },
  {
    name: "ascii",
    description: "Convert text to ASCII art",
    aliases: ["art", "figlet"],
    args: ["text"],
    template: `__builtin_ascii__`,
  },
  {
    name: "crontab",
    description: "Parse cron expressions and show next runs",
    aliases: ["cron-parse", "schedule"],
    args: ["cron expression (e.g., '*/5 * * * *')"],
    template: `__builtin_crontab__`,
  },
  {
    name: "diff-lines",
    description: "Compare two strings side by side",
    aliases: ["ldiff", "line-diff"],
    args: ["string1 | string2"],
    template: `__builtin_diff_lines__`,
  },
  {
    name: "sysinfo",
    description: "Show system hardware and OS info",
    aliases: ["hw", "machine"],
    args: [],
    template: `__builtin_sysinfo__`,
  },
  {
    name: "progress",
    description: "Generate visual progress bars",
    aliases: ["bar", "pbar"],
    args: ["value [max] [label]"],
    template: `__builtin_progress__`,
  },
  {
    name: "jwt",
    description: "Decode JWT tokens (header + payload)",
    aliases: ["token-decode", "jwt-decode"],
    args: ["JWT token string"],
    template: `__builtin_jwt__`,
  },
  {
    name: "dotenv",
    description: "Inspect and validate .env files",
    aliases: ["env-file", "secrets"],
    args: ["file path (default: .env)"],
    template: `__builtin_dotenv__`,
  },
  {
    name: "table-fmt",
    description: "Format data as aligned markdown table",
    aliases: ["markdown-table", "tbl"],
    args: ["header1,header2,... then rows via |"],
    template: `__builtin_table_fmt__`,
  },
  {
    name: "reverse",
    description: "Reverse text, lines, or words",
    aliases: ["rev", "flip"],
    args: ["text or --words or --lines"],
    template: `__builtin_reverse__`,
  },
  {
    name: "uptime-check",
    description: "Check if a URL is up (status, latency, TLS)",
    aliases: ["ping-url", "healthcheck"],
    args: ["URL"],
    template: `__builtin_uptime_check__`,
  },
  {
    name: "chmod-calc",
    description: "Convert between rwx and octal permissions",
    aliases: ["permissions", "octal"],
    args: ["octal (e.g., 755) or symbolic (e.g., rwxr-xr-x)"],
    template: `__builtin_chmod_calc__`,
  },
  {
    name: "semver",
    description: "Parse, compare, and bump semantic versions",
    aliases: ["version-bump", "ver"],
    args: ["version [bump major|minor|patch|prerelease]"],
    template: `__builtin_semver__`,
  },
  {
    name: "gitignore",
    description: "Inspect or add patterns to .gitignore",
    aliases: ["ignore", "gi"],
    args: ["[add <pattern>] or [check <file>] (default: inspect)"],
    template: `__builtin_gitignore__`,
  },
  {
    name: "wordfreq",
    description: "Analyze word frequency in text or a file",
    aliases: ["freq", "word-count"],
    args: ["text or file path [--top N]"],
    template: `__builtin_wordfreq__`,
  },
  {
    name: "network-ports",
    description: "Look up well-known network ports and services",
    aliases: ["common-ports", "port-lookup"],
    args: ["port number or service name"],
    template: `__builtin_network_ports__`,
  },
  {
    name: "wrap",
    description: "Word-wrap text to a specified column width",
    aliases: ["wordwrap", "rewrap"],
    args: ["[--width N] text (default: 80)"],
    template: `__builtin_wrap__`,
  },
  {
    name: "char-info",
    description: "Show Unicode info for characters",
    aliases: ["unicode", "charcode"],
    args: ["character(s) or U+XXXX codepoint"],
    template: `__builtin_char_info__`,
  },
  {
    name: "new-project",
    description: "Create a project from a template",
    aliases: ["scaffold", "init-project"],
    args: ["template-name project-name"],
    template: `__builtin_new_project__`,
  },
  {
    name: "slug",
    description: "Convert text to URL-safe slug",
    aliases: ["slugify", "url-slug"],
    args: ["text"],
    template: `__builtin_slug__`,
  },
  {
    name: "diff-words",
    description: "Compare two texts highlighting word differences",
    aliases: ["wdiff", "word-diff"],
    args: ["text1 | text2"],
    template: `__builtin_diff_words__`,
  },
  {
    name: "headers",
    description: "Show HTTP response headers for a URL",
    aliases: ["http-headers", "resp-headers"],
    args: ["URL"],
    template: `__builtin_headers__`,
  },
  {
    name: "extract-urls",
    description: "Extract all URLs from text or a file",
    aliases: ["urls", "find-links"],
    args: ["text or file path"],
    template: `__builtin_extract_urls__`,
  },
  {
    name: "nato",
    description: "Convert text to NATO phonetic alphabet",
    aliases: ["phonetic", "spelling"],
    args: ["text"],
    template: `__builtin_nato__`,
  },
  {
    name: "markdown-toc",
    description: "Generate table of contents from a Markdown file",
    aliases: ["toc", "headings"],
    args: ["file path"],
    template: `__builtin_markdown_toc__`,
  },
];
