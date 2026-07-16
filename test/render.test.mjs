import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";

const repoRoot = path.resolve(import.meta.dirname, "..");
initTheme(undefined, false);

async function loadRenderModule() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-render-test-"));
  fs.symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(tempDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let source = fs.readFileSync(path.join(repoRoot, "render.ts"), "utf8");
  for (const [specifier, target] of [
    ["./runner-events.js", "runner-events.js"],
    ["./protocol.js", "protocol.ts"],
    ["./types.js", "types.ts"],
  ]) {
    source = source.replace(`\"${specifier}\"`, `\"${pathToFileURL(path.join(repoRoot, target)).href}\"`);
  }
  const modulePath = path.join(tempDir, "render.ts");
  fs.writeFileSync(modulePath, source, "utf8");
  const loaded = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return loaded;
}

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function rendered(component, width = 180) {
  return stripVTControlCharacters(component.render(width).join("\n"));
}

function usage(turns = 1) {
  return { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0, contextTokens: 30, turns };
}

test("Ctrl+O expands the complete initial task contract", async () => {
  const { renderCall } = await loadRenderModule();
  const sentinel = "FULL-TASK-SENTINEL";
  const args = {
    name: "auth-manager",
    taskId: "auth-refactor",
    task: `${"Refactor the authentication boundary carefully. ".repeat(4)}${sentinel}`,
    scope: ["src/auth", "test/auth"],
    nonGoals: ["Do not change session storage."],
    acceptance: ["All authentication tests pass."],
    verification: ["npm test -- test/auth"],
    timeout: 600,
    maxTurns: 40,
  };

  const collapsed = rendered(renderCall(args, false, theme, { depth: 1, role: "manager" }));
  const expanded = rendered(renderCall(args, true, theme, { depth: 1, role: "manager" }));

  assert.doesNotMatch(collapsed, new RegExp(sentinel));
  assert.match(collapsed, /Ctrl\+O for the full task contract/);
  assert.match(expanded, new RegExp(sentinel));
  assert.match(expanded, /src\/auth/);
  assert.match(expanded, /Do not change session storage/);
  assert.match(expanded, /npm test -- test\/auth/);
  assert.match(expanded, /600s timeout.*40 max turns/);
});

test("expanded results render nested reasoning, complete tool calls, and complete tool results", async () => {
  const { renderResult } = await loadRenderModule();
  const child = {
    agent: "auth-worker",
    task: "Implement the focused auth slice.",
    frame: { depth: 2, role: "worker", runId: "worker-run" },
    exitCode: 0,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "WORKER-REASONING-SENTINEL" },
          {
            type: "toolCall",
            id: "bash-worker-1",
            name: "bash",
            arguments: { command: `${"printf tool-command ".repeat(8)}FULL-COMMAND-SENTINEL` },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "bash-worker-1",
        toolName: "bash",
        content: [{ type: "text", text: "FULL-TOOL-RESULT-SENTINEL" }],
        isError: false,
      },
    ],
    stderr: "",
    usage: usage(),
  };
  const parent = {
    agent: "auth-manager",
    task: "Oversee the auth refactor.",
    frame: { depth: 1, role: "manager", runId: "manager-run" },
    exitCode: 0,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "MANAGER-REASONING-SENTINEL" },
          {
            type: "toolCall",
            id: "spawn-worker-1",
            name: "subagent",
            arguments: {
              name: "auth-worker",
              task: "NESTED-FULL-TASK-SENTINEL",
              acceptance: ["Worker tests pass."],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "spawn-worker-1",
        toolName: "subagent",
        content: [{ type: "text", text: "PI_SUBAGENT_RECEIPT_V1\n{\"status\":\"completed\"}" }],
        details: { results: [child] },
        isError: false,
      },
    ],
    stderr: "",
    usage: usage(),
  };

  const expanded = rendered(renderResult({ content: [], details: { results: [parent] } }, true, theme), 240);
  const collapsed = rendered(renderResult({ content: [], details: { results: [parent] } }, false, theme), 240);

  for (const expected of [
    "MANAGER-REASONING-SENTINEL",
    "WORKER-REASONING-SENTINEL",
    "NESTED-FULL-TASK-SENTINEL",
    "FULL-COMMAND-SENTINEL",
    "FULL-TOOL-RESULT-SENTINEL",
    "spawn-worker-1",
    "bash-worker-1",
    "return to parent",
    "manager · depth 1",
    "worker · depth 2",
  ]) assert.match(expanded, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.doesNotMatch(collapsed, /MANAGER-REASONING-SENTINEL|WORKER-REASONING-SENTINEL/);
  assert.match(collapsed, /1 nested agent/);
  assert.match(collapsed, /Ctrl\+O to inspect the full trace/);
});

test("expanded results expose a nested worker while the manager is still running", async () => {
  const { renderResult } = await loadRenderModule();
  const liveWorker = {
    agent: "live-worker",
    task: "Run the live check.",
    frame: { depth: 2, role: "worker", runId: "live-worker-run" },
    exitCode: -1,
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "LIVE-WORKER-TRACE" }] }],
    stderr: "",
    usage: usage(),
  };
  const manager = {
    agent: "live-manager",
    task: "Oversee live work.",
    frame: { depth: 1, role: "manager", runId: "live-manager-run" },
    exitCode: -1,
    messages: [],
    activeToolExecutions: [{
      toolCallId: "live-spawn",
      toolName: "subagent",
      args: { name: "live-worker", task: "Run the live check." },
      partialResult: { content: [{ type: "text", text: "running" }], details: { results: [liveWorker] } },
      complete: false,
    }],
    stderr: "",
    usage: usage(),
  };

  const expanded = rendered(renderResult({ content: [], details: { results: [manager] } }, true, theme), 200);
  assert.match(expanded, /running · subagent/);
  assert.match(expanded, /live-worker/);
  assert.match(expanded, /LIVE-WORKER-TRACE/);
});
