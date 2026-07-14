import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
  buildSessionContext,
  createAgentSession,
  createBashToolDefinition,
  discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import {
  CACHE_INVARIANT_ERROR_PATH_ENV,
  FRAME_ENV,
  MAX_TURNS_PATH_ENV,
  RECEIPT_PATH_ENV,
  createChildFrame,
  createRunLedger,
  loadFrame,
  readReceipt,
} from "../protocol.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryDir = path.dirname(testDir);

function createTestableIndexModule() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-index-module-"));
  const writeStub = (name, source) => {
    const stubPath = path.join(tempDir, name);
    fs.writeFileSync(stubPath, source);
    return JSON.stringify(pathToFileURL(stubPath).href);
  };
  const renderStub = writeStub("render-stub.mjs", "export const renderCall=()=>null; export const renderResult=()=>null;\n");
  const runnerStub = writeStub(
    "runner-stub.mjs",
    [
      "export const isSameWorkingDirectory=(a,b)=>a===b;",
      "export async function runAgent(){throw new Error('not used');}",
      "",
    ].join("\n"),
  );
  const eventsStub = writeStub("events-stub.mjs", "export const getResultSummaryText=(r)=>r.errorMessage??'(no output)';\n");
  const typesStub = writeStub(
    "types-stub.mjs",
    "export const compactResultForSession=(r)=>r; export const isResultSuccess=(r)=>r.exitCode===0; export const isResultError=(r)=>r.exitCode!==-1&&r.exitCode!==0;\n",
  );
  const protocolUrl = JSON.stringify(pathToFileURL(path.join(repositoryDir, "protocol.ts")).href);
  const codingAgentUrl = JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const typeboxUrl = JSON.stringify(import.meta.resolve("typebox"));
  const source = fs
    .readFileSync(path.join(repositoryDir, "index.ts"), "utf8")
    .replace('from "@earendil-works/pi-coding-agent"', `from ${codingAgentUrl}`)
    .replace('from "typebox"', `from ${typeboxUrl}`)
    .replace('from "./render.js"', `from ${renderStub}`)
    .replace('from "./runner-events.js"', `from ${eventsStub}`)
    .replace('from "./runner.js"', `from ${runnerStub}`)
    .replace('from "./protocol.js"', `from ${protocolUrl}`)
    .replace('from "./types.js"', `from ${typesStub}`);
  const modulePath = path.join(tempDir, "index.testable.ts");
  fs.writeFileSync(modulePath, source);
  fs.copyFileSync(path.join(repositoryDir, "bash-guardian.js"), path.join(tempDir, "bash-guardian.js"));
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

function createMockPi(options = {}) {
  const handlers = new Map();
  const tools = [];
  let runtimeBound = false;
  const upstreamBash = options.builtInBash ? createBashToolDefinition(repositoryDir) : null;
  const baseTools = [
    { name: "read", description: "Read", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: { source: "builtin" } },
    ...(upstreamBash
      ? [{
          name: "bash",
          description: upstreamBash.description,
          parameters: upstreamBash.parameters,
          promptGuidelines: upstreamBash.promptGuidelines,
          sourceInfo: { source: "builtin" },
        }]
      : []),
  ];
  const requireRuntime = () => {
    if (!runtimeBound) {
      throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    }
  };
  const pi = {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    getActiveTools() {
      requireRuntime();
      return [...new Set([...baseTools.map((tool) => tool.name), ...tools.map((tool) => tool.name)])];
    },
    getAllTools() {
      requireRuntime();
      const byName = new Map(baseTools.map((tool) => [tool.name, tool]));
      for (const tool of tools) byName.set(tool.name, { ...tool, sourceInfo: { path: "fixture", source: "extension" } });
      return [...byName.values()];
    },
    getThinkingLevel() {
      requireRuntime();
      return "off";
    },
    async emit(event, payload = { type: event }, context = {}) {
      if (event === "session_start") runtimeBound = true;
      const results = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, context));
      return results;
    },
  };
  return pi;
}

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

let extension;
let buildForkSessionSnapshotJsonl;
let cleanupModule;
let testableModuleUrl;

test.before(async () => {
  const testable = createTestableIndexModule();
  cleanupModule = testable.cleanup;
  testableModuleUrl = testable.moduleUrl;
  const indexModule = await import(testable.moduleUrl);
  extension = indexModule.default;
  buildForkSessionSnapshotJsonl = indexModule.buildForkSessionSnapshotJsonl;
});

test.after(() => cleanupModule?.());

test("loads through Pi 0.80.6 without calling runtime actions from the extension factory", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-real-loader-"));
  try {
    const loaded = await discoverAndLoadExtensions([path.join(repositoryDir, "index.ts")], repositoryDir, agentDir);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual(loaded.errors, []);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Pi 0.80.6 session_start installs the child Bash override before provider use", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-real-session-"));
  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: path.join(agentDir, "ledger.jsonl"),
  });
  let session;
  try {
    await withEnvironment({ [FRAME_ENV]: JSON.stringify(manager) }, async () => {
      const settingsManager = SettingsManager.create(repositoryDir, agentDir);
      const resourceLoader = new DefaultResourceLoader({
        cwd: repositoryDir,
        agentDir,
        settingsManager,
        additionalExtensionPaths: [path.join(repositoryDir, "index.ts")],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: repositoryDir,
        agentDir,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(repositoryDir),
      });
      session = created.session;
      assert.deepEqual(created.extensionsResult.errors, []);
      await session.bindExtensions({});
      const bash = session.getAllTools().find((tool) => tool.name === "bash");
      assert.notEqual(bash?.sourceInfo.source, "builtin");
      assert.deepEqual(bash?.parameters, createBashToolDefinition(repositoryDir).parameters);
    });
  } finally {
    session?.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("registers an identical static protocol tool surface at every depth", async () => {
  const mainPi = createMockPi();
  await withEnvironment({ [FRAME_ENV]: undefined }, () => extension(mainPi));

  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: "/tmp/pi-subagent-test-ledger.jsonl",
  });
  const childPi = createMockPi();
  await withEnvironment({ [FRAME_ENV]: JSON.stringify(manager) }, () => extension(childPi));

  assert.deepEqual(mainPi.tools.map((tool) => tool.name), ["subagent", "agent_status", "submit_result"]);
  assert.deepEqual(childPi.tools.map((tool) => tool.name), ["subagent", "agent_status", "submit_result"]);
  assert.deepEqual(
    mainPi.tools.map((tool) => JSON.stringify(tool.parameters)),
    childPi.tools.map((tool) => JSON.stringify(tool.parameters)),
  );
  assert.ok(mainPi.tools.every((tool) => tool.executionMode === "sequential"));
  assert.doesNotMatch(JSON.stringify(mainPi.tools[0].parameters), /requireReceipt/);
});

test("a fork snapshot reopens with the exact parent provider-message prefix", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-prefix-test-"));
  const snapshotPath = path.join(tempRoot, "child.jsonl");
  const parent = SessionManager.inMemory(repositoryDir);
  parent.appendMessage({ role: "user", content: "Inspect auth.", timestamp: 1 });
  parent.appendMessage({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "delegate-1",
      name: "subagent",
      arguments: { name: "auth-manager", task: "Refactor auth." },
    }],
    api: "openai-completions",
    provider: "llama.cpp",
    model: "qwen-test",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });

  try {
    const snapshot = buildForkSessionSnapshotJsonl(parent);
    assert.ok(snapshot?.endsWith("\n"));
    fs.writeFileSync(snapshotPath, snapshot, { mode: 0o600 });

    const child = SessionManager.open(snapshotPath, undefined, repositoryDir);
    assert.deepEqual(child.getBranch(), parent.getBranch());
    assert.deepEqual(
      buildSessionContext(child.getBranch()).messages,
      buildSessionContext(parent.getBranch()).messages,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a disposable child contains background jobs created by Pi's built-in bash tool", async () => {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bash-containment-test-"));
  const markerPath = path.join(tempRoot, "background-pid");
  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: path.join(tempRoot, "ledger.jsonl"),
  });
  const pi = createMockPi({ builtInBash: true });

  try {
    await withEnvironment({ [FRAME_ENV]: JSON.stringify(manager) }, async () => {
      extension(pi);
      assert.equal(pi.tools.some((tool) => tool.name === "bash"), false, "Bash was replaced before Pi bound runtime actions");
      await pi.emit("session_start", { type: "session_start", reason: "startup" }, {});
      await pi.emit("session_start", { type: "session_start", reason: "resume" }, {});
      const bash = pi.tools.find((tool) => tool.name === "bash");
      assert.ok(bash, "child did not install its contained bash backend");
      assert.equal(pi.tools.filter((tool) => tool.name === "bash").length, 1, "repeated session_start duplicated Bash");
      const upstreamBash = createBashToolDefinition(repositoryDir);
      assert.deepEqual(
        {
          name: bash.name,
          description: bash.description,
          parameters: bash.parameters,
          promptSnippet: bash.promptSnippet,
          promptGuidelines: bash.promptGuidelines,
        },
        {
          name: upstreamBash.name,
          description: upstreamBash.description,
          parameters: upstreamBash.parameters,
          promptSnippet: upstreamBash.promptSnippet,
          promptGuidelines: upstreamBash.promptGuidelines,
        },
      );
      const delayedOutput = await bash.execute(
        "bash-delayed-output",
        { command: "(sleep 0.05; printf 'late-stdout'; sleep 0.08; printf 'later-stdout'; printf 'late-stderr' >&2) &" },
        undefined,
        undefined,
        {},
      );
      assert.match(delayedOutput.content[0].text, /late-stdout/);
      assert.match(delayedOutput.content[0].text, /later-stdout/);
      assert.match(delayedOutput.content[0].text, /late-stderr/);
      await bash.execute(
        "bash-1",
        {
          command: [
            "if ( : >&3 ) 2>/dev/null; then exit 97; fi",
            "sleep 30 & background=$!",
            "guardian=$PPID",
            `printf '%s %s\\n' "$background" "$guardian" > '${markerPath}'`,
          ].join("\n"),
        },
        undefined,
        undefined,
        {},
      );
      const [backgroundPid, guardianPid] = fs.readFileSync(markerPath, "utf8").trim().split(/\s+/).map(Number);
      assert.equal(isProcessAlive(backgroundPid), true);
      assert.equal(isProcessAlive(guardianPid), true, "guardian did not remain alive after its command shell exited");

      await pi.emit("agent_settled", { type: "agent_settled" }, {});
      assert.equal(await waitFor(() => !isProcessAlive(backgroundPid) && !isProcessAlive(guardianPid)), true);
    });
  } finally {
    await pi.emit("agent_settled", { type: "agent_settled" }, {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a live guardian pins the process-group identity after a short background job exits", async () => {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-short-job-test-"));
  const markerPath = path.join(tempRoot, "short-job-pids");
  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: path.join(tempRoot, "ledger.jsonl"),
  });
  const pi = createMockPi({ builtInBash: true });

  try {
    await withEnvironment({ [FRAME_ENV]: JSON.stringify(manager) }, async () => {
      extension(pi);
      await pi.emit("session_start", { type: "session_start", reason: "startup" }, {});
      const bash = pi.tools.find((tool) => tool.name === "bash");
      assert.ok(bash);
      await bash.execute("bash-short", {
        command: [
          "sleep 0.05 & background=$!",
          "guardian=$PPID",
          `printf '%s %s\\n' "$background" "$guardian" > '${markerPath}'`,
        ].join("\n"),
      }, undefined, undefined, {});
      const [backgroundPid, guardianPid] = fs.readFileSync(markerPath, "utf8").trim().split(/\s+/).map(Number);
      assert.equal(await waitFor(() => !isProcessAlive(backgroundPid)), true, "short background job did not exit");
      assert.equal(isProcessAlive(guardianPid), true, "group identity was not pinned after the payload exited");
      assert.doesNotThrow(() => process.kill(-guardianPid, 0));
      await pi.emit("agent_settled", { type: "agent_settled" }, {});
      assert.equal(await waitFor(() => !isProcessAlive(guardianPid)), true);
    });
  } finally {
    await pi.emit("agent_settled", { type: "agent_settled" }, {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("guardian containment cleans timeout, abort, and concurrent Bash invocations", async () => {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-guardian-lifecycle-test-"));
  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: path.join(tempRoot, "ledger.jsonl"),
  });
  const pi = createMockPi({ builtInBash: true });

  try {
    await withEnvironment({ [FRAME_ENV]: JSON.stringify(manager) }, async () => {
      extension(pi);
      await pi.emit("session_start", { type: "session_start", reason: "startup" }, {});
      const bash = pi.tools.find((tool) => tool.name === "bash");
      assert.ok(bash);

      const timeoutMarker = path.join(tempRoot, "timeout-pids");
      await assert.rejects(
        () => bash.execute("bash-timeout", {
          command: `printf '%s %s\\n' "$$" "$PPID" > '${timeoutMarker}'\nsleep 30`,
          timeout: 0.05,
        }, undefined, undefined, {}),
        /Command timed out after 0\.05 seconds/,
      );
      const timeoutPids = fs.readFileSync(timeoutMarker, "utf8").trim().split(/\s+/).map(Number);
      assert.equal(await waitFor(() => timeoutPids.every((pid) => !isProcessAlive(pid))), true);

      const abortMarker = path.join(tempRoot, "abort-pids");
      const abortController = new AbortController();
      const aborted = bash.execute("bash-abort", {
        command: `printf '%s %s\\n' "$$" "$PPID" > '${abortMarker}'\nsleep 30`,
      }, abortController.signal, undefined, {});
      assert.equal(await waitFor(() => fs.existsSync(abortMarker)), true);
      abortController.abort();
      await assert.rejects(() => aborted, /Command aborted/);
      const abortPids = fs.readFileSync(abortMarker, "utf8").trim().split(/\s+/).map(Number);
      assert.equal(await waitFor(() => abortPids.every((pid) => !isProcessAlive(pid))), true);

      const concurrentMarkers = [0, 1].map((index) => path.join(tempRoot, `concurrent-${index}`));
      await Promise.all(concurrentMarkers.map((marker, index) => bash.execute(`bash-concurrent-${index}`, {
        command: `sleep 30 & printf '%s %s\\n' "$!" "$PPID" > '${marker}'`,
      }, undefined, undefined, {})));
      const concurrentPids = concurrentMarkers.map((marker) =>
        fs.readFileSync(marker, "utf8").trim().split(/\s+/).map(Number));
      assert.equal(new Set(concurrentPids.map(([, guardianPid]) => guardianPid)).size, 2);
      assert.ok(concurrentPids.flat().every(isProcessAlive));

      await pi.emit("agent_settled", { type: "agent_settled" }, {});
      assert.equal(await waitFor(() => concurrentPids.flat().every((pid) => !isProcessAlive(pid))), true);
    });
  } finally {
    await pi.emit("agent_settled", { type: "agent_settled" }, {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a SIGKILLed child Pi closes the private pipe and the guardian self-cleans", async () => {
  if (process.platform === "win32") return;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-guardian-crash-test-"));
  const markerPath = path.join(tempRoot, "crash-pids");
  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: path.join(tempRoot, "ledger.jsonl"),
  });
  const fixturePath = path.join(repositoryDir, "test-fixtures", "fake-pi-bash-guardian.mjs");
  const child = spawn(process.execPath, [fixturePath], {
    cwd: repositoryDir,
    env: {
      ...process.env,
      [FRAME_ENV]: JSON.stringify(manager),
      PI_SUBAGENT_TEST_MARKER: markerPath,
      PI_SUBAGENT_TEST_EXTENSION_URL: testableModuleUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let fixtureStderr = "";
  let guardianPid;
  let backgroundPid;
  child.stderr.on("data", (chunk) => { fixtureStderr += chunk.toString(); });
  child.stdout.resume();

  try {
    assert.equal(await waitFor(() => fs.existsSync(markerPath), 5_000), true, fixtureStderr || "fixture did not start Bash");
    [backgroundPid, guardianPid] = fs.readFileSync(markerPath, "utf8").trim().split(/\s+/).map(Number);
    assert.equal(isProcessAlive(backgroundPid), true);
    assert.equal(isProcessAlive(guardianPid), true);
    process.kill(child.pid, "SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(
      await waitFor(() => !isProcessAlive(backgroundPid) && !isProcessAlive(guardianPid), 3_000),
      true,
      "guardian or background payload survived loss of the child Pi process",
    );
  } finally {
    if (isProcessAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    if (isProcessAlive(guardianPid)) {
      try { process.kill(-guardianPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("submit_result atomically writes a receipt and requests Pi termination", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-submit-test-"));
  const root = loadFrame({}).frame;
  const ledgerPath = createRunLedger(root.rootRunId, tempRoot);
  const manager = createChildFrame({ ...root, ledgerPath }, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath,
  });
  const receiptPath = path.join(tempRoot, "receipt.json");
  const pi = createMockPi();

  try {
    await withEnvironment({
      [FRAME_ENV]: JSON.stringify(manager),
      [RECEIPT_PATH_ENV]: receiptPath,
      [MAX_TURNS_PATH_ENV]: path.join(tempRoot, "max-turns"),
    }, async () => {
      extension(pi);
      const submit = pi.tools.find((tool) => tool.name === "submit_result");
      const context = {
        sessionManager: {
          getBranch: () => [{
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "submit-1", name: "submit_result" }],
            },
          }],
        },
      };
      const result = await submit.execute("submit-1", {
        status: "completed",
        summary: "Manager verified the slice.",
        changedFiles: ["src/auth.ts"],
        checks: [{ id: "unit", status: "passed", command: "npm test", exitCode: 0 }],
        artifacts: [],
        unresolved: [],
      }, undefined, () => {}, context);

      assert.equal(result.terminate, true);
      assert.equal(result.details.status, "completed");
      assert.equal(readReceipt(receiptPath, manager)?.receiptId, result.details.receiptId);
      await assert.rejects(
        () => submit.execute("submit-1", {
          status: "completed",
          summary: "Duplicate.",
          changedFiles: [],
          checks: [],
          artifacts: [],
          unresolved: [],
        }, undefined, () => {}, context),
        /already been called/,
      );
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a missing cache invariant aborts a child at turn_start before inference", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-invariant-test-"));
  const root = loadFrame({}).frame;
  const manager = createChildFrame(root, {
    name: "manager",
    taskId: "manager-task",
    deadlineAtMs: Date.now() + 60_000,
    maxTurns: 10,
    ledgerPath: "/tmp/pi-subagent-test-ledger.jsonl",
  });
  const markerPath = path.join(tempRoot, "cache-error");
  const pi = createMockPi();
  let aborted = false;

  try {
    await withEnvironment({
      [FRAME_ENV]: JSON.stringify(manager),
      [CACHE_INVARIANT_ERROR_PATH_ENV]: markerPath,
    }, async () => {
      extension(pi);
      await pi.emit("session_start", { type: "session_start", reason: "startup" }, {});
      const context = {
        model: { provider: "llama.cpp", id: "qwen" },
        sessionManager: { getBranch: () => [] },
        abort: () => { aborted = true; },
      };
      await pi.emit("before_agent_start", { systemPrompt: "base" }, context);
      await pi.emit("turn_start", { turnIndex: 0 }, context);
    });

    assert.equal(aborted, true);
    assert.match(fs.readFileSync(markerPath, "utf8"), /missing-or-malformed-parent-invariant/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
