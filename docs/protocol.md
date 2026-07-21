# Serial Subagent Protocol v1

This document describes the host protocol used by the extension. It deliberately sits above Pi's conversation and provider layers: Pi remains the only component that constructs system prompts, conversation messages, tool calls, and provider payloads.

## Invariants

The extension maintains these cache-sensitive invariants:

1. `subagent`, `agent_status`, and `submit_result` are registered unconditionally at extension load time and in the same order at every depth.
2. The `before_agent_start` prompt addition is byte-for-byte constant.
3. Dynamic role and task data appears only in the appended child user message or tool results.
4. Parent and child use the same working directory, model, thinking level, active tools, extensions, and inherited CLI resources.
5. A frame has at most one active direct child. Model inference remains serial.
6. Parent continuation contains a bounded receipt, never the child's complete event history.
7. Before the first child provider call, hashes of the inherited message context, assembled system prompt, ordered tool schemas, model, and thinking level must match the parent values.
8. Disposable child frames never compact their inherited branch.
9. During child `session_start`, after Pi binds runtime actions, the POSIX built-in Bash backend is replaced with a provider-identical definition before prompt/tool hashing or provider use. Its active-tool position is unchanged.

Role restrictions are host checks. They do not depend on the model correctly understanding its role.

## Frame state

The parent serializes one canonical frame into `PI_SUBAGENT_FRAME`:

```typescript
interface AgentFrameV1 {
  kind: "pi-subagent-frame";
  protocolVersion: 1;

  rootRunId: string;
  runId: string;
  parentRunId: string | null;

  role: "main" | "manager" | "worker";
  name: string;
  taskId: string | null;

  depth: number;
  maxDepth: number;
  stack: string[];
  taskStack: string[];

  deadlineAtMs: number | null;
  maxTurns: number | null;
  ledgerPath: string | null;
  preventCycles: boolean;
}
```

The root has no inherited frame. It creates a main frame at depth zero. Child roles are derived rather than accepted from model input:

```text
depth == 0         → main
0 < depth < max   → manager
depth == max       → worker
```

With the default maximum of two, this is main → manager → worker. Increasing the maximum creates additional manager levels before the terminal worker.

Malformed inherited state fails closed as a non-delegating invalid frame. It never falls back to a new main frame.

Compatibility mirrors (`PI_SUBAGENT_DEPTH`, `PI_SUBAGENT_MAX_DEPTH`, and `PI_SUBAGENT_STACK`) are emitted for inspection and interoperability, but the canonical JSON frame is authoritative.

## Child task message

After snapshotting Pi's session, the runner asks Pi to append one user message:

```text
[PI_SUBAGENT_RUN_FRAME_V1]
{"kind":"pi-subagent-frame", ...public frame fields...}
[/PI_SUBAGENT_RUN_FRAME_V1]

[PI_SUBAGENT_TASK_SPEC_V1]
{"kind":"pi-subagent-task", ...task contract...}
[/PI_SUBAGENT_TASK_SPEC_V1]

Call agent_status before starting. ...
```

The private ledger path, ancestry, and root identifiers do not need to be repeated in this user message. `agent_status` exposes the relevant authoritative state.

The task contract contains the following fields and is capped at 20 KiB after JSON encoding because the runner transports it as one direct Pi command-line argument:

```typescript
interface TaskSpecV1 {
  kind: "pi-subagent-task";
  protocolVersion: 1;
  taskId: string;
  name: string;
  objective: string;
  scope: string[];
  nonGoals: string[];
  acceptance: string[];
  verification: string[];
}
```

## Delegation transaction

`subagent.execute` performs the following transaction:

1. Reject a malformed frame, submitted parent receipt, terminal role, depth overflow, active child, active-path cycle, or different working directory.
2. Require the current assistant entry to contain exactly this one tool call. If that cannot be verified, fail closed rather than snapshotting unresolved sibling calls.
3. Lazily create the root ledger.
4. Derive a child deadline no later than the parent deadline minus a small return margin.
5. Construct the child frame and task contract.
6. Serialize `sessionManager.getHeader()` followed by `sessionManager.getBranch()` without rewriting entries.
7. Hash the provider-relevant inherited messages, full prompt visible to this extension, active tool schemas, model, and thinking level.
8. Start one Pi child in JSON mode with the snapshot, task message, and expected hash envelope.
9. At child `session_start`, install the provider-identical guarded Bash backend when the configured `bash` tool is Pi's built-in definition.
10. In the child, compare the context, fully assembled prompt, ordered post-installation tool schemas, model, and thinking hashes; abort at `turn_start` before a provider call on mismatch.
11. Register the child PID in the shared audit registry.
12. Wait for natural exit, `agent_settled`, settlement watchdog, timeout, abort, or turn-limit termination.
13. Capture Pi's successful `submit_result` tool event and correlate its tool-call ID to an observed assistant tool call.
14. Cross-check the event details against the exclusive recovery file and host-owned frame identity.
15. Append invocation metadata to the ledger.
16. Return only a bounded receipt projection, or an explicit failure envelope, to the parent.

The `executionMode: "sequential"` declaration asks current Pi to serialize the entire tool batch. A module-local active-child guard remains the authoritative fallback.

## Receipt

`submit_result` accepts model-authored work information, then adds host identity:

```typescript
interface TaskReceiptV1 {
  kind: "pi-subagent-receipt";
  protocolVersion: 1;

  receiptId: string;
  rootRunId: string;
  runId: string;
  parentRunId: string;
  taskId: string;
  role: "manager" | "worker";
  name: string;
  submittedAtMs: number;

  status: "completed" | "partial" | "blocked" | "failed";
  summary: string;
  changedFiles: string[];
  checks: Array<{
    id: string;
    status: "passed" | "failed" | "skipped";
    command?: string;
    exitCode?: number;
    evidence?: string;
    source: "agent-reported";
  }>;
  artifacts: string[];
  unresolved: string[];
}
```

The extension writes this receipt once using an exclusive recovery file (mode 0600 on POSIX). Because a child with shell access can inspect its own environment, that file is not an authentication boundary. The authoritative path is Pi's successful `tool_execution_end` event for `submit_result`, correlated to the observed assistant tool-call ID and followed by `agent_settled`. The file must match the event exactly. The tool also appends the receipt to the audit ledger and returns `terminate: true`.

Completion rules are intentionally strict:

- consistent `completed` receipt + `agent_settled` + clean process exit: success
- `partial`, `blocked`, or `failed` receipt: completed report, failed task
- missing required receipt: protocol failure
- `completed` with a failed check or unresolved item: rejected as contradictory
- timeout, abort, max-turn marker, cache mismatch, process failure, nonzero exit, or unexpected signal: failure even if a receipt file exists

There is no model-facing switch to disable receipts. The runner retains an internal legacy option only for isolated compatibility tests.

## Deadlines and turn budgets

Timeouts are stored as absolute epoch deadlines. A manager cannot give each worker a fresh timeout that outlives the manager:

```text
childDeadline = min(now + requestedTimeout, parentDeadline - returnMargin)
```

The child extension keeps a process-lifetime `turnsStarted` count across Pi retries and low-level agent runs. Once the count exceeds `maxTurns`, it writes a private marker and aborts before another provider call. The parent runner treats that marker as `max_turns`; a configured numeric limit is never confused with an exceeded boolean state.

`session_before_compact` is cancelled for managers and workers. Threshold, overflow, or manual compaction inside a disposable child would replace the inherited branch and invalidate KV-prefix reuse. A parent should compact before delegating if it is already near the context limit.

## Process registry and termination

On Unix, only a depth-1 child is started as a new process-group leader. Every deeper Pi child inherits that group. A root timeout can therefore signal the trusted group ID obtained directly from `spawn()` and tear down the serial stack without trusting child-authored PIDs.

Pi's built-in Bash backend intentionally starts each shell as a separate Unix process-group leader. In disposable POSIX child frames, this extension detects that built-in during `session_start` and replaces only its operations. `createBashToolDefinition` still supplies the same name, description, parameters, prompt snippet, guidelines, rendering, settings prefix, and result behavior, so the provider-facing tool and system-prompt contribution remain stable.

For each command, the replacement starts a bundled Node guardian with `detached: true`. The guardian is both a directly tracked `ChildProcess` and the new process-group leader. After reporting a matching `READY` identity over a private status pipe, it launches Pi's configured shell with `detached: false` and only file descriptors 0–2. Original model tool-call arguments are never mutated. The guardian reports the command shell's exit code but remains alive, so ordinary background jobs may outlive the shell without allowing the numeric group ID to be reused.

On command timeout/abort, `agent_settled`, or session shutdown, the extension asks each guardian to clean its group. The guardian ignores TERM itself, sends TERM group-wide, holds the identity live for the bounded grace period, and then sends KILL group-wide including itself. If the child Pi crashes or receives `SIGKILL`, the guardian's private control pipe reaches EOF and triggers the same cleanup. The host retains the actual live `ChildProcess` handle and never signals its numeric group ID after that guardian closes. Identity mismatch, unexpected guardian exit, or setup failure is a containment failure and aborts before another provider turn.

All frames also share a `processes.jsonl` audit registry beside the receipt ledger (mode 0600 on POSIX). Each runner records `started` and `stopped` events containing run IDs, parent run IDs, and positive PIDs. Registry records can indicate that cleanup is necessary, but they never expand the set of signal targets. This prevents a corrupt or forged record from causing the host to signal an unrelated process.

For an inner timeout, the runner supplements its trusted direct child PID with only descendants whose current OS PPID ancestry reaches that child. It sends `SIGTERM`, waits a bounded grace period, rechecks, then sends `SIGKILL`. If ancestry cannot be proven, cleanup fails safely rather than targeting an arbitrary PID.

Windows uses `taskkill /T /F` for the direct child tree.

Custom tools, or model-authored commands that explicitly call `setsid` or daemonize again into another independent group, leave guardian containment and must implement their own cleanup. The runner still performs best-effort cleanup for descendants whose current OS ancestry remains anchored to its trusted child. Preventing deliberate re-daemonization requires stronger OS facilities such as cgroups or job objects.

The registry is host control state, not model context.

## Bounded data

The protocol bounds:

- names, task IDs, objectives, and task-contract arrays;
- receipt summaries, arrays, evidence, and total receipt bytes;
- individual JSON event lines;
- retained assistant/tool-result messages and deduplication signatures;
- stderr and model-facing fallback text;
- the process registry.

The provider-facing parent result retains only the compact receipt. Separately, bounded assistant and tool-result messages are retained in the tool result's UI-only `details` so Pi can render reasoning, tool I/O, and nested traces after a child exits. Provider adapters do not send these diagnostic details to the model, so they do not grow the KV context, although they do increase session-file and renderer memory use. The full structured receipt also remains in the temporary audit ledger.

Full artifacts should be written to project or temporary files and referenced by path.

## Cache boundary

The extension does not issue llama.cpp KV operations. Its responsibility is to present Pi/llama.cpp with an unchanged prefix and a new suffix. `PI_SUBAGENT_CACHE_INVARIANT` carries SHA-256 hashes for the inherited provider messages, assembled prompt, ordered active tool definitions, model, and thinking level; a child writes a private diagnostic marker and aborts before inference if they differ.

Those hashes cover Pi state visible to this extension. Another extension that mutates `context` or `before_provider_request` differently by process mode or environment can still change the final provider payload after the check. Keep such extensions deterministic across parent and child and confirm actual llama.cpp cache metrics during benchmarking.

Useful future benchmark metrics include prompt tokens evaluated, cached tokens reused, time to first token, peak KV/RAM/VRAM, and correctness. Cache behavior should be measured separately from protocol correctness.

## Persistent side effects

Dropping a child context does not revert files or processes. Receipts and the ledger make side effects inspectable, but they do not create filesystem transactions. Managers should use narrow scopes, inspect existing changes, and delegate an integration worker to rerun important checks over the combined workspace state.
