import fs from "node:fs";

const frame = JSON.parse(process.env.PI_SUBAGENT_FRAME);
const receipt = {
  kind: "pi-subagent-receipt",
  protocolVersion: 1,
  receiptId: "fixture-receipt",
  rootRunId: frame.rootRunId,
  runId: frame.runId,
  parentRunId: frame.parentRunId,
  taskId: frame.taskId,
  role: frame.role,
  name: frame.name,
  submittedAtMs: Date.now(),
  status: "completed",
  summary: "Fixture completed.",
  changedFiles: ["fixture.txt"],
  checks: [{ id: "fixture", status: "passed", exitCode: 0, source: "agent-reported" }],
  artifacts: [],
  unresolved: [],
};

fs.writeFileSync(process.env.PI_SUBAGENT_RECEIPT_PATH, `${JSON.stringify(receipt)}\n`, {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});

console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "submit-1",
  toolName: "submit_result",
  result: {
    content: [{ type: "text", text: "PI_SUBAGENT_RECEIPT_V1" }],
    details: receipt,
    terminate: true,
  },
  isError: false,
}));
console.log(JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: {} }],
    model: "fixture-model",
    stopReason: "toolUse",
    usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } },
    timestamp: Date.now(),
  }],
}));
console.log(JSON.stringify({ type: "agent_settled" }));
