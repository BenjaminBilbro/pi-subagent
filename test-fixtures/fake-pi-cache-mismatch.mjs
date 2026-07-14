import fs from "node:fs";

fs.writeFileSync(
  process.env.PI_SUBAGENT_CACHE_INVARIANT_ERROR_PATH,
  "Cache-prefix invariant failed before the child model call: toolsSha256.",
  { encoding: "utf8", mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({ type: "agent_settled" }));
