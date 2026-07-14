import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createChildFrame,
  createRunLedger,
  createTaskSpec,
  loadFrame,
} from "../protocol.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryDir = path.dirname(testDir);

function createTestableRunnerModule() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-runner-module-"));
  const modulePath = path.join(tempDir, "runner.testable.ts");
  const localUrl = (name) => JSON.stringify(pathToFileURL(path.join(repositoryDir, name)).href);
  const source = fs
    .readFileSync(path.join(repositoryDir, "runner.ts"), "utf8")
    .replace('from "./runner-cli.js"', `from ${localUrl("runner-cli.js")}`)
    .replace('from "./runner-events.js"', `from ${localUrl("runner-events.js")}`)
    .replace('from "./protocol.js"', `from ${localUrl("protocol.ts")}`)
    .replace('from "./types.js"', `from ${localUrl("types.ts")}`);
  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

let runner;
let cleanupRunner;

test.before(async () => {
  const testable = createTestableRunnerModule();
  cleanupRunner = testable.cleanup;
  runner = await import(testable.moduleUrl);
});

test.after(() => cleanupRunner?.());

function makeInvocation(deadlineMs = 5_000) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-run-test-"));
  const root = loadFrame({}).frame;
  const ledgerPath = createRunLedger(root.rootRunId, tempRoot);
  const frame = createChildFrame({ ...root, ledgerPath }, {
    name: "fixture-manager",
    taskId: "fixture-task",
    deadlineAtMs: Date.now() + deadlineMs,
    maxTurns: 5,
    ledgerPath,
  });
  const taskSpec = createTaskSpec({
    name: frame.name,
    taskId: frame.taskId,
    task: "Run the fixture.",
    acceptance: ["Fixture completes"],
  });
  return { tempRoot, ledgerPath, frame, taskSpec };
}

async function runFixture(fixtureName, options = {}) {
  const invocation = makeInvocation(options.deadlineMs);
  const fixturePath = path.join(repositoryDir, "test-fixtures", fixtureName);
  const result = await runner.runAgent({
    cwd: repositoryDir,
    agentName: invocation.frame.name,
    taskSpec: invocation.taskSpec,
    frame: invocation.frame,
    forkSessionSnapshotJsonl: `${JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: new Date().toISOString(), cwd: repositoryDir })}\n`,
    makeDetails: (results) => ({ results }),
    requireReceipt: options.requireReceipt ?? true,
    testSpawn: { command: process.execPath, prefixArgs: [fixturePath] },
  });
  return { ...invocation, result };
}

test("buildPiArgs forwards the active model, thinking level, and exact tool set", () => {
  const args = runner.buildPiArgs(
    "task bytes",
    "/tmp/session.jsonl",
    {
      model: "llama.cpp/qwen3.6-27b",
      thinking: "high",
      tools: ["read", "bash", "subagent", "agent_status", "submit_result"],
    },
    {
      extensionArgs: ["-e", "/tmp/extension"],
      alwaysProxy: [],
      fallbackModel: undefined,
      fallbackThinking: undefined,
      fallbackTools: undefined,
      fallbackNoTools: false,
    },
  );

  assert.deepEqual(args.slice(-8), [
    "--model", "llama.cpp/qwen3.6-27b",
    "--thinking", "high",
    "--tools", "read,bash,subagent,agent_status,submit_result",
    "-p", "task bytes",
  ]);
});

test("a valid structured receipt is required and returned as semantic completion", async () => {
  const invocation = await runFixture("fake-pi-success.mjs");
  try {
    assert.equal(invocation.result.exitCode, 0);
    assert.equal(invocation.result.receipt?.summary, "Fixture completed.");
    assert.equal(invocation.result.usage.turns, 1);
    const ledgerLines = fs.readFileSync(invocation.ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(ledgerLines.at(-1).kind, "pi-subagent-invocation");
    assert.equal(ledgerLines.at(-1).receiptId, "fixture-receipt");
  } finally {
    fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
  }
});

test("normal final prose cannot silently replace a required receipt", async () => {
  const invocation = await runFixture("fake-pi-no-receipt.mjs");
  try {
    assert.equal(invocation.result.exitCode, 1);
    assert.equal(invocation.result.stopReason, "missing_receipt");
    assert.match(invocation.result.errorMessage, /without calling submit_result/);
  } finally {
    fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
  }
});

test("a child-created receipt file is rejected without Pi's submit_result event", async () => {
  const invocation = await runFixture("fake-pi-forged-receipt.mjs");
  try {
    assert.equal(invocation.result.exitCode, 1);
    assert.equal(invocation.result.processError, true);
    assert.match(invocation.result.errorMessage, /without a successful submit_result tool event/);
  } finally {
    fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
  }
});

test("a cache-prefix mismatch is a host failure even if Pi settles", async () => {
  const invocation = await runFixture("fake-pi-cache-mismatch.mjs");
  try {
    assert.equal(invocation.result.exitCode, 1);
    assert.equal(invocation.result.stopReason, "cache_invariant");
    assert.equal(invocation.result.processError, true);
    assert.match(invocation.result.errorMessage, /toolsSha256/);
  } finally {
    fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
  }
});

test("the child-side turn marker becomes a real max-turn failure", async () => {
  const invocation = await runFixture("fake-pi-max-turns.mjs");
  try {
    assert.equal(invocation.result.exitCode, 1);
    assert.equal(invocation.result.maxTurnsExceeded, true);
    assert.equal(invocation.result.stopReason, "max_turns");
  } finally {
    fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
  }
});

test("timeout kills a nested child in the root manager process group", async () => {
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-tree-test-"));
  const markerPath = path.join(markerRoot, "survived.txt");
  const previousMarker = process.env.PI_SUBAGENT_TEST_MARKER;
  process.env.PI_SUBAGENT_TEST_MARKER = markerPath;
  let invocation;
  try {
    invocation = await runFixture("fake-pi-nested-tree.mjs", { deadlineMs: 150, requireReceipt: false });
    assert.equal(invocation.result.exitCode, 124);
    assert.equal(invocation.result.stopReason, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(fs.existsSync(markerPath), false, "detached descendant survived the timeout");
  } finally {
    if (previousMarker === undefined) delete process.env.PI_SUBAGENT_TEST_MARKER;
    else process.env.PI_SUBAGENT_TEST_MARKER = previousMarker;
    if (invocation) fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
    fs.rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("a manager crash tears down its still-running nested worker", async () => {
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-crash-tree-test-"));
  const markerPath = path.join(markerRoot, "survived.txt");
  const previousMarker = process.env.PI_SUBAGENT_TEST_MARKER;
  process.env.PI_SUBAGENT_TEST_MARKER = markerPath;
  let invocation;
  try {
    invocation = await runFixture("fake-pi-crash-with-worker.mjs", { requireReceipt: false });
    assert.equal(invocation.result.exitCode, 1);
    assert.equal(invocation.result.stopReason, "error");
    assert.match(invocation.result.errorMessage, /nested process|exited with code/);
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(fs.existsSync(markerPath), false, "nested worker survived its manager crash");
  } finally {
    if (previousMarker === undefined) delete process.env.PI_SUBAGENT_TEST_MARKER;
    else process.env.PI_SUBAGENT_TEST_MARKER = previousMarker;
    if (invocation) fs.rmSync(invocation.tempRoot, { recursive: true, force: true });
    fs.rmSync(markerRoot, { recursive: true, force: true });
  }
});

test("parseDescendantPids returns deepest descendants before their parents", () => {
  const table = "10 1\n11 10\n12 11\n13 10\n";
  assert.deepEqual(runner.parseDescendantPids(table, 10), [12, 11, 13]);
});
