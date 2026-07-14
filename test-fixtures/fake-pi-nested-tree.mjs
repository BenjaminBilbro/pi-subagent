import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const markerPath = process.env.PI_SUBAGENT_TEST_MARKER;
const childScript = `
  const fs = require("node:fs");
  setTimeout(() => {
    fs.writeFileSync(process.argv[1], "descendant survived\\n");
    process.exit(0);
  }, 700);
`;
const child = spawn(process.execPath, ["-e", childScript, markerPath], {
  // Nested Pi processes inherit the root manager's trusted process group.
  detached: false,
  stdio: "ignore",
});
child.unref();

const frame = JSON.parse(process.env.PI_SUBAGENT_FRAME);
fs.appendFileSync(
  path.join(path.dirname(frame.ledgerPath), "processes.jsonl"),
  `${JSON.stringify({
    kind: "pi-subagent-process",
    protocolVersion: 1,
    event: "started",
    rootRunId: frame.rootRunId,
    runId: "fixture-nested-worker",
    parentRunId: frame.runId,
    pid: child.pid,
    timestampMs: Date.now(),
  })}\n`,
  { encoding: "utf8", mode: 0o600 },
);

console.log(JSON.stringify({ type: "agent_start" }));
setInterval(() => {}, 1_000);
