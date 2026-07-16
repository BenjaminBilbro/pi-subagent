import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFinalAssistantText,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../runner-events.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeResult() {
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
  };
}

test("repro: captures final assistant output from agent_end after non-zero tool exit", async () => {
  const fixturePath = path.join(testDir, "fixtures", "agent-end-error-only.jsonl");
  const lines = fs.readFileSync(fixturePath, "utf8").trim().split("\n");
  const result = makeResult();

  for (const line of lines) {
    processPiJsonLine(line, result);
  }

  result.exitCode = 1;

  assert.equal(result.messages.length, 2);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.usage.turns, 2);
  assert.equal(
    getFinalAssistantText(result.messages),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
  assert.equal(
    getResultSummaryText(result),
    "No matches found. The grep/rg command failed with exit code 1, which is expected here.",
  );
});

test("deduplicates assistant messages repeated across message_end, turn_end, and agent_end", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };

  const result = makeResult();
  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message, toolResults: [] }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 1);
  assert.equal(result.usage.output, 2);
  assert.equal(result.sawAgentEnd, true);
});

test("non-zero exit code does not hide the final assistant text", () => {
  const result = makeResult();
  result.exitCode = 1;
  result.errorMessage = "Command exited with code 1";
  result.stderr = "stderr noise that should be a fallback only";
  result.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "No matches found" }],
    timestamp: 1,
  });

  assert.equal(getResultSummaryText(result), "No matches found");
});

test("stderr remains a fallback only for error results", () => {
  const okResult = makeResult();
  okResult.exitCode = 0;
  okResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(okResult), "(no output)");

  const failedResult = makeResult();
  failedResult.exitCode = 1;
  failedResult.stderr = "warning on stderr";
  assert.equal(getResultSummaryText(failedResult), "warning on stderr");
});

test("terminal lifecycle events are still processed at the configured turn limit", () => {
  const makeMsg = (i) => ({
    role: "assistant",
    content: [{ type: "text", text: `Turn message ${i}` }],
    model: "test-model",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: i,
  });

  const result = makeResult();
  result.maxTurnsLimit = 3;

  // Process 3 messages (reaching the limit)
  processPiEvent({ type: "message_end", message: makeMsg(1) }, result);
  processPiEvent({ type: "message_end", message: makeMsg(2) }, result);
  processPiEvent({ type: "message_end", message: makeMsg(3) }, result);

  assert.equal(result.messages.length, 3);
  assert.equal(result.usage.turns, 3);

  processPiEvent({ type: "agent_end", messages: [makeMsg(3)] }, result);
  processPiEvent({ type: "agent_settled" }, result);

  assert.equal(result.messages.length, 3);
  assert.equal(result.sawAgentEnd, true);
  assert.equal(result.sawAgentSettled, true);
  assert.equal(result.stopReason, undefined);
});

test("captures tool results and preserves nested subagent details", () => {
  const result = makeResult();
  const nested = {
    agent: "worker-1",
    task: "Inspect the implementation",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "worker reasoning" }] }],
    stderr: "",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
  };

  processPiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "spawn-1", name: "subagent", arguments: { name: "worker-1" } }],
      usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
    },
  }, result);
  processPiEvent({
    type: "tool_execution_update",
    toolCallId: "spawn-1",
    toolName: "subagent",
    args: { name: "worker-1" },
    partialResult: { content: [{ type: "text", text: "running" }], details: { results: [nested] } },
  }, result);

  assert.equal(result.activeToolExecutions.length, 1);
  assert.equal(result.activeToolExecutions[0].partialResult.details.results[0].agent, "worker-1");

  processPiEvent({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "spawn-1",
      toolName: "subagent",
      content: [{ type: "text", text: "PI_SUBAGENT_RECEIPT_V1\n{\"status\":\"completed\"}" }],
      details: { results: [nested] },
      isError: false,
    },
  }, result);

  assert.deepEqual(result.messages.map((message) => message.role), ["assistant", "toolResult"]);
  assert.equal(result.messages[1].details.results[0].messages[0].content[0].thinking, "worker reasoning");
  assert.equal(result.activeToolExecutions.length, 0);
  assert.equal(result.usage.turns, 1, "tool results must not count as model turns");
});
