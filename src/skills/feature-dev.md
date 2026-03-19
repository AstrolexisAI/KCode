---
name: feature-dev
description: "Structured 7-phase feature development workflow with agent assistance"
aliases: [fd, feature]
args: ["feature description"]
---
You are executing the /feature-dev workflow — a structured 7-phase feature development process.

This workflow guides you through building a feature from requirements to documentation, using specialized agents at key phases.

## Workflow Phases

### Phase 1: Discovery (current)
Understand the feature requirements and ask clarifying questions.

1. Analyze the feature request below.
2. Identify ambiguities or missing details.
3. Ask 3-5 clarifying questions that would affect the implementation.
4. Summarize your understanding and list acceptance criteria.
5. Tell the user: "Reply with answers to proceed to Phase 2: Exploration, or type /feature-dev to see progress."

### Phase 2: Exploration
Use the Agent tool to spawn a "code-explorer" agent to:
- Find similar features and patterns in the codebase
- Identify files that need modification
- Trace relevant call chains and APIs
Summarize findings and ask user to confirm before Phase 3.

### Phase 3: Architecture
Use the Agent tool to spawn a "code-architect" agent to:
- Design 2-3 implementation approaches with trade-offs
- Provide complexity estimates and risk assessments
- Recommend an approach
Present options and ask the user which approach to take.

### Phase 4: Implementation
Write the code following the chosen approach:
- Read each file before modifying
- Follow existing conventions found in Phase 2
- Keep changes minimal and focused

### Phase 5: Testing
Write and run tests:
- Unit tests for new functionality
- Run existing test suite for regressions: `bun test`
- Fix any failures

### Phase 6: Review
Use the Agent tool to spawn a "code-reviewer" agent to:
- Review all changes for bugs, security, and quality
- Output scored issues as JSON with confidence 0-100
- Parse the agent's output and show only issues with confidence >= 80%
- Address critical and high-severity issues before proceeding

### Phase 7: Documentation
- Update KCODE.md/CLAUDE.md if the feature affects documented architecture
- Add JSDoc to new public APIs
- Do NOT create new doc files unless explicitly requested
- Summarize all changes made

## Rules
- Always ask for user confirmation between phases (except Phase 7)
- Show phase progress: "Phase N/7: Name"
- Use the Agent tool with type "code-explorer", "code-architect", or "code-reviewer" for the specialized agents
- In Phase 6, use confidence scoring to filter review results — ignore issues below 80% confidence
- If the user says "skip" for any phase, move to the next one

{{#if args}}Feature request: {{args}}{{/if}}
{{^if args}}Please describe the feature you want to build.{{/if}}
