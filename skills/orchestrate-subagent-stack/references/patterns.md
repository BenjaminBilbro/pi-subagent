# Subagent Orchestration Patterns

Use these templates as shapes, not boilerplate to copy blindly. Replace every scope, criterion, command, and budget with task-specific values.

## Contents

- [Manager contract](#manager-contract)
- [Scout contract](#scout-contract)
- [Implementation contract](#implementation-contract)
- [Dependent worker contract](#dependent-worker-contract)
- [Integration verifier contract](#integration-verifier-contract)
- [Receipt patterns](#receipt-patterns)
- [Queue and batch pattern](#queue-and-batch-pattern)
- [Recovery pattern](#recovery-pattern)
- [Anti-patterns](#anti-patterns)

## Manager contract

Delegate a coherent subsystem, not the entire project:

```typescript
subagent({
  name: "auth-manager",
  taskId: "auth-refresh-refactor",
  task: "Coordinate and complete the refresh-token refactor while preserving the public authentication API.",
  scope: ["src/auth", "test/auth"],
  nonGoals: [
    "Do not change session storage.",
    "Do not redesign unrelated login UI."
  ],
  acceptance: [
    "Refresh-token parsing has one implementation path.",
    "Existing authentication behavior remains covered.",
    "An integration check validates the combined changes."
  ],
  verification: ["npm test -- test/auth"],
  timeout: 900,
  maxTurns: 40
})
```

Ask the manager to decide slices and verification ownership. Do not prescribe arbitrary worker counts.

## Scout contract

Use a scout when the manager would otherwise accumulate broad read/search output:

```typescript
subagent({
  name: "auth-scout",
  taskId: "auth-refresh-scout",
  task: "Map the current refresh-token flow and propose independently verifiable implementation slices. Do not edit files.",
  scope: ["src/auth", "test/auth", "package.json"],
  nonGoals: ["Do not implement fixes or reformat files."],
  acceptance: [
    "Identify entry points, shared types, tests, and dependency order.",
    "Cite exact paths and symbols for every proposed slice.",
    "List ambiguous behavior and likely regression risks."
  ],
  verification: ["Confirm every cited path and symbol exists."],
  timeout: 240,
  maxTurns: 12
})
```

The scout receipt should be a compact map. Put lengthy notes in a project artifact only if later workers genuinely need them.

## Implementation contract

Give one worker a cohesive edit plus scoped checks:

```typescript
subagent({
  name: "token-parser-worker",
  taskId: "auth-refresh-parser",
  task: "Consolidate refresh-token parsing behind the existing parser interface and add focused regression coverage.",
  scope: ["src/auth/token.ts", "test/auth/token.test.ts"],
  nonGoals: [
    "Do not change exported API names.",
    "Do not modify session persistence."
  ],
  acceptance: [
    "All refresh-token parsing uses the consolidated path.",
    "Malformed and expired tokens have regression tests.",
    "No unrelated files change."
  ],
  verification: [
    "npm test -- test/auth/token.test.ts",
    "npm run check"
  ],
  timeout: 420,
  maxTurns: 20
})
```

## Dependent worker contract

State the relevant prior conclusion, then require direct validation:

```typescript
subagent({
  name: "refresh-handler-worker",
  taskId: "auth-refresh-handler",
  task: "Update the refresh handler to consume the consolidated parser. The prior worker reports that src/auth/token.ts now owns parsing; verify that interface before editing the handler.",
  scope: ["src/auth/refresh.ts", "src/auth/token.ts", "test/auth/refresh.test.ts"],
  nonGoals: ["Do not rewrite the parser unless its reported interface is invalid."],
  acceptance: [
    "Begin by confirming the parser interface and focused parser tests.",
    "The handler contains no duplicate parsing logic.",
    "Refresh behavior passes focused tests."
  ],
  verification: [
    "npm test -- test/auth/token.test.ts",
    "npm test -- test/auth/refresh.test.ts"
  ],
  timeout: 420,
  maxTurns: 20
})
```

This validates the prerequisite early in the consumer's disposable context.

## Integration verifier contract

Keep the verifier read-only unless the manager explicitly delegates a repair:

```typescript
subagent({
  name: "auth-integration-verifier",
  taskId: "auth-refresh-integration",
  task: "Independently verify the completed refresh-token refactor against the subsystem acceptance criteria. Report failures with exact reproduction evidence; do not repair them.",
  scope: ["src/auth", "test/auth", "git diff"],
  nonGoals: ["Do not edit files or weaken tests."],
  acceptance: [
    "Inspect the combined diff for scope violations.",
    "Run focused and subsystem-level checks.",
    "Tie each acceptance criterion to observed evidence."
  ],
  verification: [
    "npm test -- test/auth",
    "npm run check"
  ],
  timeout: 480,
  maxTurns: 16
})
```

If it fails, use its evidence to create a separate narrow recovery task.

## Receipt patterns

Successful worker:

```typescript
submit_result({
  status: "completed",
  summary: "Consolidated refresh-token parsing and added malformed/expired token coverage.",
  changedFiles: ["src/auth/token.ts", "test/auth/token.test.ts"],
  checks: [
    {
      id: "focused-tests",
      status: "passed",
      command: "npm test -- test/auth/token.test.ts",
      exitCode: 0,
      evidence: "18 tests passed."
    },
    {
      id: "types",
      status: "passed",
      command: "npm run check",
      exitCode: 0
    }
  ],
  artifacts: [],
  unresolved: []
})
```

Partial worker:

```typescript
submit_result({
  status: "partial",
  summary: "Implemented the parser consolidation; the focused test command cannot start because the test fixture package is missing.",
  changedFiles: ["src/auth/token.ts", "test/auth/token.test.ts"],
  checks: [
    {
      id: "focused-tests",
      status: "failed",
      command: "npm test -- test/auth/token.test.ts",
      exitCode: 1,
      evidence: "Module test-auth-fixtures was not found before test discovery."
    }
  ],
  artifacts: [],
  unresolved: ["Restore or replace the missing test-auth-fixtures dependency, then rerun focused tests."]
})
```

## Queue and batch pattern

For a large queue, keep only the current batch in an active manager:

1. Have the main agent define the batch objective, invariant checks, and durable progress artifact.
2. Delegate one batch manager with a bounded range of queue items.
3. Let that manager process items serially with focused workers.
4. Require each worker to update durable output and report item IDs handled.
5. Use a final batch verifier to check completeness, duplicates, and invariant violations.
6. Have the manager submit a batch receipt containing counts, artifact paths, checks, and failed item IDs.
7. Start the next manager from the durable artifact and prior compact receipt.

Do not place hundreds of raw items in every worker prompt. Store the queue in a file or database and identify the assigned slice by stable keys.

## Recovery pattern

Convert failure evidence into a smaller contract:

1. Classify the failure as implementation, verification environment, scope conflict, missing prerequisite, timeout, or protocol failure.
2. Inspect persisted files before assuming the failed worker made no changes.
3. Preserve valid work and name the exact remaining defect.
4. Delegate a recovery worker with the failing command and evidence in its task.
5. Require the recovery worker to reproduce the failure before changing code when practical.
6. Run an independent verifier after repairs that crossed worker boundaries.

## Anti-patterns

| Avoid | Replace with |
|---|---|
| "Explore the repo and fix everything related to auth." | A scout map followed by file-bounded implementation workers. |
| One worker per command or file read. | One worker per meaningful, independently checkable outcome. |
| Manager performs broad searches, edits, and full tests itself. | Manager retains decisions and receipts; disposable workers perform noisy work. |
| Worker 2 trusts worker 1's prose. | Worker 2 validates the prerequisite artifact before consuming it. |
| Verifier says the diff “looks good.” | Verifier runs observable checks and ties evidence to acceptance criteria. |
| Retry the same failed prompt. | Create a narrower recovery contract from exact failure evidence. |
| Put full logs in receipts. | Persist logs as artifacts and include short evidence plus paths. |
| Mark blocked work completed. | Use `partial`, `blocked`, or `failed` with concrete unresolved items. |
