// KCode - AI/ML Security Pack (F9 of audit product plan, v2.10.370)
//
// Patterns specific to LLM, vector DB, and ML-model integrations.
// These are the new attack surfaces that don't fit the classic web /
// memory-safety taxonomies — code that loads remote models with
// arbitrary code execution, leaks expensive API keys, or feeds
// untrusted input into prompt strings.
//
// Every pattern in this file has `pack: "ai-ml"` so the user can
// scope an audit to just this lens with `kcode audit . --pack ai-ml`.

import type { BugPattern } from "../types";

export const AI_ML_PATTERNS: BugPattern[] = [
  {
    id: "ai-001-trust-remote-code",
    title: "transformers.from_pretrained(trust_remote_code=True) — RCE on model load",
    severity: "critical",
    languages: ["python"],
    pack: "ai-ml",
    // Match any HuggingFace loader (`from_pretrained`, `pipeline`,
    // `AutoConfig.from_*`, etc.) where `trust_remote_code=True` is
    // passed. The kwarg is the dangerous part; without it HF
    // refuses to execute the repo's custom Python code at load time.
    regex: /\btrust_remote_code\s*=\s*True\b/g,
    explanation:
      "trust_remote_code=True downloads and executes arbitrary Python from the HuggingFace repo at load time. A model author (or anyone who compromises the repo) gets code execution in your process the moment from_pretrained runs. Treat this as `eval()` of remote code with extra steps.",
    verify_prompt:
      "Is the model identifier (the first arg) a string that originated from external input (config file the user can override, CLI arg, network response)?\n" +
      "1. Hardcoded model ID like 'meta-llama/Llama-3-8B' — still CONFIRMED if trust_remote_code=True is set unconditionally; downstream auditors flag this as a supply-chain risk regardless of the source string.\n" +
      "2. Model ID derived from user input — definitely CONFIRMED; the attacker picks the repo.\n" +
      "3. The call is wrapped in a sandbox / containerized worker process with no host access — FALSE_POSITIVE.\n" +
      "Default to CONFIRMED. The flag is the bug; the input source is severity, not validity.",
    cwe: "CWE-94",
    fix_template:
      "Drop trust_remote_code=True. If the model genuinely requires custom code, mirror the repo into your own infrastructure, audit the .py files, and pin a specific commit SHA via revision='<sha>'.",
  },
  {
    id: "ai-002-openai-api-key-hardcoded",
    title: "OpenAI API key hardcoded in source",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "ruby", "java"],
    pack: "ai-ml",
    // Real OpenAI keys are 51 chars: sk-<48 base62>. Project-scoped
    // keys are sk-proj-<48 base62>. Match either form. Allow the key
    // to live in a string literal; we don't try to follow it through
    // env vars.
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    explanation:
      "An OpenAI API key in source means anyone with read access can spend on your account, exfiltrate API logs, or pivot into the connected resources. Even short-lived keys committed to a public repo are scraped and abused within minutes by automated harvesters.",
    verify_prompt:
      "Does the matched string look like a real key, or is it a placeholder?\n" +
      "1. Key contains 'YOUR_KEY', 'XXXX', 'placeholder', 'changeme', '...' — FALSE_POSITIVE.\n" +
      "2. Key matches the sk-(proj-)?[A-Za-z0-9_-]{20,} shape AND has no obvious placeholder marker — CONFIRMED. Rotate immediately.\n" +
      "3. The literal is a fixture / test mock that's clearly not a real key — FALSE_POSITIVE if comment / nearby code marks it as such.",
    cwe: "CWE-798",
    fix_template:
      "Move the key to an environment variable (OPENAI_API_KEY) or secret manager. Rotate the leaked key immediately — assume any key that ever lived in a commit is compromised.",
  },
  {
    id: "ai-003-anthropic-api-key-hardcoded",
    title: "Anthropic API key hardcoded in source",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "ruby", "java"],
    pack: "ai-ml",
    // Anthropic keys: sk-ant-<token>. Be slightly more forgiving on
    // length to catch new key formats.
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    explanation:
      "Same exposure as a leaked OpenAI key — billable API access, log exfiltration, lateral movement into whatever the integration touches. Anthropic detects committed keys and revokes, but not before the harvester window.",
    verify_prompt:
      "Same triage as ai-002:\n" +
      "1. Placeholder / fixture / test mock with obvious markers — FALSE_POSITIVE.\n" +
      "2. Real-looking sk-ant-* token — CONFIRMED. Rotate immediately.",
    cwe: "CWE-798",
    fix_template:
      "Use ANTHROPIC_API_KEY env var or a secret manager. Rotate the leaked key immediately.",
  },
  {
    id: "ai-004-prompt-injection-sink",
    title: "Untrusted input concatenated into LLM prompt without delimiter",
    severity: "high",
    languages: ["python", "javascript", "typescript"],
    pack: "ai-ml",
    // Heuristic: f-string or concat building a prompt that includes
    // a known untrusted-input source. The regex hits common shapes:
    //   `f"...{user_input}..."` passed to a known LLM call
    //   `"prompt:" + req.body.x`  (JS)
    //   `prompt = f"... {request.args.get(...)} ..."`  (Python Flask)
    // We match the literal+input pattern and let the verifier decide
    // whether it actually reaches a generate / chat call.
    regex:
      /(?:prompt|system|messages|content|completion)\s*[:=]\s*(?:f["']|.*\+\s*(?:request\.|req\.|process\.argv|input\(|sys\.argv))/g,
    explanation:
      "User input concatenated into an LLM prompt without delimiter / structure / explicit framing lets the user override the system prompt. They can read the system instructions, exfiltrate variables in the prompt, or steer the model into producing content the deploying app didn't intend. This is XSS for LLM apps.",
    verify_prompt:
      "Does the prompt actually feed into a generate/chat/complete call?\n" +
      "1. The string is built but stored in a log / display / debug print only — FALSE_POSITIVE.\n" +
      "2. The string flows into anthropic.messages.create / openai.chat.completions.create / etc. — CONFIRMED.\n" +
      "3. The user portion is wrapped in clear delimiters AND the system prompt instructs the model to ignore them — FALSE_POSITIVE (still imperfect, but the deployed mitigation is reasonable).\n" +
      "Default to CONFIRMED for direct concat into a prompt that reaches a model call.",
    cwe: "CWE-77",
    fix_template:
      "Wrap user input in delimited blocks the system prompt explicitly forbids overriding (e.g. <user_input>...</user_input>) and use the API's structured roles instead of concatenated strings.",
  },
  {
    id: "ai-005-vector-db-untrusted-query",
    title: "Vector DB query built from untrusted input without metadata filter",
    severity: "medium",
    languages: ["python", "javascript", "typescript"],
    pack: "ai-ml",
    // Common vector DB query shapes — pinecone, chroma, weaviate, qdrant,
    // milvus. Match the .query / .similarity_search / .search method on
    // an obvious DB object, with a string built from user input.
    regex:
      /(?:pinecone|chroma|weaviate|qdrant|milvus|vector_?store)\.(?:query|search|similarity_search|similar)/gi,
    explanation:
      "Vector DBs return whatever's most-similar — including content from other tenants if metadata filters aren't applied. Concatenating user input into the query string can also cause prompt injection downstream if the retrieved chunks are fed back into an LLM. The risk is per-tenant data leakage and prompt-injection-via-RAG.",
    verify_prompt:
      "Does the query include a tenant / namespace / user-id metadata filter?\n" +
      "1. The .query() call has a `filter` / `where` / `namespace` arg constraining results to the requesting user's data — FALSE_POSITIVE.\n" +
      "2. No metadata filter, results feed into an LLM prompt downstream — CONFIRMED (RAG-injection + cross-tenant leak).\n" +
      "3. Search is over an explicitly public corpus (e.g. documentation only) — FALSE_POSITIVE.",
    cwe: "CWE-200",
    fix_template:
      'Add a metadata filter that scopes results to the calling user (filter={"user_id": current_user.id}). For RAG flows, also escape retrieved chunks before feeding them back into the prompt.',
  },
];
