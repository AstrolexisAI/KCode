// KCode - Cryptographic-Misuse Patterns
//
// Built for v2.10.314 as part of the expansion toward state-of-the-art
// auditing. Each pattern tracks an actual CVE class — the explanation
// cites the attack shape so the LLM verifier knows what to rule out.
//
// Authoring rules (apply to every pattern here):
//   * High signal: pattern fires only when the attack surface is
//     realistic. We prefer missing a bug (low recall) over flooding
//     the auditor with false positives.
//   * Verify prompt lists the specific mitigations to look for. This
//     keeps the verifier checklist-driven.
//   * CWE tags are from the MITRE list — helps interop with SARIF +
//     enterprise SAST pipelines (Coverity/Klocwork ingest SARIF).

import type { BugPattern } from "../types";

export const CRYPTO_PATTERNS: BugPattern[] = [
  // ── Weak RNG for crypto purposes ────────────────────────────────
  {
    id: "crypto-001-rand-for-key-material",
    title: "rand()/srand() used for key / nonce / token material",
    severity: "critical",
    languages: ["c", "cpp", "python", "javascript", "typescript", "go", "java", "ruby", "php"],
    regex:
      /\b(rand|srand|Math\.random|random\.random|random\.randint|random\.choice|Random\.new|mt_rand)\s*\([^)]*\)[\s\S]{0,200}?\b(key|nonce|iv|token|session|secret|password|salt|challenge)\b/gi,
    explanation:
      "Non-cryptographic RNGs (rand, Math.random, random module) are deterministic / low-entropy / predictable from timing. Using them to generate keys, nonces, tokens, or session identifiers lets an attacker reconstruct the secret. CVE examples: any 'broken session token' CVE in the last decade.",
    verify_prompt:
      "Is the output of this non-crypto RNG used for SECURITY purposes — session token, auth cookie, CSRF token, IV, nonce, or key material? Confirm only if YES. If it's used for non-security randomness (jitter, game mechanics, shuffle, test fixtures, retry backoff), respond FALSE_POSITIVE.",
    cwe: "CWE-338",
    fix_template:
      "C/C++: use /dev/urandom or getrandom(). Python: secrets module. JS: crypto.randomBytes / crypto.getRandomValues. Go: crypto/rand. Java: SecureRandom.",
  },

  // ── Static / constant IV for CBC/CTR/GCM ────────────────────────
  {
    id: "crypto-002-static-iv",
    title: "AES/ChaCha IV initialized from constant or zero",
    severity: "high",
    languages: ["c", "cpp", "python", "javascript", "typescript", "go", "java", "csharp", "php"],
    regex:
      /\b(iv|nonce|IV)\s*=\s*(?:\[?\s*)?(?:0x00|\\?x00|"\\?0"|b?"0+"|bytes\s*\(\s*\d+\s*\)|new\s+byte\s*\[\s*\d+\s*\]|new\s+Uint8Array\s*\(\s*\d+\s*\)|\{\s*0\s*\}|0\s*\}?)/g,
    explanation:
      "An all-zero or constant IV reused across encryptions destroys the security of AES-CBC (reveals plaintext relations), AES-CTR (keystream reuse → XOR of plaintexts leaks), and AES-GCM (catastrophic — a single nonce reuse in GCM lets an attacker forge arbitrary ciphertexts). CVE-2016-6304 and many others.",
    verify_prompt:
      "Is this IV/nonce used with a symmetric cipher (AES, ChaCha, 3DES)? If yes, and the IV is zero or a compile-time constant reused across encryptions, CONFIRMED. If the IV is (a) re-derived per-message from a CSPRNG, (b) a counter that is provably unique per key, or (c) a filler never actually passed to encrypt(), respond FALSE_POSITIVE.",
    cwe: "CWE-329",
    fix_template:
      "Generate a fresh random IV per encryption: os.urandom(16), crypto.randomBytes(16), SecureRandom.getInstanceStrong().nextBytes(iv).",
  },

  // ── MD5 / SHA1 for authentication ───────────────────────────────
  {
    id: "crypto-003-md5-sha1-for-auth",
    title: "MD5 / SHA1 used for authentication / signing / passwords",
    severity: "high",
    languages: [
      "c",
      "cpp",
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
    ],
    regex:
      /\b(MD5|SHA1|Sha1|sha1|md5|MessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-?1)"|hashlib\.(?:md5|sha1)|createHash\s*\(\s*['"](md5|sha1)['"])\b/g,
    explanation:
      "MD5 collisions are trivial to construct (2013+). SHA-1 collisions are practical (SHAttered, 2017). Using either for authentication, signing, TLS certs, or password hashing lets an attacker forge valid signatures or find hash collisions. CVE examples: CVE-2004-2761 (MD5), CVE-2017-4955 (SHA-1).",
    verify_prompt:
      "Check the use-case. Respond CONFIRMED only if the hash is used for SECURITY purposes — signature, MAC, certificate, password storage, token derivation. Respond FALSE_POSITIVE if the hash is used for (a) non-security purposes like checksums / cache keys / git object IDs / deduplication, (b) protocols that specifically require it (e.g. HMAC-SHA1 in legacy TLS is not itself broken — HMAC survives the collision resistance loss), or (c) test vectors in crypto libraries.",
    cwe: "CWE-327",
    fix_template:
      "Switch to SHA-256 / SHA-3 / BLAKE2 for hashing. For passwords, use Argon2id / bcrypt / scrypt. For HMAC, HMAC-SHA256 or HMAC-SHA3.",
  },

  // ── Password hashing with unsalted / single-round hash ──────────
  {
    id: "crypto-004-password-fast-hash",
    title: "Password stored as fast-hash (SHA-256 without KDF)",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    regex:
      /\b(sha256|SHA256|sha512|SHA512|sha3|blake2|Blake2)\s*\([^)]*(?:password|passwd|pwd|credential)\b/gi,
    explanation:
      "Fast hashes (SHA-256, SHA-512, BLAKE2) without a key-derivation function can be brute-forced at ~10 billion guesses/second on modern GPUs. Passwords must use a slow KDF: Argon2id (preferred), bcrypt, scrypt, or PBKDF2 with ≥600k iterations.",
    verify_prompt:
      "Is this hash stored or compared as the password verifier? If the hash is one step in an HMAC-based protocol or is combined with a KDF (PBKDF2/Argon2/scrypt/bcrypt) in the same function, respond FALSE_POSITIVE. Only CONFIRMED when the raw fast-hash output is the final password-verification value.",
    cwe: "CWE-916",
    fix_template:
      "Use a password-specific KDF: bcrypt.hashpw / argon2.hash / scrypt.hash / PBKDF2 with 600k+ iterations.",
  },

  // ── Non-constant-time comparison for MAC / token ────────────────
  {
    id: "crypto-005-timing-safe-compare-missing",
    title: "String equality (==, strcmp, ===) used on MAC / HMAC / token",
    severity: "high",
    languages: [
      "c",
      "cpp",
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
    ],
    regex:
      /\b(mac|hmac|signature|sig|token|digest|tag|authTag)\s*(?:==|===|!=|!==)\s*|\bstrcmp\s*\([^,]*(mac|hmac|signature|sig|token|digest|tag)\b|\bstrncmp\s*\([^,]*(mac|hmac|signature|sig|token|digest|tag)\b/gi,
    explanation:
      "Comparing a MAC / HMAC / signature with regular equality leaks length and match progress via timing. An attacker can recover the correct MAC byte-by-byte from timing side channels. CVE-2011-4121 (OpenSSL), CVE-2014-0160 (Heartbleed's adjacent class).",
    verify_prompt:
      "Is the comparison between a SECRET verifier (MAC, signed token, session token, auth tag) and a USER-PROVIDED value? If either side is attacker-controllable and the other is a constant-time-required secret, CONFIRMED. If both are public values (e.g. hashing two known inputs for cache equality), FALSE_POSITIVE.",
    cwe: "CWE-208",
    fix_template:
      "Python: hmac.compare_digest. Node: crypto.timingSafeEqual. Go: subtle.ConstantTimeCompare. Java: MessageDigest.isEqual. C: CRYPTO_memcmp. PHP: hash_equals.",
  },

  // ── TLS version <= 1.1 ──────────────────────────────────────────
  {
    id: "crypto-006-tls-legacy-version",
    title: "TLS configured to allow SSLv3 / TLS 1.0 / TLS 1.1",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "c", "cpp"],
    regex:
      /\b(SSLv3|SSLv23_METHOD|TLSv1\b|TLSv1_METHOD|TLSv1_1|TLS1_VERSION|TLS1_1_VERSION|PROTOCOL_TLSv1(?!_2)|PROTOCOL_SSLv3|ssl_min_version\s*=\s*['"]?(?:TLS1|1\.0|1\.1))\b/g,
    explanation:
      "TLS <= 1.1 has known weaknesses (BEAST, POODLE, CBC padding oracles) and is deprecated by IETF RFC 8996 (2021). Banks, regulators, PCI-DSS v4 disallow it. NASA/DoD environments often require TLS 1.2+.",
    verify_prompt:
      "Is this configuration ENABLING the legacy version or DISALLOWING it? Some code explicitly sets ssl_max_version=TLS1_1 to CAP it — context matters. If the line forbids or caps-below, FALSE_POSITIVE. If it sets min_version or enables the method, CONFIRMED.",
    cwe: "CWE-327",
    fix_template:
      "Require TLS 1.2+ (ideally TLS 1.3): ssl.TLSVersion.TLSv1_2 / secureProtocol='TLSv1_2_method' / tls.Config{MinVersion: tls.VersionTLS12}.",
  },

  // ── Certificate validation disabled ─────────────────────────────
  {
    id: "crypto-007-tls-verify-off",
    title: "TLS certificate validation disabled",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "ruby", "php"],
    regex:
      /\b(verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|rejectUnauthorized\s*:\s*false|CERT_NONE|TrustManager[^{]*\{\s*@Override[^}]*checkServerTrusted[^}]*\{\s*\}|ServerCertificateValidationCallback\s*=\s*\(.*?\)\s*=>\s*true|VERIFY_PEER\s*,\s*NULL)/gi,
    explanation:
      "Disabling TLS cert validation means any MITM attacker can intercept traffic by presenting a fake cert. This is a critical security hole — everyone on the same WiFi / any ISP / any nation-state transit can read and modify the traffic.",
    verify_prompt:
      "Is this in production code path, or is it in a test / development / self-signed-cert fixture? If it's wrapped by `if env == 'test'` or only runs in unit tests, FALSE_POSITIVE. If it's a production HTTP client, CONFIRMED.",
    cwe: "CWE-295",
    fix_template:
      "Remove the flag. If self-signed certs are required (dev, internal CA), add the specific CA to the trust store instead of disabling validation.",
  },

  // ── Hardcoded crypto key / secret ───────────────────────────────
  {
    id: "crypto-008-hardcoded-key",
    title: "Hardcoded cryptographic key / IV / secret in source",
    severity: "critical",
    languages: [
      "c",
      "cpp",
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
      "rust",
    ],
    regex:
      /\b(key|secret|password|token|api_?key|privat[ea]Key|jwt[_.]?secret)\s*[:=]\s*['"`][A-Za-z0-9+/=\-_]{16,}['"`]/gi,
    explanation:
      "Cryptographic keys / secrets committed to source code are extractable from any released binary, leaked via git history, and rotated only via code deploy. CVE examples: Mirai (hardcoded credentials), thousands of leaked API keys on GitHub.",
    verify_prompt:
      'Check these before confirming. FALSE_POSITIVE if ANY is true:\n1. Is the value a TEST VECTOR (RFC standard value like RFC 3610 test keys)? → FALSE_POSITIVE\n2. Is it in a test/fixture file (path contains /test/ /spec/ /fixtures/)? → FALSE_POSITIVE\n3. Is it a placeholder / example value ("changeme", "INSERT_KEY_HERE", "xxx...")? → FALSE_POSITIVE\n4. Is it a PUBLIC key (intended to be embedded)? → FALSE_POSITIVE\nOnly CONFIRMED when this appears to be a real secret that was committed by accident.',
    cwe: "CWE-798",
    fix_template:
      "Move to environment variable / secrets manager (HashiCorp Vault, AWS Secrets Manager, Doppler). Purge from git history (git filter-repo) and rotate the compromised value.",
  },

  // ── ECB mode for symmetric encryption ───────────────────────────
  {
    id: "crypto-009-ecb-mode",
    title: "AES-ECB or DES-ECB mode used",
    severity: "high",
    languages: [
      "c",
      "cpp",
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
    ],
    regex:
      /\b(AES[_.]ECB|DES[_.]ECB|MODE_ECB|\/ECB\/|aes-\d{3}-ecb|ECB_MODE|CipherMode\.ECB|BlockCipher\.ECB)\b/gi,
    explanation:
      "ECB encrypts identical plaintext blocks to identical ciphertext blocks, leaking structure (the infamous Tux penguin example). An attacker can identify repeated data, replay blocks, and sometimes recover plaintext via known-plaintext attacks.",
    verify_prompt:
      "Is this ECB mode used to encrypt user data, sessions, or any non-random input? If it's used only to encrypt single blocks of cryptographically random data (e.g. encrypting an AES key with a KEK), respond FALSE_POSITIVE (that specific case is safe). Otherwise CONFIRMED.",
    cwe: "CWE-327",
    fix_template:
      "Use an authenticated mode: AES-GCM (AEAD), AES-OCB, or ChaCha20-Poly1305. If you must stick to older modes, AES-CBC + HMAC-SHA256.",
  },

  // ── Short RSA / DH key size ─────────────────────────────────────
  {
    id: "crypto-010-short-rsa-dh",
    title: "RSA or DH key shorter than 2048 bits",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "c", "cpp"],
    regex:
      /\b(generateKeyPair|RSAKeyGen|RSA_generate_key_ex|DHParam|rsa_genkey|genrsa)[^(]*\(\s*(?:\w+\s*,\s*)?(?:key_?size\s*[:=]\s*)?(512|768|1024)\b|\bbits\s*[:=]\s*(512|768|1024)\b.*?\b(rsa|dh|dsa)\b/gi,
    explanation:
      "RSA-1024 is factorable with multi-million-dollar nation-state effort (projected broken by 2030 for widespread use). 512 and 768 are broken (the 768-bit RSA factorization was announced in 2009). NIST requires 2048+ for signatures after 2013, 3072+ after 2030.",
    verify_prompt:
      "Is this generating a key that will be used for anything other than test fixtures? If the key is only used in unit tests for a protocol implementation (to avoid slow keygen in tests), FALSE_POSITIVE. Otherwise CONFIRMED — production keys must be ≥2048.",
    cwe: "CWE-326",
    fix_template:
      "Use 2048+ bits for RSA/DH (3072+ for data sensitive beyond 2030). Better: switch to Ed25519/X25519 which are 256-bit and faster.",
  },

  // ── JWT none algorithm ──────────────────────────────────────────
  {
    id: "crypto-011-jwt-none-alg",
    title: "JWT verifier accepts alg=none",
    severity: "critical",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    regex:
      /\b(algorithms?\s*[:=]\s*(?:\[\s*)?['"]?none['"]?|verify\s*=\s*False|options\s*=\s*\{\s*['"]verify_signature['"]?\s*:\s*False|jwt\.decode\s*\([^,]+,\s*verify\s*=\s*False)\b/gi,
    explanation:
      "JWT's 'none' algorithm lets an attacker forge any payload — no signature is required, the server just trusts the header's alg field. Any JWT library that accepts 'none' without explicit opt-in is exploitable. CVE-2015-9235, CVE-2018-1000531, many variants.",
    verify_prompt:
      "Is this verifier configured to accept unsigned JWTs in any branch reachable from authentication? Only CONFIRMED if yes. If it's a debugging helper gated behind a dev-only flag, FALSE_POSITIVE.",
    cwe: "CWE-347",
    fix_template:
      "Explicitly whitelist algorithms: jwt.decode(token, key, algorithms=['HS256']) or ['RS256']. Never accept alg=none.",
  },

  // ── XOR / home-rolled encryption ────────────────────────────────
  {
    id: "crypto-012-homerolled-xor",
    title: "Home-rolled XOR 'encryption' of sensitive data",
    severity: "high",
    languages: [
      "c",
      "cpp",
      "python",
      "javascript",
      "typescript",
      "go",
      "java",
      "csharp",
      "php",
      "ruby",
    ],
    regex:
      /(?:for\s*\([^)]*\)\s*\{[^}]*\^=\s*(?:key|secret|pass)|\.map\s*\(\s*\([^)]*\)\s*=>\s*[^)]*\^\s*(?:key|secret|pass))/gi,
    explanation:
      "Home-rolled XOR-based 'encryption' is equivalent to a Vigenère cipher with the key's bytes. Any known plaintext fragment recovers the key. Used to be the standard 'hide config' trick in 90s software and is still broken.",
    verify_prompt:
      "Is this XOR being used for security (confidentiality of a secret) or for benign purposes (checksum, obfuscation not claiming security, hash mixing)? Only CONFIRMED if the code comments or context claim this provides encryption / privacy / security.",
    cwe: "CWE-327",
    fix_template:
      "Replace with AES-GCM or ChaCha20-Poly1305. Both are in standard libraries (Python cryptography, Node crypto, Go crypto/cipher).",
  },

  // ── Static salt for KDF ─────────────────────────────────────────
  {
    id: "crypto-013-static-salt",
    title: "Password KDF uses constant / empty salt",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "ruby"],
    regex:
      /\b(PBKDF2|bcrypt|scrypt|argon2|pbkdf2)[^(]*\([^,]+,\s*(?:b?['"`][A-Za-z0-9+/=]*['"`]|b?['"`]{2}|null|None|0\s*,|new\s+byte\s*\[\s*\d+\s*\]\s*,)/g,
    explanation:
      "A constant salt means all users with the same password produce the same hash — defeats the salt's purpose (prevents rainbow tables, slows multi-target attacks). Each user's salt must be unique and random.",
    verify_prompt:
      "Is the salt argument literally empty / zero / a fixed constant, reused across users? If it's computed per-user (e.g. from a database column, random generator, or user ID), FALSE_POSITIVE.",
    cwe: "CWE-759",
    fix_template:
      "Generate a unique random salt per credential: os.urandom(16) / crypto.randomBytes(16), store alongside the hash.",
  },

  // ── RSA without OAEP / PKCS#1 v1.5 ──────────────────────────────
  {
    id: "crypto-014-rsa-pkcs1v15-encrypt",
    title: "RSA encryption using PKCS#1 v1.5 padding (Bleichenbacher)",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "c", "cpp"],
    regex:
      /\b(PKCS1_v1_5|PKCS1V15|RSA_PKCS1_PADDING|RSA\/ECB\/PKCS1Padding|Cipher\.RSA(?!\/ECB\/OAEP))\b/g,
    explanation:
      "RSA PKCS#1 v1.5 padding for ENCRYPTION is vulnerable to Bleichenbacher-style padding oracle attacks (1998, ROBOT 2017). Still secure for signing (RSA-SSA PKCS#1 v1.5). Use OAEP for encryption.",
    verify_prompt:
      "Is this PKCS#1 v1.5 used for ENCRYPTION (the vulnerable case) or for SIGNING (still fine)? If the same module is used for RSA signatures, FALSE_POSITIVE. If it's explicitly RSA_encrypt / cipher.init(ENCRYPT_MODE), CONFIRMED.",
    cwe: "CWE-780",
    fix_template:
      "Switch encryption to OAEP padding: RSA/ECB/OAEPWithSHA-256AndMGF1Padding / PKCS1_OAEP.",
  },

  // ── HMAC truncation ─────────────────────────────────────────────
  {
    id: "crypto-015-hmac-truncation",
    title: "HMAC compared with only a prefix / short substring",
    severity: "high",
    languages: ["python", "javascript", "typescript", "go", "java", "csharp", "php", "c", "cpp"],
    regex:
      /\b(hmac|HMAC|digest|signature)\b[^;\n]{0,60}\b(substring|substr|slice|\[0\s*:\s*\d{1,2}\]|\[\s*:\s*\d{1,2}\s*\]|\.first\s*\(\s*\d+\s*\)|\.take\s*\(\s*\d{1,2}\s*\))/gi,
    explanation:
      "Truncating an HMAC to a few bytes (say 8 hex chars = 32 bits) lets an attacker brute-force a collision in 2^32 requests — trivially feasible. Some codebases do this to fit into URL/cookie constraints and create a hash collision vulnerability.",
    verify_prompt:
      "How many bytes/hex-chars survive the truncation? Minimum security is ~128 bits (16 bytes, 32 hex chars). If the truncated length is ≥128 bits, FALSE_POSITIVE. If it's shorter (common: 8/16/24 hex chars → 32/64/96 bits), CONFIRMED.",
    cwe: "CWE-328",
    fix_template:
      "Keep HMAC outputs at full length (32 bytes for HMAC-SHA256). If space is truly limited, use a longer underlying hash and truncate to ≥16 bytes.",
  },
];
