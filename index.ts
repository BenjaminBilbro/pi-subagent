/**
 * Cache-stable, serial subagents for Pi.
 *
 * Pi remains responsible for constructing every provider message and tool call.
 * This extension only snapshots Pi's session, appends a child task through Pi,
 * and carries host-owned frame state outside the prompt.
 */

import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
	SettingsManager,
	buildSessionContext,
	createBashToolDefinition,
	createLocalBashOperations,
	getShellConfig,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderCall, renderResult } from "./render.js";
import { getResultSummaryText } from "./runner-events.js";
import { isSameWorkingDirectory, runAgent } from "./runner.js";
import {
	DEFAULT_MAX_TURNS,
	DEFAULT_TIMEOUT_SECONDS,
	MAX_MAX_TURNS,
	MAX_NAME_CHARS,
	MAX_RECEIPT_ITEM_CHARS,
	MAX_RECEIPT_ITEMS,
	MAX_SUMMARY_CHARS,
	MAX_TASK_CHARS,
	MAX_TASK_ID_CHARS,
	MAX_TASK_LIST_ITEM_CHARS,
	MAX_TASK_LIST_ITEMS,
	MAX_TIMEOUT_SECONDS,
	MAX_TURNS_PATH_ENV,
	CACHE_INVARIANT_ENV,
	CACHE_INVARIANT_ERROR_PATH_ENV,
	RECEIPT_PATH_ENV,
	appendLedgerRecord,
	createChildFrame,
	createReceipt,
	createRunLedger,
	createTaskSpec,
	formatReceiptForParent,
	getMissingRequiredSubagentTools,
	loadFrame,
	mayDelegate,
	validateSoleToolCall,
	writeReceipt,
	type AgentFrameV1,
	type CacheInvariantV1,
	type CheckStatus,
	type ReceiptStatus,
} from "./protocol.js";
import { compactResultForSession, isResultError, isResultSuccess, type SingleResult } from "./types.js";

const SUBAGENT_INSTRUCTIONS = `
## Serial Sub-Agent Extension

This Pi session can operate as a main agent, manager, or disposable worker. The system prompt and tool schemas are intentionally identical in every role.

- Call \`agent_status\` at the beginning of an assigned child task, and whenever your role is unclear. Its host-owned result is authoritative.
- A child task begins with matching \`[PI_SUBAGENT_RUN_FRAME_V1]\` and \`[PI_SUBAGENT_TASK_SPEC_V1]\` blocks in the newest user message.
- The main agent delegates focused manager tasks, or sets \`role: "worker"\` for a one-off task that needs no further delegation.
- A manager should stay compact: use sequential workers for scouting, implementation, and verification instead of accumulating raw exploration. Make exactly one \`subagent\` call per assistant message.
- A worker completes its narrow task and may delegate only when \`agent_status.mayDelegate\` is true.
- Every manager and worker must finish by calling \`submit_result\` exactly once, as the only tool call in its final assistant message. Report concrete checks and unresolved issues; do not claim independent verification for checks you did not run.
- The shared filesystem is not rolled back when a child context is discarded. Inspect existing work, preserve unrelated changes, and verify persistent side effects.

The \`subagent\` tool always inherits Pi's current session context, system prompt, model, active tools, thinking level, and working directory. Role and depth restrictions are enforced by the host even though the tool remains visible at every depth.
`;

const StringList = (description: string) =>
	Type.Array(Type.String({ maxLength: MAX_TASK_LIST_ITEM_CHARS }), {
		description,
		maxItems: MAX_TASK_LIST_ITEMS,
	});

const SubagentParams = Type.Object({
	name: Type.String({
		description: "Short freeform name for this child frame, unique within the active delegation path.",
		minLength: 1,
		maxLength: MAX_NAME_CHARS,
	}),
	role: Type.Optional(Type.Literal("worker", {
		description: "Main-only. Spawn this depth-1 child as a terminal worker instead of the default manager.",
	})),
	taskId: Type.Optional(Type.String({
		description: "Stable task identifier. A host-derived identifier is used when omitted.",
		minLength: 1,
		maxLength: MAX_TASK_ID_CHARS,
	})),
	task: Type.String({
		description: "Narrow objective. The child receives the complete current Pi session context.",
		minLength: 1,
		maxLength: MAX_TASK_CHARS,
	}),
	scope: Type.Optional(StringList("Files, modules, or concerns that are in scope.")),
	nonGoals: Type.Optional(StringList("Explicit non-goals that bound the task.")),
	acceptance: Type.Optional(StringList("Observable acceptance criteria for completion.")),
	verification: Type.Optional(StringList("Commands or checks the child should run and report.")),
	timeout: Type.Optional(Type.Number({
		description: `Maximum wall-clock seconds, capped by the parent deadline. Default: ${DEFAULT_TIMEOUT_SECONDS}.`,
		default: DEFAULT_TIMEOUT_SECONDS,
		minimum: 1,
		maximum: MAX_TIMEOUT_SECONDS,
		multipleOf: 1,
	})),
	maxTurns: Type.Optional(Type.Number({
		description: `Maximum child LLM turns. Default: ${DEFAULT_MAX_TURNS}.`,
		default: DEFAULT_MAX_TURNS,
		minimum: 1,
		maximum: MAX_MAX_TURNS,
		multipleOf: 1,
	})),
	cwd: Type.Optional(Type.String({
		description: "Compatibility parameter. It must resolve to the parent's exact working directory in cache-stable mode.",
	})),
});

const AgentStatusParams = Type.Object({});

const SubmittedCheckSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: MAX_RECEIPT_ITEM_CHARS }),
	status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")], {
		description: "Outcome of this reported check. Passed requires exit code 0; failed cannot use 0; skipped cannot include an exit code.",
	}),
	command: Type.Optional(Type.String({ maxLength: MAX_RECEIPT_ITEM_CHARS })),
	exitCode: Type.Optional(Type.Number({ description: "Integer process exit code, consistent with status.", multipleOf: 1 })),
	evidence: Type.Optional(Type.String({ maxLength: MAX_RECEIPT_ITEM_CHARS })),
});

const ReceiptStringList = Type.Array(Type.String({ maxLength: MAX_RECEIPT_ITEM_CHARS }), {
	maxItems: MAX_RECEIPT_ITEMS,
});

const SubmitResultParams = Type.Object({
	status: Type.Union([
		Type.Literal("completed"),
		Type.Literal("partial"),
		Type.Literal("blocked"),
		Type.Literal("failed"),
	], { description: "Final task status. Completed cannot include failed checks or unresolved issues." }),
	summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_CHARS }),
	changedFiles: Type.Optional(ReceiptStringList),
	checks: Type.Optional(Type.Array(SubmittedCheckSchema, { maxItems: MAX_RECEIPT_ITEMS })),
	artifacts: Type.Optional(ReceiptStringList),
	unresolved: Type.Optional(ReceiptStringList),
});

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

export function buildForkSessionSnapshotJsonl(sessionManager: SessionSnapshotSource): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;
	const lines = [JSON.stringify(header)];
	for (const entry of sessionManager.getBranch()) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

function makeTaskId(name: string, explicitTaskId: string | undefined, toolCallId: string): string {
	if (explicitTaskId?.trim()) return explicitTaskId.trim();
	const slug = name
		.trim()
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80) || "task";
	const suffix = toolCallId.replace(/[^a-zA-Z0-9]/g, "").slice(-12) || Date.now().toString(36);
	return `${slug}-${suffix}`.slice(0, MAX_TASK_ID_CHARS);
}

function assertReceiptStatus(value: string): asserts value is ReceiptStatus {
	if (!["completed", "partial", "blocked", "failed"].includes(value)) {
		throw new Error(`Invalid submit_result status: ${JSON.stringify(value)}.`);
	}
}

function assertCheckStatus(value: string): asserts value is CheckStatus {
	if (!["passed", "failed", "skipped"].includes(value)) {
		throw new Error(`Invalid check status: ${JSON.stringify(value)}.`);
	}
}

function compactFallback(text: string, maxBytes = 16 * 1024): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[model-facing fallback truncated]`;
}

function formatFailureForParent(result: SingleResult): string {
	return `PI_SUBAGENT_FAILURE_V1\n${JSON.stringify({
		kind: "pi-subagent-parent-failure",
		protocolVersion: 1,
		cause: result.stopReason ?? "error",
		error: result.errorMessage ?? getResultSummaryText(result),
		provisionalReceipt: result.receipt
			? {
				receiptId: result.receipt.receiptId,
				reportedStatus: result.receipt.status,
				summary: result.receipt.summary,
				receiptIsProvisional: true,
			}
			: null,
		ledgerPath: result.ledgerPath ?? null,
	})}`;
}

function getRuntimeSelection(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "model">) {
	const activeModel = ctx.model;
	return {
		model: activeModel?.provider && activeModel.id ? `${activeModel.provider}/${activeModel.id}` : undefined,
		thinking: pi.getThinkingLevel(),
		tools: pi.getActiveTools(),
	};
}

function hasFailedSubagentResult(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const results = (details as { results?: unknown }).results;
	return Array.isArray(results) && results.some((result) => isResultError(result as SingleResult));
}

function sha256(value: unknown): string {
	return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function getToolSchemaHash(pi: ExtensionAPI): string {
	const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const ordered = pi.getActiveTools().map((name) => {
		const tool = byName.get(name);
		return tool
			? { name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }
			: { name, missing: true };
	});
	return sha256(ordered);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASH_GUARDIAN_PATH = fileURLToPath(new URL("./bash-guardian.js", import.meta.url));
const GUARDIAN_READY_TIMEOUT_MS = 2_000;
const GUARDIAN_CLOSE_TIMEOUT_MS = 1_000;
const POST_EXIT_STDIO_GRACE_MS = 100;
const MAX_GUARDIAN_STATUS_BYTES = 64 * 1024;
const MAX_BASH_TIMEOUT_MS = 2_147_483_647;

interface GuardianHandle {
	proc: ChildProcess;
	pid: number;
	closed: boolean;
	stopRequested: boolean;
	killIssued: boolean;
	closePromise: Promise<void>;
}

function resolveBashTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1_000;
	if (timeoutMs > MAX_BASH_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_BASH_TIMEOUT_MS / 1_000} seconds`);
	}
	return timeoutMs;
}

/**
 * Wrap Pi's built-in bash backend inside disposable child frames. Each command
 * runs under a live guardian process that owns and pins its process-group ID
 * until child settlement. The model-visible Bash schema and original tool-call
 * arguments remain unchanged.
 */
function createContainedBash(
	cwd: string,
): {
	definition: ReturnType<typeof createBashToolDefinition>;
	cleanup: () => Promise<void>;
	cleanupSync: () => void;
	getFailure: () => string | null;
} {
	fs.accessSync(BASH_GUARDIAN_PATH, fs.constants.R_OK);
	const settings = SettingsManager.create(cwd);
	const baseOperations = createLocalBashOperations({ shellPath: settings.getShellPath() });
	const shell = process.platform === "win32" ? null : getShellConfig(settings.getShellPath());
	const guardians = new Set<GuardianHandle>();
	let containmentFailure: string | null = null;

	const recordFailure = (message: string) => {
		containmentFailure ??= message;
	};

	const forceKillGuardian = (guardian: GuardianHandle) => {
		if (
			guardian.closed || guardian.killIssued ||
			guardian.proc.exitCode !== null || guardian.proc.signalCode !== null
		) return;
		guardian.killIssued = true;
		try {
			// The direct ChildProcess is still live, so its detached group ID
			// cannot have been reused by an unrelated process.
			process.kill(-guardian.pid, "SIGKILL");
		} catch {
			// The guardian may have closed between the live-handle check and kill.
		}
	};

	const stopGuardian = async (guardian: GuardianHandle) => {
		if (guardian.closed) return;
		if (!guardian.stopRequested) {
			guardian.stopRequested = true;
			try {
				guardian.proc.stdin?.write(`${JSON.stringify({ kind: "cleanup" })}\n`);
			} catch {
				forceKillGuardian(guardian);
			}
		}
		const closedGracefully = await Promise.race([
			guardian.closePromise.then(() => true),
			delay(GUARDIAN_CLOSE_TIMEOUT_MS).then(() => false),
		]);
		if (!closedGracefully) forceKillGuardian(guardian);
		await Promise.race([guardian.closePromise, delay(GUARDIAN_CLOSE_TIMEOUT_MS)]);
	};

	const operations: BashOperations = {
		async exec(command, commandCwd, options) {
			if (process.platform === "win32") return baseOperations.exec(command, commandCwd, options);
			if (!shell) throw new Error("Could not resolve the configured POSIX shell.");
			if (options.signal?.aborted) throw new Error("aborted");
			const timeoutMs = resolveBashTimeoutMs(options.timeout);
			const proc = spawn(
				process.execPath,
				[BASH_GUARDIAN_PATH, JSON.stringify({ ...shell, cwd: commandCwd })],
				{
					cwd: commandCwd,
					detached: true,
					env: options.env,
					stdio: ["pipe", "pipe", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			if (proc.pid === undefined) {
				throw new Error("Could not start the child Bash containment guardian.");
			}

			let resolveClose!: () => void;
			const guardian: GuardianHandle = {
				proc,
				pid: proc.pid,
				closed: false,
				stopRequested: false,
				killIssued: false,
				closePromise: new Promise((resolve) => {
					resolveClose = resolve;
				}),
			};
			guardians.add(guardian);
			proc.stdin?.on("error", () => {
				// close/error handlers below own the containment failure state.
			});
			proc.once("close", (code, signal) => {
				guardian.closed = true;
				guardians.delete(guardian);
				resolveClose();
				if (!guardian.stopRequested) {
					recordFailure(`Bash containment guardian ${guardian.pid} exited unexpectedly (${signal ?? code ?? "unknown"}).`);
				}
			});

			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const statusStream = proc.stdio[3];
				const decoder = new StringDecoder("utf8");
				let statusBuffer = "";
				let commandSettled = false;
				let ready = false;
				let timeoutTimer: NodeJS.Timeout | undefined;
				let postExitTimer: NodeJS.Timeout | undefined;
				let pendingExitCode: number | null | undefined;
				const readyTimer = setTimeout(() => {
					finishError(new Error("Timed out waiting for the child Bash containment guardian."));
				}, GUARDIAN_READY_TIMEOUT_MS);

				const removeOutputListeners = () => {
					proc.stdout?.off("data", onOutput);
					proc.stderr?.off("data", onOutput);
					proc.stdout?.resume();
					proc.stderr?.resume();
				};
				const finishCommon = () => {
					clearTimeout(readyTimer);
					if (timeoutTimer) clearTimeout(timeoutTimer);
					if (postExitTimer) clearTimeout(postExitTimer);
					if (options.signal) options.signal.removeEventListener("abort", onAbort);
					removeOutputListeners();
				};
				const finishError = (error: Error) => {
					if (commandSettled) return;
					commandSettled = true;
					finishCommon();
					void stopGuardian(guardian).finally(() => reject(error));
				};
				const finishResult = (exitCode: number | null) => {
					if (commandSettled) return;
					commandSettled = true;
					finishCommon();
					resolve({ exitCode });
				};
				const onAbort = () => finishError(new Error("aborted"));
				const armPostExitIdleTimer = () => {
					if (pendingExitCode === undefined || commandSettled) return;
					if (postExitTimer) clearTimeout(postExitTimer);
					postExitTimer = setTimeout(() => finishResult(pendingExitCode!), POST_EXIT_STDIO_GRACE_MS);
				};
				const onOutput = (chunk: Buffer) => {
					options.onData(chunk);
					// Match Pi's built-in waitForChildProcess behavior: once the
					// command shell exits, retain late descendant output until both
					// streams have been quiet for one grace window.
					armPostExitIdleTimer();
				};

				const handleStatusLine = (line: string) => {
					if (!line.trim() || commandSettled) return;
					let value: unknown;
					try {
						value = JSON.parse(line);
					} catch {
						finishError(new Error("Bash containment guardian emitted malformed status JSON."));
						return;
					}
					if (!value || typeof value !== "object") {
						finishError(new Error("Bash containment guardian emitted an invalid status record."));
						return;
					}
					const status = value as Record<string, unknown>;
					if (status.kind === "ready") {
						if (ready || status.pid !== guardian.pid) {
							finishError(new Error("Bash containment guardian identity did not match its live child process."));
							return;
						}
						ready = true;
						clearTimeout(readyTimer);
						try {
							proc.stdin?.write(`${JSON.stringify({ kind: "start", command })}\n`);
						} catch {
							finishError(new Error("Could not send the Bash command to its containment guardian."));
							return;
						}
						if (timeoutMs !== undefined) {
							timeoutTimer = setTimeout(
								() => finishError(new Error(`timeout:${options.timeout}`)),
								timeoutMs,
							);
						}
						return;
					}
					if (!ready) {
						finishError(new Error("Bash containment guardian reported command state before its identity was established."));
						return;
					}
					if (status.kind === "command_exit") {
						if (
							pendingExitCode !== undefined ||
							(status.exitCode !== null && !Number.isInteger(status.exitCode))
						) {
							finishError(new Error("Bash containment guardian reported an invalid exit code."));
							return;
						}
						pendingExitCode = status.exitCode as number | null;
						armPostExitIdleTimer();
						return;
					}
					if (status.kind === "command_error" || status.kind === "guardian_error") {
						finishError(new Error(typeof status.message === "string" ? status.message : "Bash containment guardian failed."));
						return;
					}
					finishError(new Error("Bash containment guardian emitted an unknown status record."));
				};

				proc.stdout?.on("data", onOutput);
				proc.stderr?.on("data", onOutput);
				statusStream?.on("data", (chunk: Buffer) => {
					statusBuffer += decoder.write(chunk);
					if (Buffer.byteLength(statusBuffer, "utf8") > MAX_GUARDIAN_STATUS_BYTES) {
						finishError(new Error("Bash containment guardian status exceeded its byte limit."));
						return;
					}
					const lines = statusBuffer.split(/\r?\n/);
					statusBuffer = lines.pop() ?? "";
					for (const line of lines) handleStatusLine(line);
				});
				statusStream?.once("error", (error) => finishError(error));
				proc.once("error", (error) => finishError(error));
				proc.once("close", () => {
					statusBuffer += decoder.end();
					if (statusBuffer.trim()) handleStatusLine(statusBuffer);
					if (!commandSettled) finishError(new Error("Bash containment guardian closed before the command completed."));
				});
				if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
			});
		},
	};

	const cleanupSync = () => {
		for (const guardian of guardians) {
			guardian.stopRequested = true;
			forceKillGuardian(guardian);
		}
	};
	const cleanup = async () => {
		await Promise.all([...guardians].map((guardian) => stopGuardian(guardian)));
	};

	return {
		definition: createBashToolDefinition(cwd, {
			commandPrefix: settings.getShellCommandPrefix(),
			operations,
		}),
		cleanup,
		cleanupSync,
		getFailure: () => containmentFailure,
	};
}

function parseExpectedCacheInvariant(): CacheInvariantV1 | null {
	const raw = process.env[CACHE_INVARIANT_ENV];
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<CacheInvariantV1>;
		if (
			value.kind !== "pi-subagent-cache-invariant" || value.protocolVersion !== 1 ||
			![value.contextSha256, value.systemPromptSha256, value.toolsSha256, value.model, value.thinking]
				.every((item) => typeof item === "string" && item.length > 0)
		) return null;
		return value as CacheInvariantV1;
	} catch {
		return null;
	}
}

function writeCacheInvariantError(message: string): void {
	const errorPath = process.env[CACHE_INVARIANT_ERROR_PATH_ENV];
	if (!errorPath) return;
	try {
		fs.writeFileSync(errorPath, message, { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export default function (pi: ExtensionAPI) {
	const loaded = loadFrame();
	const frame = loaded.frame;
	let ledgerPath = frame.ledgerPath;
	let activeChild: AgentFrameV1 | null = null;
	let receiptSubmitted = false;
	let turnsStarted = 0;
	let currentSystemPromptHash: string | null = null;
	let cacheInvariantFailure: string | null = null;
	let containmentSetupFailure: string | null = null;
	let containmentFailureReported = false;
	const expectedCacheInvariant = parseExpectedCacheInvariant();
	let containedBash: ReturnType<typeof createContainedBash> | null = null;

	// Runtime action methods are unavailable while Pi loads extension factories.
	// session_start runs after the tool registry is bound and before the first
	// provider request, so it is the earliest safe point to detect/replace Bash.
	pi.on("session_start", () => {
		if (frame.role === "main" || containedBash || containmentSetupFailure) return;
		try {
			const builtInBash = pi.getAllTools().find(
				(tool) => tool.name === "bash" && tool.sourceInfo.source === "builtin",
			);
			if (!builtInBash) return;
			const next = createContainedBash(process.cwd());
			pi.registerTool(next.definition);
			containedBash = next;
			process.once("exit", next.cleanupSync);
		} catch (error) {
			containmentSetupFailure = `Could not initialize child Bash containment: ${error instanceof Error ? error.message : String(error)}`;
		}
	});

	pi.on("agent_settled", async () => {
		await containedBash?.cleanup();
	});

	pi.on("session_shutdown", async () => {
		await containedBash?.cleanup();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const systemPrompt = event.systemPrompt + SUBAGENT_INSTRUCTIONS;
		currentSystemPromptHash = sha256(systemPrompt);
		if (frame.role !== "main") {
			const runtime = getRuntimeSelection(pi, ctx);
			const actual: CacheInvariantV1 = {
				kind: "pi-subagent-cache-invariant",
				protocolVersion: 1,
				contextSha256: sha256(buildSessionContext(ctx.sessionManager.getBranch()).messages),
				systemPromptSha256: currentSystemPromptHash,
				toolsSha256: getToolSchemaHash(pi),
				model: runtime.model ?? "(none)",
				thinking: runtime.thinking ?? "(none)",
			};
			const mismatches = expectedCacheInvariant
				? (["contextSha256", "systemPromptSha256", "toolsSha256", "model", "thinking"] as const)
					.filter((key) => actual[key] !== expectedCacheInvariant[key])
				: ["missing-or-malformed-parent-invariant"];
			if (mismatches.length > 0) {
				const message = `Cache-prefix invariant failed before the child model call: ${mismatches.join(", ")}.`;
				cacheInvariantFailure = message;
				writeCacheInvariantError(message);
			}
		}
		return { systemPrompt };
	});

	// Custom tool execute results do not have an isError field in current Pi.
	// Normalize the completed subagent result through Pi's supported hook so the
	// model keeps the structured receipt while failures are still real tool errors.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "subagent" || !hasFailedSubagentResult(event.details)) return;
		return { isError: true };
	});

	// Disposable child frames must preserve the inherited branch exactly. Pi's
	// automatic pre-prompt compaction would replace that prefix and defeat KV
	// restoration, so child compaction is always cancelled.
	pi.on("session_before_compact", async () => {
		if (frame.role !== "main") return { cancel: true };
	});

	// Enforce the per-child turn budget inside the child Pi process, before the
	// next provider call. The parent runner also retains a defensive event limit.
	pi.on("turn_start", async (event, ctx) => {
		const containmentFailure = containmentSetupFailure ?? containedBash?.getFailure() ?? null;
		if (cacheInvariantFailure || containmentFailure) {
			if (containmentFailure && !containmentFailureReported) {
				containmentFailureReported = true;
				process.stderr.write(`[pi-subagent] ${containmentFailure}\n`);
			}
			ctx.abort();
			return;
		}
		if (frame.role === "main" || frame.maxTurns === null) return;
		turnsStarted++;
		if (turnsStarted <= frame.maxTurns) return;
		const markerPath = process.env[MAX_TURNS_PATH_ENV];
		if (markerPath) {
			try {
					fs.writeFileSync(markerPath, `${JSON.stringify({ runId: frame.runId, turnIndex: event.turnIndex, turnsStarted })}\n`, {
					encoding: "utf8",
					mode: 0o600,
					flag: "wx",
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		ctx.abort();
	});

	// Tool order is deliberately unconditional and identical at every depth.
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate one focused task to a serial child Pi process with the complete current session context.",
			"Depth is host-controlled: main → manager → worker by default.",
			"The main agent may set role to worker for a terminal depth-1 child.",
			"This must be the sole tool call in its assistant message. Different working directories are rejected to preserve the provider prefix.",
		].join("\n"),
		parameters: SubagentParams,
		executionMode: "sequential" as const,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (loaded.configurationError) throw new Error(`Cannot delegate: ${loaded.configurationError}`);
			if (receiptSubmitted) throw new Error("This child already submitted its final result and may not delegate again.");
			if (!mayDelegate(frame, loaded.configurationError)) {
				throw new Error(`Agent ${frame.name} (${frame.role}) at depth ${frame.depth}/${frame.maxDepth} may not delegate.`);
			}
			if (activeChild) {
				throw new Error(`A direct child (${activeChild.name}) is already active in this frame.`);
			}
			const branch = ctx.sessionManager.getBranch();
			const batchError = validateSoleToolCall(branch, toolCallId, "subagent");
			if (batchError) throw new Error(batchError);
			if (params.cwd && !isSameWorkingDirectory(params.cwd, ctx.cwd)) {
				throw new Error("A different cwd would change Pi's system prompt and is disabled in cache-stable mode.");
			}
			const runtime = getRuntimeSelection(pi, ctx);
			const missingTools = getMissingRequiredSubagentTools(runtime.tools);
			if (missingTools.length > 0) {
				throw new Error(
					`Cannot preserve the nested protocol because these tools are inactive: ${missingTools.join(", ")}. ` +
					"Enable subagent, agent_status, and submit_result before delegating.",
				);
			}
			if (!currentSystemPromptHash || !runtime.model || !runtime.thinking) {
				throw new Error("Cannot establish the current system-prompt/model/thinking cache invariant.");
			}
			const cacheInvariant: CacheInvariantV1 = {
				kind: "pi-subagent-cache-invariant",
				protocolVersion: 1,
				contextSha256: sha256(buildSessionContext(ctx.sessionManager.getBranch()).messages),
				systemPromptSha256: currentSystemPromptHash,
				toolsSha256: getToolSchemaHash(pi),
				model: runtime.model,
				thinking: runtime.thinking,
			};

			if (!ledgerPath) ledgerPath = createRunLedger(frame.rootRunId);
			const now = Date.now();
			const requestedDeadline = now + (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
			const inheritedDeadline = frame.deadlineAtMs === null
				? requestedDeadline
				: Math.min(requestedDeadline, frame.deadlineAtMs - 1_000);
			if (inheritedDeadline <= now) throw new Error("Not enough time remains in the parent deadline to start a child.");

			const taskId = makeTaskId(params.name, params.taskId, toolCallId);
			const parentWithLedger = { ...frame, ledgerPath };
			const childFrame = createChildFrame(parentWithLedger, {
				name: params.name.trim(),
				taskId,
				role: params.role,
				deadlineAtMs: inheritedDeadline,
				maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
				ledgerPath,
			});
			const taskSpec = createTaskSpec({
				name: childFrame.name,
				taskId,
				task: params.task,
				scope: params.scope,
				nonGoals: params.nonGoals,
				acceptance: params.acceptance,
				verification: params.verification,
			});
			const snapshot = buildForkSessionSnapshotJsonl(ctx.sessionManager);
			if (!snapshot) throw new Error("Failed to snapshot the current Pi session context.");

			activeChild = childFrame;
			try {
				const result = await runAgent({
					cwd: ctx.cwd,
					agentName: childFrame.name,
					taskSpec,
					frame: childFrame,
					forkSessionSnapshotJsonl: snapshot,
					signal,
					onUpdate,
					makeDetails: (results) => ({ results }),
					runtime,
					cacheInvariant,
					requireReceipt: true,
				});

				const text = isResultSuccess(result) && result.receipt && ledgerPath
					? formatReceiptForParent(result.receipt, ledgerPath)
					: compactFallback(formatFailureForParent(result));
				const storedResult = compactResultForSession(result);
				return {
					content: [{ type: "text" as const, text }],
					details: { results: [storedResult] },
				};
			} finally {
				activeChild = null;
			}
		},

		renderCall: (args, theme, context) => renderCall(args, context.expanded, theme, {
			depth: frame.depth + 1,
			role: args.role === "worker" || frame.depth + 1 >= frame.maxDepth ? "worker" : "manager",
		}),
		renderResult: (result, { expanded }, theme) => renderResult(result, expanded, theme),
	});

	pi.registerTool({
		name: "agent_status",
		label: "Agent Status",
		description: "Return authoritative host-owned identity, depth, deadline, and delegation state for this Pi process.",
		parameters: AgentStatusParams,
		executionMode: "sequential" as const,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const remainingMs = frame.deadlineAtMs === null ? null : Math.max(0, frame.deadlineAtMs - Date.now());
			const status = {
				kind: "pi-subagent-status",
				protocolVersion: 1,
				role: frame.role,
				name: frame.name,
				taskId: frame.taskId,
				rootRunId: frame.rootRunId,
				runId: frame.runId,
				parentRunId: frame.parentRunId,
				depth: frame.depth,
				maxDepth: frame.maxDepth,
				mayDelegate: mayDelegate(frame, loaded.configurationError) && !receiptSubmitted,
				stack: frame.stack,
				cwd: ctx.cwd,
				deadlineAtMs: frame.deadlineAtMs,
				remainingMs,
				maxTurns: frame.maxTurns,
				activeChild: activeChild
					? { runId: activeChild.runId, name: activeChild.name, taskId: activeChild.taskId }
					: null,
				ledgerPath,
				configurationError: loaded.configurationError,
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(status) }],
				details: status,
			};
		},
	});

	pi.registerTool({
		name: "submit_result",
		label: "Submit Result",
		description: "Submit the final bounded task receipt. Child managers and workers must call this exactly once as their sole final tool call.",
		parameters: SubmitResultParams,
		executionMode: "sequential" as const,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (frame.role === "main") throw new Error("The main agent does not submit a child-task receipt.");
			if (loaded.configurationError) throw new Error(`Cannot submit a receipt: ${loaded.configurationError}`);
			if (receiptSubmitted) throw new Error("submit_result has already been called for this frame.");
			if (activeChild) throw new Error("A manager cannot submit its result while a direct child is still active.");
			const batchError = validateSoleToolCall(ctx.sessionManager.getBranch(), toolCallId, "submit_result");
			if (batchError) throw new Error(batchError);
			assertReceiptStatus(params.status);
			for (const check of params.checks ?? []) assertCheckStatus(check.status);
			const receiptPath = process.env[RECEIPT_PATH_ENV];
			if (!receiptPath || !frame.ledgerPath) throw new Error("Host receipt state is missing for this child frame.");

			const receipt = createReceipt(frame, {
				status: params.status,
				summary: params.summary,
				changedFiles: params.changedFiles ?? [],
				checks: (params.checks ?? []).map((check) => ({
					id: check.id,
					status: check.status as CheckStatus,
					command: check.command,
					exitCode: check.exitCode,
					evidence: check.evidence,
				})),
				artifacts: params.artifacts ?? [],
				unresolved: params.unresolved ?? [],
			});
			appendLedgerRecord(frame.ledgerPath, receipt);
			writeReceipt(receiptPath, receipt);
			receiptSubmitted = true;
			return {
				content: [{ type: "text" as const, text: `PI_SUBAGENT_RECEIPT_V1\n${JSON.stringify(receipt)}` }],
				details: receipt,
				terminate: true,
			};
		},
	});
}
