import fs from "node:fs";

fs.writeFileSync(process.env.PI_SUBAGENT_MAX_TURNS_PATH, "limit reached\n", {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({ type: "agent_settled" }));
