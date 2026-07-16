import test from "node:test";
import assert from "node:assert/strict";
import { compactResultForSession, isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function makeResult(overrides = {}) {
  return {
    agent: "oracle",
    agentSource: "user",
    task: "repro",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

function makeReceipt(overrides = {}) {
  return {
    kind: "pi-subagent-receipt",
    protocolVersion: 1,
    receiptId: "receipt-1",
    rootRunId: "root-1",
    runId: "run-1",
    parentRunId: "parent-1",
    taskId: "task-1",
    role: "worker",
    name: "oracle",
    submittedAtMs: 1,
    status: "completed",
    summary: "Done.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    unresolved: [],
    ...overrides,
  };
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me check that for you." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats agent_end with final assistant output as semantic success", () => {
  const result = makeResult({
    exitCode: 0,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    pendingToolError: "Command exited with code 1",
    sawAgentEnd: true,
    sawAgentSettled: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult keeps cancellation authoritative after a submitted receipt", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    receiptRequired: true,
    receipt: makeReceipt(),
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subagent was aborted.");
  assert.equal(result.stderr, "Subagent was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult handles timeout", () => {
  const result = makeResult({
    exitCode: 124,
    timeout: true,
    stopReason: "timeout",
    errorMessage: "Sub-agent timed out after 120s",
    stderr: "Sub-agent timed out after 120s",
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 124);
  assert.equal(result.stopReason, "timeout");
  assert.equal(result.errorMessage, "Sub-agent timed out after 120s");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult handles max turns exceeded", () => {
  const result = makeResult({
    exitCode: 1,
    maxTurnsLimit: 50,
    maxTurnsExceeded: true,
    stopReason: "max_turns",
    errorMessage: "Sub-agent exceeded maximum turns (50)",
    stderr: "Sub-agent exceeded maximum turns (50)",
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.errorMessage, "Sub-agent exceeded maximum turns (50)");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("isResultSuccess returns false for timeout even with semantic completion", () => {
  const result = makeResult({
    exitCode: 124,
    timeout: true,
    stopReason: "timeout",
    sawAgentEnd: true,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
  });

  assert.equal(isResultSuccess(result), false);
});

test("isResultSuccess returns false for max_turns even with semantic completion", () => {
  const result = makeResult({
    exitCode: 1,
    maxTurnsLimit: 50,
    maxTurnsExceeded: true,
    stopReason: "max_turns",
    sawAgentEnd: true,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
  });

  assert.equal(isResultSuccess(result), false);
});

test("a required missing receipt is a protocol failure", () => {
  const result = makeResult({
    exitCode: 0,
    sawAgentEnd: true,
    receiptRequired: true,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "missing_receipt");
  assert.equal(isResultError(result), true);
});

test("a partial structured receipt remains visible as a failed task", () => {
  const result = makeResult({
    exitCode: 0,
    receiptRequired: true,
    sawAgentSettled: true,
    receipt: makeReceipt({ status: "partial", summary: "Implementation done; integration test failed." }),
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "receipt_partial");
  assert.equal(result.errorMessage, "Implementation done; integration test failed.");
});

test("a completed receipt requires agent_settled", () => {
  const result = makeResult({
    exitCode: 0,
    receiptRequired: true,
    receipt: makeReceipt(),
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "protocol_error");
  assert.match(result.errorMessage, /before agent_settled/);
});

test("a nonzero process exit remains failed despite a completed receipt", () => {
  const result = makeResult({
    exitCode: 1,
    receiptRequired: true,
    sawAgentSettled: true,
    receipt: makeReceipt(),
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(isResultSuccess(result), false);
});

test("a completed receipt cannot override failed evidence", () => {
  const result = makeResult({
    exitCode: 0,
    receiptRequired: true,
    sawAgentSettled: true,
    receipt: makeReceipt({
      checks: [{ id: "unit", status: "failed", exitCode: 1, source: "agent-reported" }],
    }),
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "protocol_error");
});

test("session details retain the bounded UI transcript but omit transient tool state", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "inspect first" }],
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "full result" }],
      details: { lineCount: 1 },
      isError: false,
      timestamp: 2,
    },
  ];
  const result = makeResult({
    messages,
    taskSpec: {
      kind: "pi-subagent-task",
      protocolVersion: 1,
      taskId: "task-1",
      name: "oracle",
      objective: "repro",
      scope: ["src"],
      nonGoals: [],
      acceptance: [],
      verification: [],
    },
    activeToolExecutions: [{
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "sleep 1" },
      complete: false,
    }],
  });

  const stored = compactResultForSession(result);
  assert.equal(stored.messages, messages);
  assert.equal(stored.taskSpec.scope[0], "src");
  assert.equal(stored.activeToolExecutions, undefined);
});
