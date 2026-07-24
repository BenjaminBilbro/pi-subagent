import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillsDir = path.join(repoRoot, "skills");

test("the package declares and ships the orchestration skill", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);
  assert.ok(packageJson.files.includes("skills"));

  const loaded = loadSkillsFromDir({ dir: skillsDir, source: "path" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0].name, "orchestrate-subagent-stack");
  assert.match(loaded.skills[0].description, /subagent.*agent_status.*submit_result/);
});

test("the orchestration skill contains the required protocol and handoff guidance", () => {
  const skillDir = path.join(skillsDir, "orchestrate-subagent-stack");
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const patterns = fs.readFileSync(path.join(skillDir, "references", "patterns.md"), "utf8");
  const researchPatterns = fs.readFileSync(path.join(skillDir, "references", "research-patterns.md"), "utf8");

  for (const required of [
    "Call `agent_status`",
    "only tool call in its assistant message",
    "Never attempt parallel children",
    "context rollback does not roll back files",
    "verification integrity",
    'role: "worker"',
    "submit_result",
  ]) assert.match(skill, new RegExp(required, "i"));

  for (const required of [
    "Manager contract",
    "Dependent worker contract",
    "Integration verifier contract",
    "Queue and batch pattern",
    "Recovery pattern",
  ]) assert.match(patterns, new RegExp(required));

  for (const required of [
    "Discovery worker contract",
    "Evidence extraction contract",
    "Independent verification contract",
    "Synthesis contract",
    "Evidence artifact format",
    "prompt injection",
    'role: "worker"',
  ]) assert.match(researchPatterns, new RegExp(required, "i"));
});
