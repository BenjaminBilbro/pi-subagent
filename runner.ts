/** Spawn one Pi child with an inherited session and bounded host controls. */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  appendLedgerRecord,
  appendProcessRegistryRecord,
  buildChildEnvironment,
  buildTaskMessage,
  parseReceiptValue,
  readReceipt,
  readActiveProcessPids,
  type AgentFrameV1,
  type CacheInvariantV1,
  type TaskSpecV1,
} from "./protocol.js";
import {
  type SingleResult,
  emptyUsage,
  getFinalOutput,
  normalizeCompletedResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const SIGKILL_TIMEOUT_MS = 1_000;
const TERMINATION_SETTLE_TIMEOUT_MS = 2_500;
const SETTLED_EXIT_GRACE_MS = 2_000;
const MAX_JSON_LINE_BYTES = 25 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

type OnUpdateCallback = (partial: AgentToolResult<unknown>) => void;

export interface RuntimeSelection {
  model?: string;
  thinking?: string;
  tools?: string[];
}

export interface TestSpawnOverride {
  command: string;
  prefixArgs?: string[];
}

export interface RunAgentOptions {
  cwd: string;
  agentName: string;
  taskSpec: TaskSpecV1;
  frame: AgentFrameV1;
  forkSessionSnapshotJsonl: string;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SingleResult[]) => { results: SingleResult[] };
  runtime?: RuntimeSelection;
  requireReceipt?: boolean;
  cacheInvariant?: CacheInvariantV1;
  /** Internal subprocess fixture hook used only by tests. */
  testSpawn?: TestSpawnOverride;
}

export interface UnexpectedSignalFailure {
  exitCode: number;
  message: string;
}

export function getUnexpectedSignalFailure(
  code: number | null,
  signalName: NodeJS.Signals | null,
  wasAborted: boolean,
  forcedExitCode?: number,
): UnexpectedSignalFailure | null {
  if (code !== null || !signalName || wasAborted || forcedExitCode !== undefined) return null;
  const signalNumber = os.constants.signals[signalName];
  return {
    exitCode: typeof signalNumber === "number" ? 128 + signalNumber : 1,
    message: `Subagent terminated unexpectedly by ${signalName}.`,
  };
}

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

function writeInvocationFiles(sessionJsonl: string): {
  dir: string;
  sessionPath: string;
  receiptPath: string;
  maxTurnsPath: string;
  cacheInvariantErrorPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-invocation-"));
  fs.chmodSync(dir, 0o700);
  const sessionPath = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionPath, sessionJsonl, { encoding: "utf8", mode: 0o600 });
  return {
    dir,
    sessionPath,
    receiptPath: path.join(dir, "receipt.json"),
    maxTurnsPath: path.join(dir, "max-turns-exceeded"),
    cacheInvariantErrorPath: path.join(dir, "cache-invariant-error.json"),
  };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The OS temp cleaner can remove an unusually stubborn directory later.
  }
}

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

export function buildPiArgs(
  taskMessage: string,
  forkSessionPath: string,
  runtime: RuntimeSelection = {},
  inherited = inheritedCliArgs,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inherited.extensionArgs,
    ...inherited.alwaysProxy,
    "--session",
    forkSessionPath,
  ];

  const model = runtime.model ?? inherited.fallbackModel;
  if (model) args.push("--model", model);
  const thinking = runtime.thinking ?? inherited.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (runtime.tools !== undefined) {
    if (runtime.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", runtime.tools.join(","));
  } else if (inherited.fallbackTools !== undefined) {
    args.push("--tools", inherited.fallbackTools);
  } else if (inherited.fallbackNoTools) {
    args.push("--no-tools");
  }

  args.push("-p", taskMessage);
  return args;
}

export function isSameWorkingDirectory(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

export function parseDescendantPids(processTable: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of processTable.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }

  const result: number[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (parentPid: number) => {
    for (const childPid of children.get(parentPid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      visit(childPid);
      result.push(childPid);
    }
  };
  visit(rootPid);
  return result;
}

function readProcessTable(): string | null {
  if (isWindows) return null;
  try {
    const result = spawnSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    return result.stdout;
  } catch {
    return null;
  }
}

function getDescendantPids(rootPid: number): number[] {
  const table = readProcessTable();
  return table === null ? [] : parseDescendantPids(table, rootPid);
}

function appendUtf8Tail(current: string, addition: string, maxBytes: number): { text: string; truncated: boolean } {
  const combined = `${current}${addition}`;
  const bytes = Buffer.from(combined, "utf8");
  if (bytes.length <= maxBytes) return { text: combined, truncated: false };
  const marker = "[earlier stderr truncated]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const tail = new StringDecoder("utf8").write(bytes.subarray(bytes.length - (maxBytes - markerBytes)));
  return { text: `${marker}${tail}`, truncated: true };
}

function hasMatchingSubmitToolCall(result: SingleResult, toolCallId: string): boolean {
  return result.submitResultToolCallIds?.includes(toolCallId) === true;
}

export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agentName,
    taskSpec,
    frame,
    forkSessionSnapshotJsonl,
    signal,
    onUpdate,
    makeDetails,
    runtime,
    requireReceipt = true,
    cacheInvariant,
    testSpawn,
  } = opts;

  const result: SingleResult = {
    agent: agentName,
    task: taskSpec.objective,
    taskSpec,
    frame,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    maxTurnsLimit: frame.maxTurns ?? undefined,
    receiptRequired: requireReceipt,
    ledgerPath: frame.ledgerPath ?? undefined,
    startedAtMs: Date.now(),
  };

  if (!forkSessionSnapshotJsonl.trim()) {
    result.exitCode = 1;
    result.processError = true;
    result.stopReason = "error";
    result.errorMessage = "Cannot run subagent: missing parent session snapshot context.";
    result.stderr = result.errorMessage;
    return result;
  }
  if (signal?.aborted) return normalizeCompletedResult(result, true);

  const emitUpdate = () => {
    try {
      onUpdate?.({
        content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
        details: makeDetails([result]),
      });
    } catch {
      // Rendering callbacks must not crash the process protocol.
    }
  };

  let invocationDir: string | null = null;
  let receiptPath: string | null = null;
  let maxTurnsPath: string | null = null;
  let wasAborted = false;

  try {
    const files = writeInvocationFiles(forkSessionSnapshotJsonl);
    invocationDir = files.dir;
    receiptPath = files.receiptPath;
    maxTurnsPath = files.maxTurnsPath;
    const taskMessage = buildTaskMessage(frame, taskSpec);
    const piArgs = buildPiArgs(taskMessage, files.sessionPath, runtime);
    const remainingMs = frame.deadlineAtMs === null ? 0 : frame.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      result.timeout = true;
      result.exitCode = 124;
      result.stopReason = "timeout";
      result.errorMessage = "Subagent deadline elapsed before its process started.";
      result.stderr = result.errorMessage;
    } else {
      const exitCode = await new Promise<number>((resolve) => {
        const spawnTarget = testSpawn ?? resolvePiSpawn();
        const ownsProcessGroup = !isWindows && frame.depth === 1;
        const proc = spawn(spawnTarget.command, [...(spawnTarget.prefixArgs ?? []), ...piArgs], {
          cwd,
          shell: false,
          // Only the root manager owns a process group. Deeper Pi processes
          // remain in that group, allowing the root to tear down the full
          // serial stack using only the trusted PID returned by spawn().
          detached: ownsProcessGroup,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ...buildChildEnvironment(
              frame,
              files.receiptPath,
              files.maxTurnsPath,
              cacheInvariant,
              files.cacheInvariantErrorPath,
            ),
            [PI_OFFLINE_ENV]: "1",
          },
        });

        proc.stdin.on("error", () => {
          // Ignore a broken pipe when Pi exits before consuming stdin.
        });
        proc.stdin.end();

        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let buffer = "";
        let didClose = false;
        let finished = false;
        let terminationStarted = false;
        let forcedExitCode: number | undefined;
        let abortHandler: (() => void) | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;
        let settledExitTimer: NodeJS.Timeout | undefined;
        let sigkillTimer: NodeJS.Timeout | undefined;
        let forceSettleTimer: NodeJS.Timeout | undefined;
        let treePollTimer: NodeJS.Timeout | undefined;
        let onStdoutData: ((chunk: Buffer) => void) | undefined;
        let onStderrData: ((chunk: Buffer) => void) | undefined;
        const knownTreePids = new Set<number>();
        let registryReportsActiveDescendants = false;

        if (proc.pid !== undefined) {
          knownTreePids.add(proc.pid);
          try {
            appendProcessRegistryRecord(frame.ledgerPath!, {
              event: "started",
              rootRunId: frame.rootRunId,
              runId: frame.runId,
              parentRunId: frame.parentRunId ?? frame.rootRunId,
              pid: proc.pid,
            });
          } catch (error) {
            result.processError = true;
            result.stopReason = "error";
            result.errorMessage = `Could not register the subagent process: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        const appendStderr = (text: string) => {
          const bounded = appendUtf8Tail(result.stderr, text, MAX_STDERR_BYTES);
          result.stderr = bounded.text;
          if (bounded.truncated) result.stderrTruncated = true;
        };

        const finish = (code: number) => {
          if (finished) return;
          finished = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (settledExitTimer) clearTimeout(settledExitTimer);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          if (forceSettleTimer) clearTimeout(forceSettleTimer);
          if (treePollTimer) clearInterval(treePollTimer);
          if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
          if (onStdoutData) proc.stdout.off("data", onStdoutData);
          if (onStderrData) proc.stderr.off("data", onStderrData);
          proc.stdin.destroy();
          proc.stdout.destroy();
          proc.stderr.destroy();
          if (!didClose) proc.unref();
          resolve(forcedExitCode ?? code);
        };

        const rememberTree = () => {
          if (proc.pid === undefined) return;
          knownTreePids.add(proc.pid);
          if (frame.ledgerPath) {
            try {
              // Registry entries are audit-only. They can trigger a safe
              // cleanup of the trusted direct child's group, but never add a
              // PID to the signal set.
              registryReportsActiveDescendants =
                readActiveProcessPids(frame.ledgerPath, frame.runId, frame.rootRunId).length > 0;
            } catch {
              // Fall through to the process-table best effort below.
            }
          }
          if (!didClose) {
            for (const pid of getDescendantPids(proc.pid)) knownTreePids.add(pid);
          }
        };

        const currentAnchoredDescendants = () => {
          if (proc.pid === undefined || didClose) return [];
          return getDescendantPids(proc.pid).filter((pid) => pid > 1 && pid !== proc.pid);
        };

        const signalKnownTree = (signalName: NodeJS.Signals) => {
          if (proc.pid === undefined) return;
          rememberTree();
          if (ownsProcessGroup && ownedProcessGroupIsAlive()) {
            try {
              process.kill(-proc.pid, signalName);
            } catch {
              // The trusted child group may already be gone.
            }
          }
          // Only a fresh OS ancestry walk may add individual signal targets.
          // Registry records and stale observations are never trusted here.
          for (const pid of currentAnchoredDescendants()) {
            try {
              process.kill(pid, signalName);
            } catch {
              // The process may have exited between discovery and signalling.
            }
          }
          if (!didClose) {
            try {
              process.kill(proc.pid, signalName);
            } catch {
              // The direct child may already be gone.
            }
          }
        };

        const anyKnownDescendantAlive = () => {
          for (const pid of knownTreePids) {
            if (pid === proc.pid) continue;
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              // Already gone.
            }
          }
          return false;
        };

        const ownedProcessGroupIsAlive = () => {
          if (!ownsProcessGroup || proc.pid === undefined) return false;
          try {
            process.kill(-proc.pid, 0);
            return true;
          } catch {
            return false;
          }
        };

        const cleanupTargetsAreAlive = () => {
          rememberTree();
          return (
            (!didClose && proc.pid !== undefined) ||
            anyKnownDescendantAlive() ||
            ownedProcessGroupIsAlive()
          );
        };

        const terminateChild = () => {
          if (terminationStarted) return;
          terminationStarted = true;
          if (settledExitTimer) {
            clearTimeout(settledExitTimer);
            settledExitTimer = undefined;
          }
          if (isWindows) {
            if (proc.pid !== undefined) {
              const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { stdio: "ignore" });
              killer.unref();
            }
          } else {
            signalKnownTree("SIGTERM");
            sigkillTimer = setTimeout(() => signalKnownTree("SIGKILL"), SIGKILL_TIMEOUT_MS);
          }
          treePollTimer = setInterval(() => {
            if (didClose && !cleanupTargetsAreAlive()) finish(forcedExitCode ?? (wasAborted ? 130 : 1));
          }, 50);
          forceSettleTimer = setTimeout(() => {
            if (!isWindows) signalKnownTree("SIGKILL");
            if (!finished) finish(forcedExitCode ?? (wasAborted ? 130 : 1));
          }, TERMINATION_SETTLE_TIMEOUT_MS);
        };

        const maybeScheduleSettledExit = () => {
          if (!result.sawAgentSettled || didClose || finished || settledExitTimer) return;
          settledExitTimer = setTimeout(() => {
            if (didClose || finished || terminationStarted) return;
            forcedExitCode = 0;
            terminateChild();
          }, SETTLED_EXIT_GRACE_MS);
          settledExitTimer.unref();
        };

        const flushLine = (line: string) => {
          if (!line.trim() || finished) return;
          if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
            result.processError = true;
            result.stopReason = "error";
            result.errorMessage = `Subagent emitted a JSON event larger than ${MAX_JSON_LINE_BYTES} bytes.`;
            appendStderr(`${result.stderr ? "\n" : ""}${result.errorMessage}`);
            forcedExitCode = 1;
            terminateChild();
            return;
          }
          try {
            JSON.parse(line);
          } catch {
            appendStderr(`${result.stderr ? "\n" : ""}[non-JSON stdout omitted]`);
            return;
          }
          if (processPiJsonLine(line, result)) emitUpdate();
          if (
            result.maxTurnsLimit !== undefined &&
            result.usage.turns > result.maxTurnsLimit
          ) {
            result.maxTurnsExceeded = true;
            forcedExitCode = 1;
            terminateChild();
          }
          maybeScheduleSettledExit();
        };

        const flushBufferedLines = (text: string) => {
          for (const line of text.split(/\r?\n/)) flushLine(line);
        };

        onStdoutData = (chunk: Buffer) => {
          buffer += stdoutDecoder.write(chunk);
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) flushLine(line);
          if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_LINE_BYTES) {
            flushLine(buffer);
            buffer = "";
          }
        };

        onStderrData = (chunk: Buffer) => appendStderr(stderrDecoder.write(chunk));
        proc.stdout.on("data", onStdoutData);
        proc.stderr.on("data", onStderrData);

        timeoutTimer = setTimeout(() => {
          if (didClose || finished) return;
          result.timeout = true;
          result.stopReason = "timeout";
          result.errorMessage = `Subagent exceeded its deadline after ${Math.ceil(remainingMs / 1000)}s.`;
          appendStderr(`${result.stderr ? "\n" : ""}${result.errorMessage}`);
          forcedExitCode = 124;
          terminateChild();
        }, remainingMs);
        timeoutTimer.unref();

        proc.on("close", (code, signalName) => {
          didClose = true;
          if (proc.pid !== undefined && frame.ledgerPath) {
            try {
              appendProcessRegistryRecord(frame.ledgerPath, {
                event: "stopped",
                rootRunId: frame.rootRunId,
                runId: frame.runId,
                parentRunId: frame.parentRunId ?? frame.rootRunId,
                pid: proc.pid,
              });
            } catch {
              result.processError = true;
              result.stopReason = "error";
              result.errorMessage = "Could not record that the subagent process stopped.";
              forcedExitCode = 1;
            }
          }
          buffer += stdoutDecoder.end();
          const stderrRemainder = stderrDecoder.end();
          if (stderrRemainder) appendStderr(stderrRemainder);
          if (buffer.trim()) flushBufferedLines(buffer);
          result.exitSignal = signalName ?? undefined;

          const signalFailure = getUnexpectedSignalFailure(code, signalName, wasAborted, forcedExitCode);
          if (signalFailure) {
            result.processError = true;
            result.stopReason = "error";
            result.errorMessage = signalFailure.message;
            appendStderr(`${result.stderr ? "\n" : ""}${signalFailure.message}`);
            forcedExitCode = signalFailure.exitCode;
          }
          rememberTree();
          const plainNonzeroExit = code !== null && code !== 0 && forcedExitCode === undefined;
          if (plainNonzeroExit) {
            result.processError = true;
            result.stopReason = "error";
            result.errorMessage = `Subagent process exited with code ${code}.`;
            appendStderr(`${result.stderr ? "\n" : ""}${result.errorMessage}`);
            forcedExitCode = code;
          }
          if (registryReportsActiveDescendants) {
            result.processError = true;
            result.stopReason = "error";
            result.errorMessage = "Subagent exited while a nested process was still registered as active.";
            appendStderr(`${result.stderr ? "\n" : ""}${result.errorMessage}`);
            forcedExitCode = forcedExitCode ?? 1;
          }
          if ((signalFailure || plainNonzeroExit || registryReportsActiveDescendants) && !terminationStarted) {
            terminateChild();
          }
          if (terminationStarted && cleanupTargetsAreAlive()) return;
          finish(code ?? signalFailure?.exitCode ?? 1);
        });

        proc.on("error", (error) => {
          result.processError = true;
          result.stopReason = "error";
          result.errorMessage = error.message;
          appendStderr(`${result.stderr ? "\n" : ""}${error.message}`);
          forcedExitCode = 1;
          finish(1);
        });

        if (signal) {
          abortHandler = () => {
            if (didClose || finished) return;
            wasAborted = true;
            forcedExitCode = 130;
            terminateChild();
          };
          if (signal.aborted) abortHandler();
          else signal.addEventListener("abort", abortHandler, { once: true });
        }
      });
      result.exitCode = exitCode;
    }

    let recoveryReceipt;
    if (receiptPath) {
      try {
        recoveryReceipt = readReceipt(receiptPath, frame);
      } catch (error) {
        result.processError = true;
        result.stopReason = "error";
        result.errorMessage = error instanceof Error ? error.message : String(error);
        if (!result.stderr.trim()) result.stderr = result.errorMessage;
      }
    }
    if (!result.processError && result.submittedReceiptEvent) {
      try {
        if (!hasMatchingSubmitToolCall(result, result.submittedReceiptEvent.toolCallId)) {
          throw new Error("Successful submit_result event did not match a captured assistant tool call.");
        }
        const eventReceipt = parseReceiptValue(result.submittedReceiptEvent.details, frame);
        if (!recoveryReceipt) throw new Error("Successful submit_result event did not have its recovery receipt file.");
        if (JSON.stringify(eventReceipt) !== JSON.stringify(recoveryReceipt)) {
          throw new Error("submit_result event and recovery receipt file did not match.");
        }
        result.receipt = eventReceipt;
      } catch (error) {
        result.processError = true;
        result.stopReason = "error";
        result.errorMessage = error instanceof Error ? error.message : String(error);
        if (!result.stderr.trim()) result.stderr = result.errorMessage;
      }
    } else if (!result.processError && recoveryReceipt) {
      result.processError = true;
      result.stopReason = "error";
      result.errorMessage = "A recovery receipt file existed without a successful submit_result tool event.";
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
    }
    if (maxTurnsPath && fs.existsSync(maxTurnsPath)) result.maxTurnsExceeded = true;
    if (invocationDir) {
      const invariantErrorPath = path.join(invocationDir, "cache-invariant-error.json");
      if (fs.existsSync(invariantErrorPath)) {
        const invariantError = fs.readFileSync(invariantErrorPath, "utf8").trim();
        result.processError = true;
        result.stopReason = "cache_invariant";
        result.errorMessage = invariantError || "Subagent cache-prefix invariant failed.";
        if (!result.stderr.trim()) result.stderr = result.errorMessage;
      }
    }
  } catch (error) {
    result.exitCode = 1;
    result.processError = true;
    result.stopReason = "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    if (!result.stderr.trim()) result.stderr = result.errorMessage;
  } finally {
    result.finishedAtMs = Date.now();
    cleanupTempDir(invocationDir);
  }

  const normalized = normalizeCompletedResult(result, wasAborted);
  if (frame.ledgerPath) {
    try {
      appendLedgerRecord(frame.ledgerPath, {
        kind: "pi-subagent-invocation",
        protocolVersion: 1,
        rootRunId: frame.rootRunId,
        runId: frame.runId,
        parentRunId: frame.parentRunId,
        taskId: frame.taskId,
        role: frame.role,
        name: frame.name,
        startedAtMs: result.startedAtMs,
        finishedAtMs: result.finishedAtMs,
        exitCode: normalized.exitCode,
        stopReason: normalized.stopReason ?? null,
        receiptId: normalized.receipt?.receiptId ?? null,
        receiptStatus: normalized.receipt?.status ?? null,
        usage: normalized.usage,
      });
    } catch (error) {
      normalized.processError = true;
      normalized.exitCode = 1;
      normalized.stopReason = "error";
      normalized.errorMessage = `Could not append the subagent ledger: ${error instanceof Error ? error.message : String(error)}`;
      if (!normalized.stderr.trim()) normalized.stderr = normalized.errorMessage;
    }
  }
  return normalized;
}
