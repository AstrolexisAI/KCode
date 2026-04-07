// KCode - Debug Behavior Patterns
//
// Machine-first bug detection from natural language descriptions.
// Maps user complaints to likely code patterns and search strategies.
//
// "el modal me pregunta cada vez" → repeating_behavior → search for
// missing persistent state, useEffect without deps, no localStorage/config save

export interface DebugPattern {
  id: string;
  /** Keywords that trigger this pattern (user describes the symptom) */
  triggers: RegExp;
  /** What the machine should search for */
  searchStrategy: {
    /** Grep patterns to find relevant code */
    grepPatterns: string[];
    /** File patterns to prioritize */
    fileGlobs: string[];
    /** What to look for in the matching code */
    codeSignals: Array<{ pattern: RegExp; meaning: string; likely_fix: string }>;
  };
  /** Pre-diagnosis template */
  diagnosis: string;
}

export const DEBUG_PATTERNS: DebugPattern[] = [
  // ── Repeating behavior ──────────────────────────────────────
  {
    id: "repeating-behavior",
    triggers: /\b(?:cada\s*vez|every\s*time|siempre\s*(?:pregunta|muestra|aparece)|always\s*(?:asks|shows|appears|prompts)|keeps?\s*(?:asking|showing|appearing)|repite|repeats?|again\s*and\s*again|won'?t\s*stop|no\s*para)\b/i,
    searchStrategy: {
      grepPatterns: ["useState", "useEffect", "localStorage", "sessionStorage", "settings", "config", "persist", "save", "remember", "flag", "shown"],
      fileGlobs: ["*.tsx", "*.ts", "*.jsx", "*.js"],
      codeSignals: [
        { pattern: /useEffect\s*\(\s*(?:async\s*)?\(\)\s*=>\s*\{[\s\S]*?\},\s*\[\s*\]\)/s, meaning: "useEffect runs on every mount without persistent guard", likely_fix: "Add a persistent flag (localStorage/settings) checked before showing" },
        { pattern: /useState\((?:true|false)\)/, meaning: "Boolean state resets on component mount — not persisted", likely_fix: "Persist state to localStorage/settings.json and read on init" },
        { pattern: /if\s*\([^)]*\)\s*\{[^}]*set\w+\(true\)/, meaning: "Conditional show without checking if already dismissed", likely_fix: "Add a 'dismissed' or 'confirmed' flag that persists across sessions" },
      ],
    },
    diagnosis: "The behavior repeats because the state resets on each startup. A persistent flag needs to be saved (localStorage, settings.json, or database) and checked before triggering the behavior again.",
  },

  // ── Something doesn't work / broken ────────────────────────
  {
    id: "not-working",
    triggers: /\b(?:no\s*(?:funciona|anda|sirve|works?)|doesn'?t\s*work|broken|roto|no\s*responde|unresponsive|crash|crashed|se\s*cuelga|freezes?|hang(?:s|ing)?)\b/i,
    searchStrategy: {
      grepPatterns: ["catch", "error", "throw", "reject", "null", "undefined", "panic", "fatal"],
      fileGlobs: ["*.ts", "*.tsx", "*.js", "*.py", "*.go", "*.rs"],
      codeSignals: [
        { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, meaning: "Empty catch block swallows errors silently", likely_fix: "Log the error or re-throw it" },
        { pattern: /\.then\([^)]*\)(?!\s*\.catch)/, meaning: "Promise without .catch() — unhandled rejection", likely_fix: "Add .catch() or use try/catch with await" },
        { pattern: /\basync\b[^{]*\{(?![\s\S]*?\btry\b)/, meaning: "Async function without try/catch", likely_fix: "Wrap async body in try/catch" },
        { pattern: /(?:undefined|null)\s*\.\s*\w+/, meaning: "Accessing property on null/undefined", likely_fix: "Add null check or optional chaining (?.)" },
      ],
    },
    diagnosis: "The feature fails because an error is being swallowed, a promise rejects without handler, or a null/undefined access crashes silently.",
  },

  // ── Slow / performance ─────────────────────────────────────
  {
    id: "slow-performance",
    triggers: /\b(?:lento|slow|tarda|takes?\s*(?:long|forever|mucho)|lag(?:s|gy)?|delay|demora|performance|heavy|pesado|memory\s*leak|se\s*come\s*la\s*memoria)\b/i,
    searchStrategy: {
      grepPatterns: ["for ", "while ", "forEach", "map(", "reduce(", "setInterval", "setTimeout", "useEffect", "render", "memo", "useMemo", "concat", "push"],
      fileGlobs: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.py", "*.go"],
      codeSignals: [
        { pattern: /for\s*\([^)]*\)\s*\{[\s\S]*?for\s*\([^)]*\)/, meaning: "Nested loop — O(n²) complexity", likely_fix: "Use a Map/Set for O(n) lookup, or reduce iterations" },
        { pattern: /setInterval\([^,]+,\s*\d{1,3}\)/, meaning: "setInterval with very short interval (<1s)", likely_fix: "Increase interval or use requestAnimationFrame" },
        { pattern: /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)(?!\s*,)/, meaning: "useEffect without dependency array — runs every render", likely_fix: "Add dependency array [] or [deps]" },
        { pattern: /JSON\.parse\(JSON\.stringify\(/, meaning: "Deep clone via JSON — slow for large objects", likely_fix: "Use structuredClone() or a targeted copy" },
        { pattern: /\+\s*=\s*["']|concat\(/, meaning: "String concatenation in loop — O(n²) for strings", likely_fix: "Use array.join() or template literals" },
      ],
    },
    diagnosis: "Performance issue caused by algorithmic complexity (nested loops), unnecessary re-renders, tight intervals, or inefficient data operations.",
  },

  // ── UI not updating / state not reflecting ─────────────────
  {
    id: "stale-ui",
    triggers: /\b(?:no\s*(?:se\s*)?actualiza|doesn'?t\s*update|stale|old\s*(?:data|value)|not\s*(?:refresh|updat)|desactualizado|out\s*of\s*(?:date|sync)|no\s*cambia|no\s*refleja)\b/i,
    searchStrategy: {
      grepPatterns: ["useState", "setState", "ref", "useRef", "useMemo", "useCallback", "memo", "forceUpdate", "render", "reactive", "signal"],
      fileGlobs: ["*.tsx", "*.jsx", "*.ts", "*.vue", "*.svelte"],
      codeSignals: [
        { pattern: /useRef\([^)]*\)[\s\S]{0,200}?\.current\s*=/, meaning: "useRef mutation doesn't trigger re-render", likely_fix: "Use useState instead of useRef for displayed values" },
        { pattern: /useMemo\(\s*\(\)\s*=>\s*[\s\S]*?,\s*\[\s*\]\)/, meaning: "useMemo with empty deps — value never updates", likely_fix: "Add the relevant dependencies to the array" },
        { pattern: /\blet\s+\w+\s*=\s*(?:props|state)/, meaning: "Local variable copies state — doesn't re-render on change", likely_fix: "Use the state/props directly in JSX" },
        { pattern: /mutate|\.push\(|\.splice\(|Object\.assign\(.*,/, meaning: "Direct mutation of state — React/Vue won't detect change", likely_fix: "Create new array/object: [...arr, item] or {...obj, key: val}" },
      ],
    },
    diagnosis: "UI doesn't update because state is mutated directly instead of creating new references, or memoization prevents re-computation.",
  },

  // ── Wrong data / incorrect result ──────────────────────────
  {
    id: "wrong-data",
    triggers: /\b(?:wrong|incorrecto|dato\s*equivocado|bad\s*(?:data|result|output|value)|mal|muestra\s*(?:mal|otro)|shows?\s*wrong|returns?\s*wrong|calcula\s*mal|miscalculat)\b/i,
    searchStrategy: {
      grepPatterns: ["parseInt", "parseFloat", "Number(", "toString", "toFixed", "Math.", "map(", "filter(", "find(", "reduce(", "sort(", "===", "=="],
      fileGlobs: ["*.ts", "*.js", "*.py", "*.go", "*.rs"],
      codeSignals: [
        { pattern: /==(?!=)/, meaning: "Loose equality (==) — type coercion bug", likely_fix: "Use strict equality (===)" },
        { pattern: /parseInt\([^,)]+\)(?!\s*,\s*\d)/, meaning: "parseInt without radix — may parse as octal", likely_fix: "Add radix: parseInt(val, 10)" },
        { pattern: /\.sort\(\)(?!\s*\()/, meaning: "Array.sort() without comparator — sorts as strings", likely_fix: "Add comparator: .sort((a, b) => a - b)" },
        { pattern: /toFixed\(\d\)/, meaning: "toFixed returns string, not number", likely_fix: "Wrap in Number(): Number(val.toFixed(2))" },
        { pattern: /\bawait\b[\s\S]{0,50}?\bawait\b/, meaning: "Double await — may unwrap a non-promise", likely_fix: "Check if the value is actually a Promise" },
      ],
    },
    diagnosis: "Incorrect data typically from type coercion, missing radix in parseInt, string sorting, or floating point issues.",
  },

  // ── Missing feature / not doing something ──────────────────
  {
    id: "missing-behavior",
    triggers: /\b(?:falta|missing|no\s*(?:hace|does|tiene|has)|should\s*(?:also|but)|debería|expected\s*(?:to|but)|supposed\s*to|not\s*(?:saving|sending|showing|logging|validat))\b/i,
    searchStrategy: {
      grepPatterns: ["TODO", "FIXME", "HACK", "stub", "placeholder", "implement", "skip"],
      fileGlobs: ["*.ts", "*.tsx", "*.js", "*.py", "*.go", "*.rs", "*.java"],
      codeSignals: [
        { pattern: /\/\/\s*TODO/, meaning: "Unimplemented TODO marker", likely_fix: "Implement the TODO" },
        { pattern: /return\s*;|return\s+undefined|pass\s*$/, meaning: "Empty return / pass — function does nothing", likely_fix: "Implement the function body" },
        { pattern: /\(\)\s*=>\s*\{\s*\}/, meaning: "Empty arrow function — no-op callback", likely_fix: "Implement the callback" },
      ],
    },
    diagnosis: "Feature not implemented — found TODO markers, empty functions, or no-op callbacks where behavior should exist.",
  },

  // ── Login / auth / permission ──────────────────────────────
  {
    id: "auth-issue",
    triggers: /\b(?:login|auth|permiso|permission|denied|forbidden|401|403|token|session|cookie|credentials|unauthorized|acceso|access\s*denied|no\s*puede\s*entrar|can'?t\s*(?:log\s*in|access|sign\s*in))\b/i,
    searchStrategy: {
      grepPatterns: ["auth", "token", "session", "cookie", "jwt", "bearer", "middleware", "guard", "protect", "verify", "decode", "expire"],
      fileGlobs: ["*.ts", "*.js", "*.py", "*.go", "*.rs", "*.java", "*.rb", "*.php"],
      codeSignals: [
        { pattern: /(?:token|jwt|session)\s*(?:&&|!==?\s*(?:null|undefined|""))/, meaning: "Token check may be incomplete — doesn't verify expiry", likely_fix: "Also check token expiration date" },
        { pattern: /localStorage\.getItem\(["']token/, meaning: "Token in localStorage — vulnerable to XSS", likely_fix: "Use httpOnly cookies instead" },
        { pattern: /Authorization.*Bearer/, meaning: "Bearer token auth — verify it's sent on all routes", likely_fix: "Check middleware applies to protected routes" },
      ],
    },
    diagnosis: "Auth issue — likely expired token, missing auth header, incorrect middleware order, or token not persisted correctly.",
  },

  // ── Import / dependency error ──────────────────────────────
  {
    id: "import-error",
    triggers: /\b(?:cannot\s*find\s*module|module\s*not\s*found|import\s*error|no\s*se\s*encuentra|not\s*found|resolution|resolve|require|dependency|package\s*not|unresolved|missing\s*(?:module|package|dependency))\b/i,
    searchStrategy: {
      grepPatterns: ["import ", "require(", "from ", "dependencies", "devDependencies"],
      fileGlobs: ["package.json", "tsconfig.json", "*.ts", "*.js", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt"],
      codeSignals: [
        { pattern: /from\s+["']\.\.?\/[^"']+["']/, meaning: "Relative import — check file exists at that path", likely_fix: "Verify the file path and extension" },
        { pattern: /"type"\s*:\s*"module"/, meaning: "ESM mode — requires .js extensions in imports", likely_fix: "Add .js extension to relative imports" },
        { pattern: /require\(["'][^"']+["']\)/, meaning: "CommonJS require — may conflict with ESM", likely_fix: "Use import syntax or check package.json type field" },
      ],
    },
    diagnosis: "Import error — file doesn't exist at the specified path, missing .js extension in ESM, or package not installed.",
  },

  // ── Display / visual / CSS ─────────────────────────────────
  {
    id: "visual-bug",
    triggers: /\b(?:no\s*se\s*ve|invisible|hidden|not\s*(?:visible|showing|displayed|rendering)|disappear|overlap|cortado|truncat|overflow|layout|broken\s*(?:layout|style|css)|desbordado|scroll|z-?index)\b/i,
    searchStrategy: {
      grepPatterns: ["display:", "visibility:", "opacity:", "z-index:", "overflow:", "position:", "height:", "width:", "flex", "grid", "hidden"],
      fileGlobs: ["*.css", "*.scss", "*.tsx", "*.jsx", "*.vue", "*.svelte"],
      codeSignals: [
        { pattern: /display\s*:\s*none/, meaning: "Element hidden with display:none", likely_fix: "Check the condition that sets display:none" },
        { pattern: /overflow\s*:\s*hidden/, meaning: "Content clipped by overflow:hidden", likely_fix: "Use overflow:auto or overflow:visible" },
        { pattern: /z-index\s*:\s*-?\d+/, meaning: "z-index stacking issue", likely_fix: "Check stacking context — parent may need position:relative" },
        { pattern: /height\s*:\s*0|max-height\s*:\s*0/, meaning: "Element collapsed to zero height", likely_fix: "Check height calculation or animation state" },
      ],
    },
    diagnosis: "Visual bug — element hidden via CSS (display:none, overflow:hidden, zero height, z-index stacking, or opacity:0).",
  },

  // ── Network / API error ────────────────────────────────────
  {
    id: "network-error",
    triggers: /\b(?:fetch\s*fail|network\s*error|cors|timeout|504|502|500|api\s*(?:error|fail|down)|connection\s*(?:refused|reset|timeout)|no\s*(?:internet|connection|response)|econnrefused|socket\s*hang)\b/i,
    searchStrategy: {
      grepPatterns: ["fetch(", "axios", "http.", "request(", "cors", "proxy", "timeout", "retry", "baseURL", "base_url"],
      fileGlobs: ["*.ts", "*.js", "*.py", "*.go", "*.env", "*.config.*"],
      codeSignals: [
        { pattern: /fetch\([^)]*\)(?![\s\S]{0,100}?\.catch|[\s\S]{0,100}?catch)/, meaning: "fetch without error handling", likely_fix: "Add try/catch or .catch()" },
        { pattern: /localhost|127\.0\.0\.1/, meaning: "Hardcoded localhost — won't work in production", likely_fix: "Use environment variable for API base URL" },
        { pattern: /timeout\s*[:=]\s*\d{1,4}\b/, meaning: "Very short timeout (<10s)", likely_fix: "Increase timeout for slow networks" },
        { pattern: /credentials\s*:\s*["']include["']/, meaning: "CORS with credentials — server must allow specific origin", likely_fix: "Ensure server sets Access-Control-Allow-Origin to specific domain" },
      ],
    },
    diagnosis: "Network error — check CORS config, API endpoint URL, timeout settings, and error handling on fetch/axios calls.",
  },
];

// ── Smart Keyword Extractor ──────────────────────────────────

/**
 * Extract search keywords from user's natural language description.
 * More intelligent than raw grep — understands domain vocabulary.
 */
export function extractSearchKeywords(userMessage: string): string[] {
  const lower = userMessage.toLowerCase();
  const keywords: string[] = [];

  // Extract quoted terms literally
  const quoted = userMessage.match(/["']([^"']+)["']/g);
  if (quoted) keywords.push(...quoted.map(q => q.replace(/["']/g, "")));

  // Extract technical terms
  const techTerms = lower.match(/\b(?:modal|dialog|prompt|button|input|form|header|footer|sidebar|navbar|menu|tab|panel|toast|alert|spinner|loading|progress|error|warning|state|props|hook|effect|context|ref|memo|callback|reducer|store|dispatch|action|route|handler|middleware|controller|service|model|view|component|api|endpoint|request|response|fetch|query|mutation|cache)\b/gi);
  if (techTerms) keywords.push(...techTerms);

  // Extract file/component names (PascalCase or camelCase)
  const names = userMessage.match(/\b[A-Z][a-zA-Z]+(?:Component|Dialog|Modal|Page|Screen|View|Panel|Form|Button|Input|Provider|Context|Hook|Service|Controller|Handler|Router|Store)\b/g);
  if (names) keywords.push(...names);

  // Extract error codes/messages
  const errorCodes = userMessage.match(/\b(?:ERR_\w+|E\d{4,}|error\s*\d+|status\s*\d{3})\b/gi);
  if (errorCodes) keywords.push(...errorCodes);

  return [...new Set(keywords)];
}

/**
 * Match user's description against debug patterns.
 * Returns matched patterns sorted by relevance.
 */
export function matchDebugPatterns(userMessage: string): DebugPattern[] {
  return DEBUG_PATTERNS.filter(p => p.triggers.test(userMessage));
}
