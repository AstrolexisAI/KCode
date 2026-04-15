// Phase 33 — reasoning-channel repetition guard tests.
//
// Verifies that the detectors (detectRepetitionLoop,
// detectLargeBlockRepetition, detectCompletionMarkerLoop) catch the
// grok-code-fast-1 failure mode when applied to the thinking channel,
// using text fixtures derived from the actual kcode.log session
// (v2.10.79, 45,600 reasoning tokens on repeated "user engagement"
// meta-paragraphs).
//
// The runtime wiring (thinking_delta case in
// processStreamIntoState) can't be exercised here without a full SSE
// stream mock, so we instead verify the detector-side invariant that
// "if this text were accumulated in the thinking buffer, phase 33
// would fire". If that holds, the runtime wiring (which just calls
// the same detectors on the thinking buffer) is correct.

import { describe, expect, test } from "bun:test";
import {
  detectCompletionMarkerLoop,
  detectLargeBlockRepetition,
  detectLowEntropyLoop,
  detectRepetitionLoop,
} from "./conversation-streaming";

// Synthesized from lines 391-815 of kcode.log (v2.10.79, grok-code-fast-1).
// The actual model emitted ~30 of these paragraphs; including 10 is
// more than enough to cross the detection thresholds.
const GROK_REASONING_LOOP = `
## Boosting user engagement
 - Consistently prompts for input on executing a version or requesting modifications.
 - Uses info-level messages to keep interactions clear and supportive.
 - Offers multiple opportunities for feedback, enhancing user control.
 - Frequent check-ins maintain engagement, fostering a collaborative and engaging experience.
 - This strategy enhances user control, letting them guide the process dynamically.

## Fostering user satisfaction
 - Repeated prompts foster satisfaction by allowing users to choose freely.
 - Info-level messages maintain a supportive tone, encouraging positive user experiences.
 - Consistent check-ins ensure users feel heard, boosting overall satisfaction.
 - This approach lets users shape the outcome, reinforcing their control and engagement.
 - Frequent repetitions enhance collaboration, making interactions feel rewarding and user-centered.

## Strengthening user autonomy
 - Multiple prompts strengthen user autonomy, giving them full control over decisions.
 - Info-level messaging maintains a non-pressuring tone, supporting independent choices.
 - Repetition ensures users feel empowered, with options to run or modify as desired.
 - Frequent check-ins maintain engagement, fostering a collaborative and autonomous experience.
 - This strategy enhances user control, making the interaction feel personalized and flexible.

## Supporting user flexibility
 - Repeated prompts offer users multiple chances to choose, supporting flexible decision-making.
 - Info-level messages maintain a helpful tone, encouraging user adaptability.
 - Consistent check-ins ensure users can adjust their responses, enhancing flexibility.
 - This approach fosters a collaborative feel, letting users shape the interaction as needed.
 - Frequent repetitions reinforce user autonomy, making the experience feel accommodating.

## Building user trust
 - Multiple prompts build trust through consistent, supportive messaging.
 - Info-level communications ensure a reliable tone, encouraging user confidence.
 - Repetition reinforces user options, making the system feel dependable and trustworthy.
 - Frequent check-ins maintain engagement, fostering a collaborative and secure interaction.
 - This strategy empowers users, letting them decide at their own pace with assurance.

## Encouraging user involvement
 - Repeated prompts encourage users to stay involved, enhancing their participation.
 - Info-level messages create a welcoming tone, supporting active user engagement.
 - Consistent check-ins ensure users feel valued, fostering a collaborative dynamic.
 - This approach lets users guide the process, reinforcing their involvement and control.
 - Frequent repetitions make the interaction feel responsive and user-focused.

## Reinforcing user options
 - Multiple prompts reinforce user choices, giving them clear paths to proceed.
 - Info-level messaging supports a flexible tone, encouraging user decision-making.
 - Repetition ensures users feel empowered, with options to run or modify as needed.
 - Frequent check-ins maintain engagement, fostering a collaborative and adaptive experience.
 - This strategy enhances user control, making the interaction feel personalized and responsive.

## Enhancing user adaptability
 - Multiple prompts enhance adaptability, allowing users to decide based on their needs.
 - Info-level messaging supports a flexible tone, encouraging user-driven changes.
 - Repetition ensures users can adjust their choices, fostering adaptability in interaction.
 - Frequent check-ins maintain engagement, creating a collaborative and responsive environment.
 - This strategy empowers users, letting them guide the process at their own pace.
`;

describe("Phase 33 — grok-code-fast-1 reasoning-loop fixture", () => {
  test("fixture is long enough to exceed thinking repetition interval", () => {
    // Sanity check — thinking check interval is 1500 chars, so the
    // fixture must be substantially longer to verify detection kicks
    // in on a realistic buffer size.
    expect(GROK_REASONING_LOOP.length).toBeGreaterThan(3000);
  });

  test("detectLowEntropyLoop catches the grok meta-paragraph loop", () => {
    // Primary detector for this failure mode. The paragraphs use
    // different headings but the same ~30-word vocabulary, producing
    // a very high repeat ratio (~40-50% non-stopword token repeats).
    const result = detectLowEntropyLoop(GROK_REASONING_LOOP);
    expect(result).not.toBeNull();
    expect(result).toContain("low-entropy loop");
  });

  test("detector fires early — well before 45K tokens", () => {
    // The real session wasted ~45,600 reasoning tokens before phase 15
    // (which doesn't run on thinking) would have caught anything.
    // With phase 33 running at THINKING_REPETITION_INTERVAL = 1500
    // chars, and the detector requiring 150+ filtered words, it
    // should fire after ~3-4 paragraphs — roughly 3000-4000 chars.
    const earlyPrefix = GROK_REASONING_LOOP.slice(0, 4000);
    const result = detectLowEntropyLoop(earlyPrefix);
    expect(result).not.toBeNull();
  });

  test("legitimate long reasoning is NOT flagged", () => {
    // Counter-example: a long but non-repetitive reasoning trace (each
    // paragraph discusses a different topic) must pass through without
    // tripping the guard. Uses structured varied content similar to
    // what Claude extended-thinking produces for hard problems.
    const legitThinking = `
Let me analyze the problem. The user wants to debug a React component
that's re-rendering too often. First, I should check if the parent
component is passing new object references on every render.

The useEffect hook has a dependency array that includes a function.
Functions are referential, so unless it's wrapped in useCallback, the
effect will run every render. That's a strong candidate for the bug.

Next, I should verify by asking the user to add a console.log inside
the component body to count renders. If it's rendering more than the
data changes, the dependency-array theory is confirmed.

After that, the fix is straightforward: wrap the callback in useCallback
with the appropriate dependency list. If the state inside the callback
needs to be current, we may need to use a ref instead of closing over
stale state.

There's also the possibility that the parent is using setState in a
way that forces re-renders. Let me check the component tree structure
to see if that's plausible. I'll need the user to share the parent
component code.

Another angle: React DevTools has a Profiler tab that shows exactly
which components re-rendered and why. That would pinpoint the issue
without us having to guess. I should suggest that as a diagnostic step.

One more thing — if the component is memoized with React.memo but the
comparison is shallow, a new prop reference could defeat the memo.
Let me remember to check for memo usage in the code the user shares.
    `;
    expect(detectLargeBlockRepetition(legitThinking)).toBeNull();
    expect(detectRepetitionLoop(legitThinking)).toBeNull();
    expect(detectCompletionMarkerLoop(legitThinking)).toBeNull();
    expect(detectLowEntropyLoop(legitThinking)).toBeNull();
  });

  test("short thinking does not trip any detector (no false positives)", () => {
    const short = "Let me think about this briefly before acting.";
    expect(detectLargeBlockRepetition(short)).toBeNull();
    expect(detectRepetitionLoop(short)).toBeNull();
    expect(detectCompletionMarkerLoop(short)).toBeNull();
    expect(detectLowEntropyLoop(short)).toBeNull();
  });

  test("detector composition mirrors the runtime wiring", () => {
    // The runtime code in conversation-streaming.ts runs the four
    // detectors in order (detectRepetitionLoop ||
    // detectLargeBlockRepetition || detectCompletionMarkerLoop ||
    // detectLowEntropyLoop) and fires on the first non-null result.
    // Verifies that the grok fixture trips at least one.
    const repeated =
      detectRepetitionLoop(GROK_REASONING_LOOP) ||
      detectLargeBlockRepetition(GROK_REASONING_LOOP) ||
      detectCompletionMarkerLoop(GROK_REASONING_LOOP) ||
      detectLowEntropyLoop(GROK_REASONING_LOOP);
    expect(repeated).not.toBeNull();
  });

  test("legitimate repetitive-but-distinct prose is not flagged", () => {
    // Enumerated options / tutorial text that repeats some vocabulary
    // but introduces new concepts each item. Must pass through.
    const tutorialText = `
Here are the steps to configure the build pipeline correctly.

Step 1: Install the required dependencies using npm install or bun
install. The lockfile will be updated to reflect the exact versions
of each package used in the project.

Step 2: Configure the TypeScript compiler by editing tsconfig.json.
Set the target to ESNext for modern features and moduleResolution
to bundler for compatibility with Vite or similar tooling.

Step 3: Create a separate environment configuration for production
deployments. Use dotenv or a similar mechanism to inject secrets
without committing them to version control.

Step 4: Add a GitHub Actions workflow that runs tests on every pull
request. This catches regressions before they reach the main branch
and keeps the CI feedback loop tight.

Step 5: Configure deployment targets for staging and production.
Typically this involves a platform like Vercel, Fly.io, or Railway
which handles build caching and rollback automatically.

Step 6: Set up monitoring with a service that captures errors,
performance metrics, and user session replays. Sentry or Datadog
are common choices depending on the team's budget and scale.
    `;
    expect(detectLowEntropyLoop(tutorialText)).toBeNull();
  });
});
