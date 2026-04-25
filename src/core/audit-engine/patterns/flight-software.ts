// KCode - Flight-Software / Embedded Patterns
//
// Domain-specific pack for fprime, NASA cFS, zephyr, freeRTOS-style
// projects. These patterns know about framework idioms (FW_ASSERT,
// CFE_EVS_SendEvent, IPC message headers) so mitigations already
// present in the framework contribute to a FALSE_POSITIVE verdict
// without needing a full LLM roundtrip.
//
// Rationale: a regex pattern that flags `for (i < m_count)` on a
// codebase like fprime will trigger hundreds of times, and the LLM
// verifier has to re-derive the same "is there an FW_ASSERT upstream?"
// reasoning each time. This pack bakes the framework knowledge in.

import type { BugPattern } from "../types";

export const FLIGHT_SOFTWARE_PATTERNS: BugPattern[] = [
  // ── Port handler missing FwIndexType bounds check ───────────────
  {
    id: "fsw-001-port-handler-no-check",
    title: "Component port handler uses portNum without bounds check",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /_handler\s*\(\s*(?:const\s+)?FwIndexType\s+portNum[^)]*\)\s*\{(?![\s\S]{0,500}?(?:FW_ASSERT\s*\(\s*portNum|portNum\s*<\s*this->getNum_|this->isConnected_))/g,
    explanation:
      "fprime port handlers receive a `FwIndexType portNum` that identifies which input port fired. If the component has N ports and portNum is used to index an array without FW_ASSERT(portNum < N), out-of-bounds. fprime framework code guards this but custom components sometimes skip it.",
    verify_prompt:
      "Does the handler body (within ~20 lines of the opening brace) contain an FW_ASSERT on portNum, a `portNum < this->getNum_XXX_InputPorts()` check, or `this->isConnected_XXX_OutputPort(portNum)` before indexing? If yes, FALSE_POSITIVE. If portNum is used to index an array with no check, CONFIRMED.",
    cwe: "CWE-129",
    fix_template:
      "Add at handler start: `FW_ASSERT(portNum < this->getNum_<PortName>_InputPorts(), portNum);`",
  },

  // ── Serialization without size bound check ──────────────────────
  {
    id: "fsw-002-deserialize-no-length-check",
    title: "Fw::SerializeBufferBase::deserialize result not checked",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\.deserialize\s*\([^)]+\)\s*;(?![\s\S]{0,200}?(?:FW_ASSERT|if\s*\(\s*(?:stat|status|result|ser_?stat)\s*(?:!=|==)\s*Fw::SerializeStatus))/g,
    explanation:
      "fprime's SerializeBufferBase::deserialize() returns a Fw::SerializeStatus — it MUST be checked. If the buffer was truncated, the value left in the destination is undefined / attacker-controlled. Unchecked deserialize is the #1 class of parsing bugs in framework-based flight software.",
    verify_prompt:
      "Is the return value of this deserialize call captured into a variable? Then check: is that variable compared to Fw::SerializeStatus::FW_SERIALIZE_OK (or passed to FW_ASSERT) before the deserialized value is used? If yes, FALSE_POSITIVE. If the value is used unconditionally, CONFIRMED.",
    cwe: "CWE-252",
    fix_template:
      "Capture the status: `Fw::SerializeStatus stat = buf.deserialize(x); FW_ASSERT(stat == Fw::FW_SERIALIZE_OK, stat);` then use x only on success.",
  },

  // ── FW_ASSERT stripped in release ───────────────────────────────
  {
    id: "fsw-003-assert-as-validation",
    title: "FW_ASSERT used as input validation (disabled in release)",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\bFW_ASSERT\s*\(\s*(?:request|cmd|msg|packet|buffer|arg|input|user)[^,)]*(?:->|\.)[^,)]+/gi,
    explanation:
      "FW_ASSERT compiles out when FW_ASSERT_LEVEL is set to FW_NO_ASSERT (some deployed flight builds). Using it to validate command arguments means validation disappears in release. This is a common flight-software trap.",
    verify_prompt:
      "Is the asserted condition validating UNTRUSTED external input (ground command argument, telemetry payload, file content)? If yes, CONFIRMED — assert is not the right tool. If it's asserting an INTERNAL invariant (state variable, previously-validated value, framework-provided fact), FALSE_POSITIVE.",
    cwe: "CWE-617",
    fix_template:
      "For ground-command validation, use `cmdResponse_OK/INVALID_OPCODE/FORMAT_ERROR` return codes. Keep FW_ASSERT for invariants that should never fail.",
  },

  // ── Cast narrowing without bounds check ─────────────────────────
  {
    id: "fsw-004-narrow-cast-no-check",
    title: "static_cast<U8/U16> from larger type without bounds check",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\bstatic_cast\s*<\s*(?:U8|U16|FwChanIdType|FwEventIdType|FwPacketDescriptorType|FwTlmPacketizeIdType|FwIndexType)\s*>\s*\(\s*[^)]+(?:msg->|cmd->|buf->|->\w+\.count|->\w+\.size)/g,
    explanation:
      "Narrowing cast from a larger integer to U8/U16 silently truncates on overflow. In flight SW this often bridges a wire protocol (U32 sequence count) to an in-memory index (U8 slot), and the truncation wraps to 0 on the 256th command.",
    verify_prompt:
      "Is there an upstream bounds check that constrains the source value to fit the target type (value < 256 for U8, < 65536 for U16) BEFORE the cast? If yes, FALSE_POSITIVE. If the cast is bare, CONFIRMED.",
    cwe: "CWE-197",
    fix_template:
      "Check first: `FW_ASSERT(src <= std::numeric_limits<U8>::max(), src); U8 dst = static_cast<U8>(src);`",
  },

  // ── Buffer::getData returned pointer not null-checked ───────────
  {
    id: "fsw-005-buffer-getdata-unchecked",
    title: "Fw::Buffer::getData() result used without null check",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\b(\w+)\.getData\s*\(\s*\)\s*(?:\[|->|\+)(?![\s\S]{0,300}?FW_ASSERT\s*\(\s*\1\.getData)/g,
    explanation:
      "Fw::Buffer can be null-allocated if BufferManager was exhausted. getData() returns nullptr in that case. Indexing into or dereferencing the pointer without a null check will crash the component (or worse, the flight computer if the SoC doesn't page-fault cleanly).",
    verify_prompt:
      "Is there an FW_ASSERT on getData() != nullptr, or an `if (... != nullptr)` guard, BEFORE the dereference? Also check: was the buffer JUST allocated from a source that guarantees non-null (e.g. stack-allocated array)? If guarded or guaranteed, FALSE_POSITIVE.",
    cwe: "CWE-476",
    fix_template:
      "`FW_ASSERT(buf.getData() != nullptr);` or `if (buf.getData() == nullptr) return;` before use.",
  },

  // ── Dispatch loop without queue overflow check ──────────────────
  {
    id: "fsw-006-dispatch-loop-unbounded",
    title: "Active component dispatch loop lacks message-count bound",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\bMsgDispatchStatus\s+[a-zA-Z_]\w*::doDispatch\s*\(\s*\)\s*\{[\s\S]{0,2000}?while\s*\(\s*(?:true|1)\s*\)/g,
    explanation:
      "An active component's doDispatch() with an unbounded `while(true)` can starve other threads on the same priority if one port's input is consistently busy. Flight software often needs a bounded drain-and-yield pattern.",
    verify_prompt:
      "Is the `while(true)` broken by a `MSG_DISPATCH_EMPTY` / `return` / yield within the body? If the loop consumes one message per iteration and exits when the queue is empty, FALSE_POSITIVE. If it genuinely spins, CONFIRMED.",
    cwe: "CWE-835",
    fix_template:
      "Make doDispatch() process at most N messages per call, returning MSG_DISPATCH_NEEDS_MORE_CYCLES to the scheduler.",
  },

  // ── FW_ASSERT with heavy expression ─────────────────────────────
  {
    id: "fsw-007-assert-with-side-effect",
    title: "FW_ASSERT condition contains side effect (stripped in release)",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\bFW_ASSERT\s*\(\s*[^)]*(?:\+\+|--|\.write\s*\(|\.send\s*\(|\.allocate\s*\()/g,
    explanation:
      "If FW_ASSERT compiles out (FW_NO_ASSERT build), any side effect in its condition disappears with it. A common subtle bug: `FW_ASSERT(queue.push(item))` works in debug and silently drops items in release.",
    verify_prompt:
      "Does the assert's condition mutate state or perform I/O? If the expression is a pure predicate (comparison, bit test, getter), FALSE_POSITIVE. If it's a `.push()`, `.allocate()`, `.write()`, or `++` in the asserted expression, CONFIRMED.",
    cwe: "CWE-489",
    fix_template:
      "Split: `auto ok = queue.push(item); FW_ASSERT(ok);` so the side effect survives regardless of assert level.",
  },

  // ── Time arithmetic without checking overflow ───────────────────
  {
    id: "fsw-008-time-ticks-overflow",
    title: "Tick-based time arithmetic without rollover handling",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\b(lastTick|startTime|epochTick|lastPacketTime|lastCmd(?:Time|Tick))\s*(?:\+|-)\s*\w+\s*(?:>|<|>=|<=)/g,
    explanation:
      "Direct subtraction of tick counts breaks at the rollover of the underlying type (U32 ticks at 1kHz rolls over in ~49 days, U16 in ~65 seconds). Flight missions hit this in production more than once.",
    verify_prompt:
      "Does the code use an unsigned subtraction (`now - last <= period`) which is rollover-safe? Or signed compare with cast that's also safe? If the arithmetic pattern is the unsigned-wraparound-safe idiom, FALSE_POSITIVE. If it's `last + period > now` (which WILL break on rollover), CONFIRMED.",
    cwe: "CWE-128",
    fix_template:
      "Use unsigned diff: `if (static_cast<U32>(now - last) >= period) ...` — wraparound makes this work.",
  },

  // ── Component state enum default case missing ───────────────────
  {
    id: "fsw-009-state-switch-default-missing",
    title: "Component-state switch has no default / FW_ASSERT fallthrough",
    severity: "low",
    languages: ["c", "cpp"],
    regex: /\bswitch\s*\(\s*(?:this->m_state|state\s*\.)\s*[^)]*\)\s*\{(?![\s\S]{0,3000}?(?:default\s*:|case\s+FWXXX_STATE_COUNT|FW_ASSERT\s*\(\s*0\s*\)))/g,
    explanation:
      "Flight state machines must handle ALL states. A switch on state without `default:` (or without FW_ASSERT(0) catching unknown values) silently does nothing when a new state is added but this site isn't updated. The bug manifests as 'component ignores commands in state X' long after deploy.",
    verify_prompt:
      "Does the switch have a `default:` clause, or does it explicitly enumerate every value of the state enum? If coverage is complete (all N cases present) or a default exists, FALSE_POSITIVE.",
    cwe: "CWE-478",
    fix_template:
      "Add `default: FW_ASSERT(0, static_cast<FwAssertArgType>(state));` as the last case — catches new states at runtime.",
  },

  // ── Ground-command parameter used before validation ─────────────
  {
    id: "fsw-010-cmd-arg-before-validate",
    title: "Ground-command argument used before cmdResponse check",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\b([A-Z_]\w+)_cmdHandler\s*\([^)]*const\s+(?:char\s*\*|Fw::CmdStringArg&|\w+StringArg&)\s+(\w+)[^)]*\)\s*\{[\s\S]{0,500}?\2(?![\s\S]{0,500}?this->cmdResponse_out)/g,
    explanation:
      "Ground commands arrive over the flight-link and are inherently untrusted. Using a command string argument (path, mode, sequence) before emitting cmdResponse_OK or at least length-checking it lets a malformed command corrupt state.",
    verify_prompt:
      "Before the first use of the command argument, is there a length check, range check, allowlist comparison, or conversion to a validated enum? If yes, FALSE_POSITIVE. If the argument is used raw (passed to open(), memcpy, path concat), CONFIRMED.",
    cwe: "CWE-20",
    fix_template:
      "Validate early; emit cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::VALIDATION_ERROR) on failure before any side effect.",
  },

  // ── Event / telemetry ID collision risk ─────────────────────────
  {
    id: "fsw-011-event-id-hardcoded",
    title: "Event / telemetry ID hardcoded instead of autocoded enum",
    severity: "low",
    languages: ["c", "cpp"],
    regex: /\b(?:log_ACTIVITY_|log_WARNING_|log_FATAL_|tlmWrite_)\w+\s*\(\s*\d+\s*,/g,
    explanation:
      "Autocoded event/telemetry dispatch uses symbolic IDs (e.g. `EVENTID_PING_RECEIVED`). Hardcoding a numeric ID bypasses the uniqueness check and will collide when the autocoder renumbers events. Subtle because the collision appears only on the ground-side decoder.",
    verify_prompt:
      "Is the numeric literal actually an opcode, priority, or other non-ID argument? If the first argument is semantically a severity/priority (not an event ID), FALSE_POSITIVE. If it's the event ID slot, CONFIRMED.",
    cwe: "CWE-1059",
    fix_template:
      "Use the autocoded enum: `EVENTID_<COMPONENT>_<NAME>` instead of a literal.",
  },

  // ── Missing FW_ASSERT after configure() in RAM partition setup ──
  {
    id: "fsw-012-configure-no-state-check",
    title: "Component method used before configure() completion check",
    severity: "medium",
    languages: ["c", "cpp"],
    // Only fire when the method actually uses component member state
    // (`this->m_<setup-initialized field>`). Otherwise the pattern
    // matches every helper function in the codebase, drowning real
    // findings in noise. Match the subset of members that require
    // configure() to have run: allocator, buffers, memory, ports.
    regex: /\bvoid\s+\w+::(?!configure|init|~)[a-z_]\w*\s*\([^)]*\)\s*\{(?=[\s\S]{0,1500}?this->m_(?:allocator|buffers?|memPtr|freeList|stateFileData|ports|pool|queue))(?![\s\S]{0,500}?(?:FW_ASSERT\s*\(\s*this->m_(?:configured|initialized|ready|setup)|if\s*\(\s*!\s*this->m_(?:configured|initialized|ready|setup)))/g,
    explanation:
      "Flight components have a two-phase init: constructor → configure(). Calling a method before configure() was called uses uninitialized member state — pointers are null, sizes are zero, buffers are unallocated.",
    verify_prompt:
      "Is this a method that can only be called after configure() (as opposed to getters, setters, the configure method itself, or handlers that are safe pre-config)? If it's a handler that would never fire before the port is connected, FALSE_POSITIVE. If it manipulates the allocator or configure-initialized state without guarding, CONFIRMED.",
    cwe: "CWE-665",
    fix_template:
      "Add at method start: `FW_ASSERT(this->m_configured, \"configure() must be called first\");`",
  },

  // ── Dangerous cast in handler ──────────────────────────────────
  {
    id: "fsw-013-reinterpret-cast-untrusted",
    title: "reinterpret_cast on untrusted data (no size check)",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\breinterpret_cast\s*<\s*(?:const\s+)?\w+\s*\*\s*>\s*\(\s*(?:buf|buffer|data|packet|payload|msg)[^)]*\.getData\s*\(\s*\)/g,
    explanation:
      "Reinterpret-casting a received buffer to a struct pointer without first verifying the buffer length ≥ sizeof(struct) reads off the end of the buffer. Common pattern in telemetry/packet decoders.",
    verify_prompt:
      "Is there a length check (`buf.getSize() >= sizeof(T)` or equivalent FW_ASSERT) immediately before the cast? If yes, FALSE_POSITIVE. If the cast is performed against a buffer of unknown size, CONFIRMED.",
    cwe: "CWE-125",
    fix_template:
      "Before the cast: `FW_ASSERT(buf.getSize() >= sizeof(TargetStruct), buf.getSize(), sizeof(TargetStruct));`",
  },

  // ── Unbounded telemetry string write ────────────────────────────
  {
    id: "fsw-014-tlm-string-write-unbounded",
    title: "snprintf into Fw::TextLogString with unbounded source",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\bsnprintf\s*\([^,]*Fw::TextLogString[^,]*,[^,]*,\s*"\s*%s[^"]*"\s*,\s*(?:request|msg->|cmd->|buf)/g,
    explanation:
      "Writing an untrusted string into a fixed-size log buffer with %s can truncate mid-UTF8 or leak parts of adjacent memory if the source isn't null-terminated. Telemetry downlinks are visible ground-side, so truncation artifacts can leak information.",
    verify_prompt:
      "Is the source guaranteed to be null-terminated (a Fw::StringBase derivative, a literal, or a value fresh from a null-terminating API)? If yes, FALSE_POSITIVE. If it's a raw buffer with unknown termination, CONFIRMED.",
    cwe: "CWE-170",
    fix_template:
      "Use Fw::StringBase::format with width specifier: `logStr.format(\"%.*s\", maxLen, src)`, or copy into a staging buffer with explicit terminator.",
  },

  // ── Heap allocation in real-time context ────────────────────────
  {
    id: "fsw-015-malloc-in-handler",
    title: "malloc / new in a real-time handler (port/cycle)",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\b(?:_handler|_cycleHandler)\s*\([^)]*\)\s*\{[\s\S]{0,1000}?\b(?:malloc|new\s+(?!(?:\w+::\w+)?\[)|calloc|realloc|std::make_unique|std::make_shared)\s*[(<]/g,
    explanation:
      "Heap allocation in a timing-critical path breaks determinism: malloc can take unbounded time on fragmented heaps, and some embedded allocators lock globally. Flight software convention uses pre-allocated pools.",
    verify_prompt:
      "Is the allocation inside the fast-path of a port handler or cycle handler, or is it in a setup/teardown method called only during configuration? If the allocation is on init-only paths, FALSE_POSITIVE. If it's inside data-plane handlers called per-packet or per-cycle, CONFIRMED.",
    cwe: "CWE-400",
    fix_template:
      "Use pre-allocated buffer pools (Fw::BufferManager, cFE memory pools). Move allocation to setup().",
  },
];
