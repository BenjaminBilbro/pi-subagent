import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInheritedCliArgs } from "../runner-cli.js";

test("forwards safe parent CLI flags and captures fallback model settings", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--provider",
    "openrouter",
    "--api-key",
    "secret",
    "--theme",
    "dark",
    "--skill",
    "research",
    "--model",
    "anthropic/claude-3-7-sonnet",
    "--thinking",
    "high",
    "--tools",
    "read,bash",
    "--no-session",
    "--mode",
    "json",
    "--append-system-prompt",
    "Keep the inherited prompt byte-stable.",
    "--custom-flag",
    "value",
    "positional prompt text",
  ]);

  assert.deepEqual(parsed.extensionArgs, []);
  assert.deepEqual(parsed.alwaysProxy, [
    "--api-key",
    "secret",
    "--append-system-prompt",
    "Keep the inherited prompt byte-stable.",
    "--skill",
    path.resolve("research"),
    "--theme",
    path.resolve("dark"),
    "--custom-flag=value",
  ]);
  assert.equal(parsed.fallbackModel, "anthropic/claude-3-7-sonnet");
  assert.equal(parsed.fallbackThinking, "high");
  assert.equal(parsed.fallbackTools, "read,bash");
  assert.equal(parsed.fallbackNoTools, false);
});

test("resolves relative extension paths against the parent cwd", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cli-"));
  const extensionDir = path.join(tmpDir, "local-extension");
  fs.mkdirSync(extensionDir);

  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const canonicalTmpDir = process.cwd();
    const parsed = parseInheritedCliArgs([
      "/usr/bin/node",
      "pi",
      "-e",
      "./local-extension",
      "--extension",
      "git:github.com/example/other-extension",
      "--no-extensions",
    ]);

    assert.deepEqual(parsed.extensionArgs, [
      "--no-extensions",
      "--extension",
      path.join(canonicalTmpDir, "local-extension"),
      "--extension",
      "git:github.com/example/other-extension",
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolves inherited relative resource paths against the parent cwd", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cli-"));
  const skillPath = path.join(tmpDir, "skills", "research", "SKILL.md");
  const promptPath = path.join(tmpDir, "prompts", "review.md");
  const themePath = path.join(tmpDir, "themes", "custom.json");
  const sessionDir = path.join(tmpDir, ".sessions", "nested");
  const appendPromptPath = path.join(tmpDir, "prompts", "append.md");

  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.mkdirSync(path.dirname(themePath), { recursive: true });
  fs.writeFileSync(skillPath, "# skill\n");
  fs.writeFileSync(promptPath, "# prompt\n");
  fs.writeFileSync(appendPromptPath, "# appended prompt\n");
  fs.writeFileSync(themePath, "{}\n");

  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const canonicalTmpDir = process.cwd();
    const parsed = parseInheritedCliArgs([
      "/usr/bin/node",
      "pi",
      "--skill",
      "./skills/research/SKILL.md",
      "--prompt-template",
      "prompts/review.md",
      "--append-system-prompt",
      "./prompts/append.md",
      "--theme",
      "dark",
      "--theme",
      "my-org/dark",
      "--theme",
      "./themes/custom.json",
      "--session-dir",
      "./.sessions/nested",
      "--system-prompt",
      "You are helpful",
    ]);

    assert.deepEqual(parsed.alwaysProxy, [
      "--system-prompt",
      "You are helpful",
      "--append-system-prompt",
      path.join(canonicalTmpDir, "prompts", "append.md"),
      "--skill",
      path.join(canonicalTmpDir, "skills", "research", "SKILL.md"),
      "--prompt-template",
      path.join(canonicalTmpDir, "prompts", "review.md"),
      "--theme",
      path.join(canonicalTmpDir, "dark"),
      "--theme",
      path.join(canonicalTmpDir, "my-org", "dark"),
      "--theme",
      path.join(canonicalTmpDir, "themes", "custom.json"),
    ]);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("inherits no-tools when the parent disabled tools", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--no-tools",
  ]);

  assert.equal(parsed.fallbackTools, undefined);
  assert.equal(parsed.fallbackNoTools, true);
});

test("uses Pi semantics for inline unknown flags and dash-leading print prompts", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--model=not-a-model-flag",
    "--api-key=not-an-api-key-flag",
    "-p",
    "---do-not-forward-this-parent-prompt",
  ]);

  assert.equal(parsed.fallbackModel, undefined);
  assert.deepEqual(parsed.alwaysProxy, [
    "--model=not-a-model-flag",
    "--api-key=not-an-api-key-flag",
  ]);
});

test("suppresses session and tool controls while preserving prompt and trust controls", () => {
  const parsed = parseInheritedCliArgs([
    "/usr/bin/node",
    "pi",
    "--session-id",
    "session-1",
    "--fork",
    "old-session",
    "--name",
    "parent name",
    "--exclude-tools",
    "write",
    "--no-builtin-tools",
    "--system-prompt",
    "-dash-leading-prompt",
    "--approve",
    "original positional prompt",
  ]);

  assert.deepEqual(parsed.extensionArgs, []);
  assert.deepEqual(parsed.alwaysProxy, [
    "--system-prompt",
    "-dash-leading-prompt",
    "--approve",
  ]);
});
