# Pi Subagent for Local LLMs

Serial, disposable subagents for Pi that preserve the parent transcript prefix.

This extension is aimed at a single locally hosted model where parallel inference or multiple independent KV caches would be too expensive. It lets a main agent delegate to a compact manager, and lets that manager delegate focused workers one at a time:

```text
main
  └─ manager
       ├─ worker: scout
       ├─ worker: implementation slice 1
       ├─ worker: implementation slice 2
       └─ worker: integration verification
```

Every child receives a JSONL snapshot of Pi's current session and its task is appended as a normal Pi user prompt. Pi continues to own the exact system prompt, messages, tool-call encoding, and provider request format. No llama.cpp patch is required.

## What this optimizes

A worker inherits the main and manager prefixes, does context-heavy work, and returns one bounded receipt. Its intermediate tool calls and messages do not enter the manager's continuing context. After the child exits, the next parent request has the same earlier prefix and llama.cpp can restore or reuse the matching cached state.

This extension preserves the conditions for prefix reuse; llama.cpp ultimately decides whether a request is restored from cache or reprocessed. Before a child model call, the extension compares hashes of the inherited message context, assembled system prompt, ordered active tool schemas, model, and thinking level. A known prefix mismatch fails closed instead of silently doing different work. A server-side cache miss can still reprocess an otherwise identical prefix.

The deepest live task still has to fit the model's context window. Nesting prevents completed sibling histories from accumulating; it does not make ancestor context disappear.

## Requirements

- Node.js 22.19 or newer
- Pi `@earendil-works/*` packages 0.80.6 or newer
- One shared working directory for the parent and all children

This branch uses Pi's current package namespace and extension API. It is a breaking compatibility change from older `@mariozechner/*` Pi installations.

## Install

```bash
pi install git:github.com/BenjaminBilbro/pi-subagent
```

For local development:

```bash
git clone https://github.com/BenjaminBilbro/pi-subagent.git
cd pi-subagent
npm install
npm test
npm run check
pi -e .
```

## The three tools

All three protocol tools are registered at extension load time at every depth, in the same order, with static schemas. Role differences are enforced at execution time so terminal workers do not receive a different provider prefix. On POSIX, a child-only replacement for Pi's built-in Bash execution backend is installed later during `session_start`, after Pi binds runtime actions; its provider-visible definition and active-tool position remain identical.

### `subagent`

Creates exactly one serial child process. The default depth is:

| Depth | Role | Can delegate? |
|---:|---|---|
| 0 | main | yes |
| 1 | manager | yes |
| 2 | worker | no |

Example manager task:

```typescript
subagent({
  name: "auth-manager",
  taskId: "auth-refactor",
  task: "Refactor the authentication API without changing its public behavior.",
  scope: ["src/auth", "test/auth"],
  nonGoals: ["Do not change session storage."],
  acceptance: [
    "Existing authentication tests pass.",
    "New refresh-token behavior has regression coverage."
  ],
  verification: ["npm test -- test/auth"],
  timeout: 600,
  maxTurns: 50
})
```

The manager can then call the same tool to create workers. Managers should stay small: use a disposable scout for broad repository exploration, then retain only its compact receipt.

Important behavior:

- Execution is sequential. The extension rejects another direct child while one is active.
- `subagent` must be the only tool call in its assistant message. Failure to verify that invariant rejects delegation.
- Reusing a name or explicit task ID already in the active ancestry is rejected by default.
- A different `cwd` is rejected. Pi includes working-directory data in its prompt construction, so changing it can invalidate prefix reuse.
- Child deadlines are absolute and cannot exceed the parent's remaining deadline.
- `timeout` defaults to 600 seconds and accepts 1–3600. `maxTurns` defaults to 50 and accepts 1–200.
- The focused task contract is byte-bounded for direct argument transport. Keep task text concise—especially on Windows—and write large reference material to files, then pass paths in `scope`.

### `agent_status`

Returns authoritative host-owned identity and budget state:

```json
{
  "kind": "pi-subagent-status",
  "role": "worker",
  "name": "auth-tests",
  "taskId": "auth-step-3",
  "depth": 2,
  "maxDepth": 2,
  "mayDelegate": false,
  "remainingMs": 172000,
  "maxTurns": 12
}
```

Every child is instructed to call this first. It solves role confusion without mutating the system prompt: the tool schema is constant and only its result is dynamic.

### `submit_result`

Managers and workers finish with one structured receipt:

```typescript
submit_result({
  status: "completed",
  summary: "Refactored token parsing and added expiry coverage.",
  changedFiles: ["src/auth/token.ts", "test/auth/token.test.ts"],
  checks: [{
    id: "auth-tests",
    status: "passed",
    command: "npm test -- test/auth",
    exitCode: 0,
    evidence: "42 tests passed"
  }],
  artifacts: [],
  unresolved: []
})
```

Valid result statuses are `completed`, `partial`, `blocked`, and `failed`. Only a consistent `completed` receipt followed by Pi's `agent_settled` event and a clean process exit is successful. A completed receipt cannot contain failed checks or unresolved issues.

Receipt checks are explicitly recorded as `agent-reported`. A later worker or manager should rerun important checks rather than trusting prose alone. Full logs and large artifacts should be written to files; only bounded evidence belongs in the receipt.

On current Pi, `submit_result` uses `terminate: true` to avoid an extra model turn. The parent requires Pi's successful, tool-call-correlated `submit_result` event and cross-checks it against an exclusive recovery file (mode 0600 on POSIX); a child-created file alone is not authoritative. The parent never depends on parsing free-form assistant text.

## TUI trace inspection

The default view stays compact. Press Ctrl+O on a `subagent` tool entry to inspect the complete serial run:

- the full task contract, including scope, non-goals, acceptance criteria, verification, timeout, and turn budget
- reasoning blocks and assistant text in their original order
- complete tool arguments and tool-result text
- recursively nested manager and worker traces
- structured receipts, reported checks, usage, duration, and failure state

Manager and worker headers use different depth colors, and nested traces remain visible after the disposable child process exits. While a manager is running a worker, Pi's partial tool state is also forwarded so expanded mode can show that worker live.

Pi stores this bounded diagnostic transcript in the tool result's UI-only `details`; the provider-facing result remains the compact receipt. It therefore increases session-file and renderer memory use, but does not add the trace to the model prompt or grow the KV cache. If the capture limit is reached, expanded mode marks that earlier trace entries were omitted.

## Context lifecycle

For a manager with two workers, the provider sees this serial shape:

```text
main prefix
  + manager task and work
    + worker 1 task and work
  ← worker 1 discarded; compact receipt appended to manager
    + worker 2 task and work
  ← worker 2 discarded; compact receipt appended to manager
← manager discarded; compact manager receipt appended to main
```

The extension does not manually construct provider messages. It serializes `sessionManager.getHeader()` plus `sessionManager.getBranch()`, starts another Pi process with that session, and asks Pi to append the task envelope.

To maximize a llama.cpp cache hit, keep these stable:

- working directory and prompt resource discovery
- Pi version and extension set/order
- active tool set
- model/provider and thinking level
- system-prompt files such as `AGENTS.md`

The extension forwards Pi's current model, thinking level, and exact active-tool order to each child. It uses Pi's own current CLI parser to inherit prompt/resource/trust settings while suppressing conflicting session and tool selectors. Editing prompt resources during a run causes the cache-prefix fingerprint to reject the child before its first provider call.

Pi auto-compaction is cancelled inside disposable child frames because pre-prompt compaction would replace the inherited prefix. If a manager is near its context limit, compact it before delegation rather than relying on a child to compact the fork.

## Safety and failure handling

KV/context rollback does not undo filesystem edits, shell commands, network requests, or spawned processes. Those are shared persistent state.

The host therefore provides:

- execute-time depth, cycle, and active-child guards
- absolute hierarchical deadlines
- real max-turn enforcement before the next provider call
- Unix TERM → KILL escalation, with Windows `taskkill /T /F` for the direct child tree
- a trusted depth-1 Unix process group containing the nested Pi stack, plus OS-anchored descendant cleanup for inner timeouts
- a live POSIX guardian for every built-in Bash invocation, pinning its process-group identity until deterministic cleanup
- an audit-only process registry that can trigger safe cleanup but can never add arbitrary PIDs to the signal set
- bounded JSON events, stderr, captured messages, model-facing fallbacks, tasks, and receipts
- cache-prefix fingerprints, successful-tool-event receipt correlation, and strict settlement/exit checks
- unexpected-signal, forged-recovery-file, and malformed-receipt failures

Each root delegation run creates a JSONL ledger in the operating system's temporary directory (mode 0600 on POSIX). `agent_status` and parent receipts expose its path. The ledger contains receipts and invocation metadata; a sibling `processes.jsonl` contains process audit records. Neither contains full model transcripts.

In a disposable POSIX child, each ordinary built-in Bash command runs in a guardian-owned group. The live guardian is the group leader, remains alive after the command shell returns, and treats loss of its private parent pipe as a cleanup request. It sends TERM, keeps the group identity reserved during the grace period, then sends KILL to the entire group including itself. A missing, mismatched, or unexpectedly exited guardian fails the child closed before another provider turn.

Custom tools—or bash commands that explicitly call `setsid`/daemonize again—must provide their own cleanup. Such processes leave the guardian's group; currently anchored descendants from other tools still receive best-effort cleanup. Preventing deliberate re-daemonization requires stronger operating-system isolation such as cgroups or job objects.

## Configuration

Root-process environment variables:

| Variable | Default | Description |
|---|---:|---|
| `PI_SUBAGENT_MAX_DEPTH` | `2` | Maximum delegation depth, from 0 through 8. |
| `PI_SUBAGENT_PREVENT_CYCLES` | `1` | Set to `0` to disable active-path name/task-ID cycle checks. |

Other `PI_SUBAGENT_*` variables are internal host protocol state and should not be set manually.

## Recommended workflow

For a larger change:

1. Main delegates one focused subsystem to a manager.
2. Manager delegates a scout that returns a code map and proposed slices.
3. Each implementation worker first verifies any prerequisite receipt, performs one slice, runs its checks, and submits a receipt.
4. A disposable integration worker checks the combined state.
5. Manager submits one bounded subsystem receipt.
6. Main continues with only the manager receipt in its growing context.

Size batches by receipt/context budget, not by a fixed number of tasks.

## Development

```bash
npm test       # unit and subprocess integration tests
npm run check  # strict TypeScript check against current Pi APIs
```

The tests cover valid and forged receipts, strict settlement and exit rules, current Pi CLI inheritance, task/receipt bounds, cache-prefix failures, max-turn termination, nested trace rendering, crash cleanup, nested timeout cleanup, Pi's real extension-load/session-start order, provider-identical Bash replacement, and guardian cleanup after completion, timeout, abort, concurrency, and child `SIGKILL`.

See [docs/protocol.md](docs/protocol.md) for the frame, task, receipt, and process-lifecycle protocol.

## Files

```text
index.ts          Extension hooks and the three static tools
bash-guardian.js  Live POSIX process-group owner for child Bash commands
protocol.ts       Frames, task envelopes, receipts, ledger, process registry
runner.ts         Pi subprocess lifecycle and bounded event transport
runner-cli.js     Stable parent CLI/resource inheritance
runner-events.js  Pi JSON event parsing and bounded message capture
render.ts         Depth-aware task, reasoning, tool I/O, and nested trace rendering
types.ts          Result state and semantic normalization
```

## Attribution

Originally forked from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent).

## License

MIT
