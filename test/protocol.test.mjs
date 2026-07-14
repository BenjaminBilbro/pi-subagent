import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FRAME_ENV,
  MAX_MODEL_RECEIPT_BYTES,
  MAX_DEPTH_ENV,
  MAX_TASK_SPEC_BYTES,
  PROTOCOL_VERSION,
  appendLedgerRecord,
  appendProcessRegistryRecord,
  buildChildEnvironment,
  buildTaskMessage,
  createChildFrame,
  createReceipt,
  createRunLedger,
  createTaskSpec,
  formatReceiptForParent,
  getMissingRequiredSubagentTools,
  loadFrame,
  mayDelegate,
  readReceipt,
  readActiveProcessPids,
  validateSoleToolCall,
  writeReceipt,
} from "../protocol.ts";

function makeChild(parent, overrides = {}) {
  return createChildFrame(parent, {
    name: overrides.name ?? "auth-manager",
    taskId: overrides.taskId ?? "auth-refactor",
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 60_000,
    maxTurns: overrides.maxTurns ?? 20,
    ledgerPath: overrides.ledgerPath ?? "/tmp/test-ledger.jsonl",
  });
}

test("missing frame state creates a depth-2 main frame", () => {
  const loaded = loadFrame({});

  assert.equal(loaded.configurationError, undefined);
  assert.equal(loaded.frame.role, "main");
  assert.equal(loaded.frame.depth, 0);
  assert.equal(loaded.frame.maxDepth, 2);
  assert.equal(mayDelegate(loaded.frame), true);
});

test("root max depth is configurable but malformed values fail closed", () => {
  assert.equal(loadFrame({ [MAX_DEPTH_ENV]: "3" }).frame.maxDepth, 3);

  const malformed = loadFrame({ [MAX_DEPTH_ENV]: "lots" });
  assert.match(malformed.configurationError, /PI_SUBAGENT_MAX_DEPTH/);
  assert.equal(malformed.frame.maxDepth, 0);
  assert.equal(mayDelegate(malformed.frame, malformed.configurationError), false);
});

test("root to manager to worker succeeds and worker delegation is blocked", () => {
  const root = loadFrame({}).frame;
  const manager = makeChild(root);
  const worker = makeChild(manager, { name: "auth-worker", taskId: "auth-step-1" });

  assert.equal(manager.role, "manager");
  assert.equal(manager.depth, 1);
  assert.equal(mayDelegate(manager), true);
  assert.equal(worker.role, "worker");
  assert.equal(worker.depth, 2);
  assert.equal(mayDelegate(worker), false);
  assert.throws(
    () => makeChild(worker, { name: "too-deep", taskId: "too-deep" }),
    /may not delegate/,
  );
});

test("cycle prevention rejects repeated names and task IDs in the active path", () => {
  const manager = makeChild(loadFrame({}).frame);

  assert.throws(
    () => makeChild(manager, { name: " AUTH-MANAGER ", taskId: "different" }),
    /agent name/,
  );
  assert.throws(
    () => makeChild(manager, { name: "different", taskId: "AUTH-REFACTOR" }),
    /taskId/,
  );
});

test("malformed inherited frames fail closed instead of becoming main", () => {
  const loaded = loadFrame({ [FRAME_ENV]: "{not-json" });

  assert.match(loaded.configurationError, /not valid JSON/);
  assert.equal(loaded.frame.role, "worker");
  assert.equal(mayDelegate(loaded.frame, loaded.configurationError), false);
});

test("child frames require finite limits and truthful active-stack tails", () => {
  const manager = makeChild(loadFrame({}).frame);
  const noDeadline = { ...manager, deadlineAtMs: null };
  const wrongStack = { ...manager, stack: ["different-manager"] };

  assert.match(loadFrame({ [FRAME_ENV]: JSON.stringify(noDeadline) }).configurationError, /finite/);
  assert.match(loadFrame({ [FRAME_ENV]: JSON.stringify(wrongStack) }).configurationError, /stack must end/);
});

test("task envelope carries dynamic frame data only in the appended user message", () => {
  const manager = makeChild(loadFrame({}).frame);
  const task = createTaskSpec({
    name: manager.name,
    taskId: manager.taskId,
    task: "Refactor auth.",
    acceptance: ["Tests pass"],
  });
  const message = buildTaskMessage(manager, task);

  assert.match(message, /^\[PI_SUBAGENT_RUN_FRAME_V1\]/);
  assert.match(message, /\[PI_SUBAGENT_TASK_SPEC_V1\]/);
  assert.match(message, /"role":"manager"/);
  assert.match(message, /"objective":"Refactor auth\."/);
  assert.doesNotMatch(message, /ledgerPath/);
});

test("task contracts are bounded for direct child argument transport", () => {
  assert.throws(
    () => createTaskSpec({
      name: "bounded-task",
      taskId: "bounded-task",
      task: "x".repeat(16 * 1024),
      acceptance: Array.from({ length: 5 }, () => "y".repeat(1_024)),
    }),
    new RegExp(`exceeded ${MAX_TASK_SPEC_BYTES} UTF-8 bytes`),
  );
});

test("receipt identity is host-owned and receipt files are single-write", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-protocol-test-"));
  const ledgerPath = createRunLedger("root-run", tempDir);
  const root = loadFrame({}).frame;
  root.rootRunId = "root-run";
  root.runId = "root-run";
  const manager = makeChild(root, { ledgerPath });
  const receipt = createReceipt(manager, {
    status: "completed",
    summary: "Auth refactored.",
    changedFiles: ["src/auth.ts"],
    checks: [{ id: "unit", status: "passed", command: "npm test", exitCode: 0 }],
    artifacts: [],
    unresolved: [],
  });
  const receiptPath = path.join(tempDir, "receipt.json");

  try {
    appendLedgerRecord(ledgerPath, receipt);
    writeReceipt(receiptPath, receipt);
    assert.deepEqual(readReceipt(receiptPath, manager), receipt);
    assert.throws(() => writeReceipt(receiptPath, receipt), /EEXIST/);
    assert.equal(fs.statSync(ledgerPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("child environment carries one canonical frame plus compatibility mirrors", () => {
  const manager = makeChild(loadFrame({}).frame);
  const env = buildChildEnvironment(manager, "/tmp/receipt", "/tmp/max-turns");
  const roundTrip = JSON.parse(env[FRAME_ENV]);

  assert.equal(roundTrip.protocolVersion, PROTOCOL_VERSION);
  assert.equal(roundTrip.runId, manager.runId);
  assert.equal(env.PI_SUBAGENT_DEPTH, "1");
  assert.equal(env.PI_SUBAGENT_MAX_DEPTH, "2");
});

test("delegation and submission reject sibling tool calls in one assistant message", () => {
  const branch = [{
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "delegate-1", name: "subagent" },
        { type: "toolCall", id: "delegate-2", name: "subagent" },
      ],
    },
  }];

  assert.match(validateSoleToolCall(branch, "delegate-1", "subagent"), /only tool call/);
  assert.equal(
    validateSoleToolCall([
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "result-1", name: "submit_result" }] } },
    ], "result-1", "submit_result"),
    null,
  );
  assert.match(validateSoleToolCall([], "missing", "subagent"), /Could not verify/);
});

test("nested delegation requires all three protocol tools to remain active", () => {
  assert.deepEqual(
    getMissingRequiredSubagentTools(["read", "subagent", "submit_result"]),
    ["agent_status"],
  );
  assert.deepEqual(
    getMissingRequiredSubagentTools(["submit_result", "agent_status", "subagent"]),
    [],
  );
});

test("completed receipts reject contradictory checks and unresolved issues", () => {
  const manager = makeChild(loadFrame({}).frame);
  const base = {
    status: "completed",
    summary: "Done.",
    changedFiles: [],
    checks: [],
    artifacts: [],
    unresolved: [],
  };

  assert.throws(
    () => createReceipt(manager, {
      ...base,
      checks: [{ id: "unit", status: "failed", exitCode: 1 }],
    }),
    /completed receipt cannot contain a failed check/i,
  );
  assert.throws(
    () => createReceipt(manager, { ...base, unresolved: ["Still broken"] }),
    /cannot contain unresolved/i,
  );
  assert.throws(
    () => createReceipt(manager, {
      ...base,
      checks: [{ id: "unit", status: "passed", exitCode: 2 }],
    }),
    /cannot pass with a nonzero exit code/i,
  );
});

test("the model-facing receipt is compact and UTF-8 byte bounded", () => {
  const manager = makeChild(loadFrame({}).frame);
  const receipt = createReceipt(manager, {
    status: "partial",
    summary: "🧪".repeat(2_000),
    changedFiles: Array.from({ length: 24 }, (_, index) => `src/${index}-${"界".repeat(300)}.ts`),
    checks: Array.from({ length: 24 }, (_, index) => ({
      id: `check-${index}`,
      status: "skipped",
      evidence: "é".repeat(500),
    })),
    artifacts: [],
    unresolved: ["Needs follow-up"],
  });
  const text = formatReceiptForParent(receipt, "/tmp/ledger.jsonl");

  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_MODEL_RECEIPT_BYTES);
  assert.match(text, /^PI_SUBAGENT_RECEIPT_V1\n/);
  assert.equal(JSON.parse(text.split("\n")[1]).truncated, true);
});

test("process registry resolves active nested frame PIDs without OS process inspection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-registry-test-"));
  const ledgerPath = createRunLedger("root-run", tempDir);
  try {
    appendProcessRegistryRecord(ledgerPath, {
      event: "started", rootRunId: "root-run", runId: "manager", parentRunId: "root-run", pid: 101,
    });
    appendProcessRegistryRecord(ledgerPath, {
      event: "started", rootRunId: "root-run", runId: "worker", parentRunId: "manager", pid: 102,
    });
    appendProcessRegistryRecord(ledgerPath, {
      event: "started", rootRunId: "root-run", runId: "sibling", parentRunId: "root-run", pid: 103,
    });
    appendProcessRegistryRecord(ledgerPath, {
      event: "stopped", rootRunId: "root-run", runId: "manager", parentRunId: "root-run", pid: 101,
    });

    assert.deepEqual(readActiveProcessPids(ledgerPath, "manager", "root-run"), [102]);
    assert.deepEqual(readActiveProcessPids(ledgerPath, "sibling", "root-run"), [103]);

    appendProcessRegistryRecord(ledgerPath, {
      event: "started", rootRunId: "wrong-root", runId: "forged", parentRunId: "manager", pid: 0,
    });
    appendProcessRegistryRecord(ledgerPath, {
      event: "started", rootRunId: "root-run", runId: "negative", parentRunId: "manager", pid: -42,
    });
    assert.deepEqual(readActiveProcessPids(ledgerPath, "manager", "root-run"), [102]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
