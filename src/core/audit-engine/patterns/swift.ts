// KCode - SWIFT Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const SWIFT_PATTERNS: BugPattern[] = [
  {
    id: "swift-001-force-unwrap",
    title: "Force unwrap (!) on Optional (crash risk)",
    severity: "medium",
    languages: ["swift"],
    regex: /\w+!\s*\./g,
    explanation:
      "Force unwrapping with ! crashes at runtime if the value is nil. Use guard let, if let, or ?? instead.",
    verify_prompt:
      "Is this force unwrap in production code where nil is a realistic possibility? If the value is guaranteed non-nil (e.g. IBOutlet after viewDidLoad, known-good constant), respond FALSE_POSITIVE.",
    cwe: "CWE-476",
    fix_template: "Replace var! with guard let var = var else { return } or var ?? defaultValue.",
  },
  {
    id: "swift-002-force-try",
    title: "try! force try (crash on error)",
    severity: "medium",
    languages: ["swift"],
    regex: /\btry!\s/g,
    explanation:
      "try! crashes the app if the function throws. Use do/catch or try? for graceful error handling.",
    verify_prompt:
      "Is this try! in production code or test code? If the throwing function is guaranteed to succeed (e.g. known-good regex), respond FALSE_POSITIVE. If it could fail at runtime, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Replace try! with do { try ... } catch { handle error } or try? with default.",
  },
  {
    id: "swift-003-insecure-http",
    title: "HTTP (not HTTPS) URL in production code",
    severity: "high",
    languages: ["swift"],
    regex: /URL\s*\(\s*string:\s*"http:\/\/(?!localhost|127\.0\.0\.1)/g,
    explanation:
      "Using HTTP instead of HTTPS exposes data to man-in-the-middle attacks. App Transport Security (ATS) blocks this by default on iOS.",
    verify_prompt:
      "Does this HTTP URL carry real data at runtime in the production app? " +
      "Respond FALSE_POSITIVE for ALL of these safe cases: " +
      "(1) Template boilerplate or Xcode-generated scaffold — specifically " +
      '`.widgetURL(URL(string: "http://www.apple.com"))` and similar ' +
      "Apple-provided placeholder URLs in WidgetKit/ActivityKit templates; " +
      "(2) deep-link URLs for widgetURL/openURL that just open a browser " +
      "(no credentials, no session data transmitted); " +
      "(3) URLs inside #Preview, PreviewProvider, or _Previews structs " +
      "(preview-only code, never shipped at runtime); " +
      "(4) URLs pointing to well-known HSTS-preload domains (apple.com, " +
      "google.com, github.com) where the browser forces HTTPS anyway; " +
      "(5) URLs in test files, #if DEBUG blocks, or sample data constants; " +
      "(6) URLs in Info.plist or ATS exception entries (a documented exemption). " +
      "Respond CONFIRMED only if a real network request (URLSession, Alamofire, " +
      "AsyncHTTPClient) uses this URL to send or receive application data " +
      "over plaintext HTTP.",
    cwe: "CWE-319",
    fix_template: "Change http:// to https://.",
  },
  {
    id: "swift-004-keychain-no-access",
    title: "UserDefaults for sensitive data (should use Keychain)",
    severity: "high",
    languages: ["swift"],
    regex: /UserDefaults\b.*(?:password|token|secret|key|credential|auth)/gi,
    explanation:
      "UserDefaults is stored unencrypted on disk. Sensitive data (passwords, tokens) should use Keychain Services.",
    verify_prompt:
      "Is the value being stored actually sensitive (password, auth token, API key)? If it's a non-sensitive preference, respond FALSE_POSITIVE.",
    cwe: "CWE-312",
    fix_template:
      "Use KeychainAccess library or Security framework: SecItemAdd/SecItemCopyMatching.",
  },
  {
    id: "swift-005-hardcoded-secret",
    title: "Hardcoded secret/API key in Swift",
    severity: "high",
    languages: ["swift"],
    regex: /(?:apiKey|secretKey|password|token|authToken)\s*[:=]\s*"[A-Za-z0-9+/=_-]{16,}"/g,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with app binary access (strings can be extracted from .ipa).",
    verify_prompt:
      "Is this a real API key or a placeholder/example? If it looks like a real key (long random string), respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The value is a placeholder ('changeme', 'xxx', 'your-api-key-here', 'TODO', 'REPLACE_ME', 'test')\n" +
      "2. This is in test, example, or documentation code\n" +
      "3. The value is loaded from environment, plist, keychain, or a secrets manager\n" +
      "4. The value is a well-known public identifier (not a secret)\n" +
      "Only respond CONFIRMED if the value appears to be a real secret committed to source code in production code.",
    cwe: "CWE-798",
    fix_template: "Load from Info.plist (excluded from repo) or a secrets manager.",
  },
  {
    id: "swift-006-webview-js",
    title: "WKWebView with JavaScript enabled loading external content",
    severity: "high",
    languages: ["swift"],
    regex: /WKWebViewConfiguration\b[\s\S]{0,200}?javaScriptEnabled\s*=\s*true/g,
    explanation:
      "WKWebView with JavaScript enabled loading untrusted content can execute malicious scripts with access to native bridges.",
    verify_prompt:
      "Does this WebView load external/untrusted URLs? If it only loads local HTML or trusted internal content, respond FALSE_POSITIVE.",
    cwe: "CWE-79",
    fix_template: "Disable JS if not needed, or restrict navigation with WKNavigationDelegate.",
  },
  {
    id: "swift-007-force-unwrap-production",
    title: "Force unwrap (!) in production code path",
    severity: "high",
    languages: ["swift"],
    regex: /\b(?:let|var)\s+\w+\s*=\s*\w+!\s*$/gm,
    explanation:
      "Force unwrapping optionals with ! crashes at runtime with a fatal error if the value is nil. In production code paths, this creates fragile code that crashes instead of handling errors gracefully.",
    verify_prompt:
      "Is this force unwrap in production code where nil is a realistic possibility? " +
      "If the value is guaranteed non-nil by the language (e.g., IBOutlet after viewDidLoad, " +
      "known-good constant, or immediately after a nil check), respond FALSE_POSITIVE. " +
      "If nil could occur at runtime, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template:
      "Use guard let unwrapped = optional else { return } or if let, or provide a default with ??.",
  },
  {
    id: "swift-008-retain-cycle",
    title: "Retain cycle: strong reference in closure without [weak self]",
    severity: "medium",
    languages: ["swift"],
    regex: /\{\s*(?!\[(?:weak|unowned)\s+self\])(?:\([^)]*\)\s*(?:->.*?)?\s*in\s+)?[^}]*\bself\./g,
    explanation:
      "Closures that capture self strongly can create retain cycles, causing memory leaks. If self holds a strong reference to the closure (directly or through a chain), neither will be deallocated.",
    verify_prompt:
      "Does this closure capture self strongly AND is self likely to hold a reference " +
      "to this closure (e.g., stored in a property, passed to a long-lived handler)? " +
      "If the closure is short-lived (e.g., DispatchQueue.main.async, map/filter), " +
      "respond FALSE_POSITIVE. If it's stored as a property or completion handler, respond CONFIRMED.",
    cwe: "CWE-401",
    fix_template:
      "Add [weak self] or [unowned self] capture list: { [weak self] in guard let self else { return } ... }",
  },
  {
    id: "swift-009-main-thread-violation",
    title: "UI update from background thread",
    severity: "high",
    languages: ["swift"],
    regex:
      /DispatchQueue\.global\b[\s\S]{0,300}?(?:\.text\s*=|\.isHidden\s*=|\.alpha\s*=|\.image\s*=|\.reloadData\(\)|\.setTitle\(|\.backgroundColor\s*=|\.frame\s*=|\.addSubview\()/g,
    explanation:
      "Updating UIKit/AppKit views from a background queue causes undefined behavior: visual glitches, crashes, or data corruption. All UI updates must happen on the main thread.",
    verify_prompt:
      "Is this UI update inside a DispatchQueue.global() or background queue block? " +
      "If it's wrapped in DispatchQueue.main.async { } inside the background block, " +
      "respond FALSE_POSITIVE. If the UI update happens directly on the background queue, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Wrap UI updates: DispatchQueue.main.async { self.label.text = result }",
  },
  {
    id: "swift-010-force-try-production",
    title: "Force try (try!) in production code",
    severity: "high",
    languages: ["swift"],
    regex: /\btry!\s+\w+/g,
    explanation:
      "try! crashes the app with a fatal error if the called function throws. In production, use do/catch to handle errors gracefully instead of crashing.",
    verify_prompt:
      "Is this try! in production code? If the throwing function is GUARANTEED to succeed " +
      "(e.g., compiling a known-good regex literal, decoding a bundled resource), respond " +
      "FALSE_POSITIVE. If it could fail at runtime with user data, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Use do { try expression } catch { handle error } or try? with a default value.",
  },
  {
    id: "swift-011-force-cast",
    title: "Force cast (as!) without safety check",
    severity: "medium",
    languages: ["swift"],
    regex: /\bas!\s+\w+/g,
    explanation:
      "Force casting with as! crashes at runtime if the cast fails. Use conditional cast (as?) with proper handling instead.",
    verify_prompt:
      "Is this as! cast guaranteed to succeed (e.g., casting from a known type, " +
      "dequeuing a registered cell)? If the type is guaranteed by the system, " +
      "respond FALSE_POSITIVE. If the source type could be wrong at runtime, respond CONFIRMED.",
    cwe: "CWE-704",
    fix_template: "Use conditional cast: guard let typed = value as? TargetType else { return }",
  },
  {
    id: "swift-012-unowned-dealloc",
    title: "Unowned reference to potentially deallocated object",
    severity: "high",
    languages: ["swift"],
    regex:
      /\[unowned\s+self\][\s\S]{0,300}?(?:DispatchQueue|Timer|URLSession|NotificationCenter|after\(deadline)/g,
    explanation:
      "Unowned references crash if the referenced object is deallocated. Using [unowned self] in async callbacks (network requests, timers, delayed dispatch) is dangerous because self may be deallocated before the callback fires.",
    verify_prompt:
      "Could self be deallocated before this async callback executes? If the closure " +
      "is guaranteed to complete while self is alive (e.g., synchronous operation), " +
      "respond FALSE_POSITIVE. If it's async (network, timer, delayed), respond CONFIRMED.",
    cwe: "CWE-416",
    fix_template:
      "Use [weak self] instead of [unowned self] for async callbacks: { [weak self] in guard let self else { return } }",
  },
  {
    id: "swift-013-missing-main-actor",
    title: "Missing @MainActor annotation on UI-related class",
    severity: "medium",
    languages: ["swift"],
    regex:
      /class\s+\w+(?:ViewController|View|Cell|Controller)\s*(?::\s*\w+)?\s*\{(?![\s\S]{0,50}?@MainActor)/g,
    explanation:
      "UI-related classes (ViewControllers, Views, Cells) should be annotated with @MainActor to ensure all property access and method calls happen on the main thread. Without it, concurrent access from Swift concurrency can cause data races.",
    verify_prompt:
      "Is this a UIKit/SwiftUI class that accesses UI elements? If the class " +
      "has @MainActor on the class declaration or inherits from a @MainActor class, " +
      "respond FALSE_POSITIVE. If it's a plain data model, respond FALSE_POSITIVE. " +
      "If it's a UI class without @MainActor, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template:
      "Add @MainActor annotation: @MainActor class MyViewController: UIViewController { }",
  },
  {
    id: "swift-014-hardcoded-secret-swift",
    title: "Hardcoded secret or API key in Swift source",
    severity: "high",
    languages: ["swift"],
    regex:
      /(?:apiKey|secretKey|password|authToken|privateKey|accessToken)\s*[:=]\s*"[A-Za-z0-9+/=_-]{16,}"/g,
    explanation:
      "Hardcoded secrets in Swift source code can be extracted from the compiled binary using the strings command. Anyone with access to the .ipa/.app can recover them.",
    verify_prompt:
      "Is this a REAL API key/secret or a placeholder/example? If it looks like a " +
      "real credential (long random string), respond CONFIRMED. If placeholder, " +
      "test value, or loaded from Info.plist/Keychain, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template:
      "Load from Info.plist (excluded from repo), Keychain, or a remote config service.",
  },
  {
    id: "swift-015-missing-async-error-handling",
    title: "Missing error handling in async/await",
    severity: "medium",
    languages: ["swift"],
    regex: /\bawait\s+\w+[\s\S]{0,50}?(?:(?!\btry\b)(?!\bcatch\b)(?!\bdo\b).){50}/g,
    explanation:
      "Async/await calls to throwing functions without try/catch will propagate errors silently. In non-throwing contexts, this may cause compile errors or unhandled failures.",
    verify_prompt:
      "Is this await call inside a do/catch block or is the containing function " +
      "marked as throws? If error handling exists (try/catch, Task with error handling), " +
      "respond FALSE_POSITIVE. If no error handling, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template:
      "Wrap in do/catch: do { let result = try await fetchData() } catch { handleError(error) }",
  },
];
