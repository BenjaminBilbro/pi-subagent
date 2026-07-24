/**
 * Host-owned protocol for serial, depth-limited subagent frames.
 *
 * Dynamic role/task state lives in environment data and appended user messages.
 * Tool schemas and the system-prompt addition stay identical at every depth.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const FRAME_ENV = "PI_SUBAGENT_FRAME";
export const RECEIPT_PATH_ENV = "PI_SUBAGENT_RECEIPT_PATH";
export const MAX_TURNS_PATH_ENV = "PI_SUBAGENT_MAX_TURNS_PATH";
export const CACHE_INVARIANT_ENV = "PI_SUBAGENT_CACHE_INVARIANT";
export const CACHE_INVARIANT_ERROR_PATH_ENV = "PI_SUBAGENT_CACHE_INVARIANT_ERROR_PATH";
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
export const STACK_ENV = "PI_SUBAGENT_STACK";
export const PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";

export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_DEPTH = 2;
export const MAX_ALLOWED_DEPTH = 8;
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_MAX_TURNS = 50;
export const MAX_MAX_TURNS = 200;

export const MAX_NAME_CHARS = 80;
export const MAX_TASK_ID_CHARS = 120;
export const MAX_TASK_CHARS = 16 * 1024;
export const MAX_TASK_LIST_ITEMS = 12;
export const MAX_TASK_LIST_ITEM_CHARS = 1_024;
export const MAX_TASK_SPEC_BYTES = 20 * 1024;
export const MAX_SUMMARY_CHARS = 8_000;
export const MAX_RECEIPT_ITEMS = 24;
export const MAX_RECEIPT_ITEM_CHARS = 1_024;
export const MAX_RECEIPT_FILE_BYTES = 256 * 1024;
export const MAX_MODEL_RECEIPT_BYTES = 16 * 1024;
const MAX_PROCESS_REGISTRY_BYTES = 16 * 1024 * 1024;

export const REQUIRED_SUBAGENT_TOOL_NAMES = ["subagent", "agent_status", "submit_result"] as const;

export type AgentRole = "main" | "manager" | "worker";
export type ReceiptStatus = "completed" | "partial" | "blocked" | "failed";
export type CheckStatus = "passed" | "failed" | "skipped";

export interface AgentFrameV1 {
	kind: "pi-subagent-frame";
	protocolVersion: typeof PROTOCOL_VERSION;
	rootRunId: string;
	runId: string;
	parentRunId: string | null;
	role: AgentRole;
	name: string;
	taskId: string | null;
	depth: number;
	maxDepth: number;
	stack: string[];
	taskStack: string[];
	deadlineAtMs: number | null;
	maxTurns: number | null;
	ledgerPath: string | null;
	preventCycles: boolean;
}

export interface LoadedFrame {
	frame: AgentFrameV1;
	configurationError?: string;
}

export interface TaskSpecV1 {
	kind: "pi-subagent-task";
	protocolVersion: typeof PROTOCOL_VERSION;
	taskId: string;
	name: string;
	objective: string;
	scope: string[];
	nonGoals: string[];
	acceptance: string[];
	verification: string[];
}

export interface SubmittedCheck {
	id: string;
	status: CheckStatus;
	command?: string;
	exitCode?: number;
	evidence?: string;
}

export interface SubmitResultInput {
	status: ReceiptStatus;
	summary: string;
	changedFiles: string[];
	checks: SubmittedCheck[];
	artifacts: string[];
	unresolved: string[];
}

export interface TaskReceiptV1 {
	kind: "pi-subagent-receipt";
	protocolVersion: typeof PROTOCOL_VERSION;
	receiptId: string;
	rootRunId: string;
	runId: string;
	parentRunId: string;
	taskId: string;
	role: "manager" | "worker";
	name: string;
	submittedAtMs: number;
	status: ReceiptStatus;
	summary: string;
	changedFiles: string[];
	checks: Array<SubmittedCheck & { source: "agent-reported" }>;
	artifacts: string[];
	unresolved: string[];
}

export interface ChildFrameInput {
	name: string;
	taskId: string;
	role?: "worker";
	deadlineAtMs: number;
	maxTurns: number;
	ledgerPath: string;
}

export interface CacheInvariantV1 {
	kind: "pi-subagent-cache-invariant";
	protocolVersion: typeof PROTOCOL_VERSION;
	contextSha256: string;
	systemPromptSha256: string;
	toolsSha256: string;
	model: string;
	thinking: string;
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function parseConfiguredInteger(
	raw: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): { value: number; error?: string } {
	if (raw === undefined || raw.trim() === "") return { value: fallback };
	const value = Number(raw);
	if (!isIntegerInRange(value, minimum, maximum)) {
		return {
			value: minimum,
			error: `Expected an integer from ${minimum} to ${maximum}, received ${JSON.stringify(raw)}.`,
		};
	}
	return { value };
}

function parseConfiguredBoolean(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined || raw.trim() === "") return fallback;
	return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function normalizeFrameKey(value: string): string {
	return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

/** Reject sibling tool calls when Pi exposes the in-flight assistant entry. */
export function validateSoleToolCall(
	branch: unknown[],
	toolCallId: string,
	expectedName: string,
): string | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
		if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		const calls = entry.message.content.filter(
			(part): part is { type: "toolCall"; id?: string; name?: string } =>
				typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall",
		);
		if (!calls.some((call) => call.id === toolCallId)) continue;
		if (calls.length !== 1 || calls[0]?.name !== expectedName) {
			return `${expectedName} must be the only tool call in its assistant message.`;
		}
		return null;
	}
	return `Could not verify that ${expectedName} was the only tool call in its assistant message.`;
}

export function roleForDepth(depth: number, maxDepth: number): AgentRole {
	if (depth === 0) return "main";
	return depth >= maxDepth ? "worker" : "manager";
}

export function mayDelegate(frame: AgentFrameV1, configurationError?: string): boolean {
	return !configurationError && frame.role !== "worker" && frame.depth < frame.maxDepth;
}

export function getMissingRequiredSubagentTools(activeTools: readonly string[]): string[] {
	const active = new Set(activeTools);
	return REQUIRED_SUBAGENT_TOOL_NAMES.filter((name) => !active.has(name));
}

function newRootFrame(maxDepth: number, preventCycles: boolean): AgentFrameV1 {
	const runId = randomUUID();
	return {
		kind: "pi-subagent-frame",
		protocolVersion: PROTOCOL_VERSION,
		rootRunId: runId,
		runId,
		parentRunId: null,
		role: "main",
		name: "main",
		taskId: null,
		depth: 0,
		maxDepth,
		stack: [],
		taskStack: [],
		deadlineAtMs: null,
		maxTurns: null,
		ledgerPath: null,
		preventCycles,
	};
}

function failClosedFrame(message: string): LoadedFrame {
	const runId = randomUUID();
	return {
		configurationError: message,
		frame: {
			kind: "pi-subagent-frame",
			protocolVersion: PROTOCOL_VERSION,
			rootRunId: runId,
			runId,
			parentRunId: null,
			role: "worker",
			name: "invalid-frame",
			taskId: null,
			depth: 0,
			maxDepth: 0,
			stack: [],
			taskStack: [],
			deadlineAtMs: null,
			maxTurns: null,
			ledgerPath: null,
			preventCycles: true,
		},
	};
}

/** Parse frame state once at extension startup. Malformed child state fails closed. */
export function loadFrame(env: NodeJS.ProcessEnv = process.env): LoadedFrame {
	if (!hasOwn(env, FRAME_ENV)) {
		const configuredDepth = parseConfiguredInteger(
			env[MAX_DEPTH_ENV],
			DEFAULT_MAX_DEPTH,
			0,
			MAX_ALLOWED_DEPTH,
		);
		const frame = newRootFrame(
			configuredDepth.value,
			parseConfiguredBoolean(env[PREVENT_CYCLES_ENV], true),
		);
		return configuredDepth.error
			? { frame: { ...frame, maxDepth: 0 }, configurationError: `${MAX_DEPTH_ENV}: ${configuredDepth.error}` }
			: { frame };
	}

	const raw = env[FRAME_ENV];
	if (!raw) return failClosedFrame(`${FRAME_ENV} was present but empty.`);

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return failClosedFrame(`${FRAME_ENV} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) return failClosedFrame(`${FRAME_ENV} must contain an object.`);
	if (value.kind !== "pi-subagent-frame" || value.protocolVersion !== PROTOCOL_VERSION) {
		return failClosedFrame(`${FRAME_ENV} must use pi-subagent frame protocol v${PROTOCOL_VERSION}.`);
	}

	const depth = value.depth;
	const maxDepth = value.maxDepth;
	if (!isIntegerInRange(depth, 1, MAX_ALLOWED_DEPTH)) {
		return failClosedFrame(`${FRAME_ENV}.depth must be an integer from 1 to ${MAX_ALLOWED_DEPTH}.`);
	}
	if (!isIntegerInRange(maxDepth, 1, MAX_ALLOWED_DEPTH) || depth > maxDepth) {
		return failClosedFrame(`${FRAME_ENV}.maxDepth must be at least depth and no greater than ${MAX_ALLOWED_DEPTH}.`);
	}

	const requiredStrings = ["rootRunId", "runId", "parentRunId", "name", "taskId"] as const;
	for (const key of requiredStrings) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			return failClosedFrame(`${FRAME_ENV}.${key} must be a non-empty string.`);
		}
	}
	if (!Array.isArray(value.stack) || !value.stack.every((item) => typeof item === "string")) {
		return failClosedFrame(`${FRAME_ENV}.stack must be an array of strings.`);
	}
	if (!Array.isArray(value.taskStack) || !value.taskStack.every((item) => typeof item === "string")) {
		return failClosedFrame(`${FRAME_ENV}.taskStack must be an array of strings.`);
	}
	if (value.stack.length !== depth || value.taskStack.length !== depth) {
		return failClosedFrame(`${FRAME_ENV} stack lengths must equal depth.`);
	}
	if (typeof value.ledgerPath !== "string" || value.ledgerPath.length === 0) {
		return failClosedFrame(`${FRAME_ENV}.ledgerPath must be a non-empty string for child frames.`);
	}
	if (typeof value.preventCycles !== "boolean") {
		return failClosedFrame(`${FRAME_ENV}.preventCycles must be a boolean.`);
	}
	if (value.deadlineAtMs !== null && !isIntegerInRange(value.deadlineAtMs, 1, Number.MAX_SAFE_INTEGER)) {
		return failClosedFrame(`${FRAME_ENV}.deadlineAtMs must be a positive integer.`);
	}
	if (value.maxTurns !== null && !isIntegerInRange(value.maxTurns, 1, MAX_MAX_TURNS)) {
		return failClosedFrame(`${FRAME_ENV}.maxTurns must be from 1 to ${MAX_MAX_TURNS}.`);
	}
	if (value.deadlineAtMs === null || value.maxTurns === null) {
		return failClosedFrame(`${FRAME_ENV} child frames require finite deadlineAtMs and maxTurns values.`);
	}
	if (normalizeFrameKey(value.stack.at(-1) as string) !== normalizeFrameKey(value.name as string)) {
		return failClosedFrame(`${FRAME_ENV}.stack must end with the child name.`);
	}
	if (normalizeFrameKey(value.taskStack.at(-1) as string) !== normalizeFrameKey(value.taskId as string)) {
		return failClosedFrame(`${FRAME_ENV}.taskStack must end with the child taskId.`);
	}
	if (!path.isAbsolute(value.ledgerPath)) {
		return failClosedFrame(`${FRAME_ENV}.ledgerPath must be absolute.`);
	}

	const expectedRole = roleForDepth(depth, maxDepth);
	if (value.role !== expectedRole) {
		return failClosedFrame(`${FRAME_ENV}.role ${JSON.stringify(value.role)} is inconsistent with depth ${depth}/${maxDepth}.`);
	}

	return {
		frame: {
			kind: "pi-subagent-frame",
			protocolVersion: PROTOCOL_VERSION,
			rootRunId: value.rootRunId as string,
			runId: value.runId as string,
			parentRunId: value.parentRunId as string,
			role: expectedRole,
			name: value.name as string,
			taskId: value.taskId as string,
			depth,
			maxDepth,
			stack: [...value.stack] as string[],
			taskStack: [...value.taskStack] as string[],
			deadlineAtMs: value.deadlineAtMs as number | null,
			maxTurns: value.maxTurns as number | null,
			ledgerPath: value.ledgerPath as string,
			preventCycles: value.preventCycles,
		},
	};
}

export function createRunLedger(rootRunId: string, baseDirectory = os.tmpdir()): string {
	const runDirectory = fs.mkdtempSync(path.join(baseDirectory, `pi-subagent-${rootRunId.slice(0, 8)}-`));
	fs.chmodSync(runDirectory, 0o700);
	const ledgerPath = path.join(runDirectory, "ledger.jsonl");
	fs.writeFileSync(
		ledgerPath,
		`${JSON.stringify({ kind: "pi-subagent-ledger", protocolVersion: PROTOCOL_VERSION, rootRunId, createdAtMs: Date.now() })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	fs.writeFileSync(
		getProcessRegistryPath(ledgerPath),
		`${JSON.stringify({ kind: "pi-subagent-process-registry", protocolVersion: PROTOCOL_VERSION, rootRunId, createdAtMs: Date.now() })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	return ledgerPath;
}

export function appendLedgerRecord(ledgerPath: string, record: unknown): void {
	const line = `${JSON.stringify(record)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_RECEIPT_FILE_BYTES) {
		throw new Error("Refusing to append an oversized subagent ledger record.");
	}
	fs.appendFileSync(ledgerPath, line, { encoding: "utf8", mode: 0o600 });
}

function getProcessRegistryPath(ledgerPath: string): string {
	return path.join(path.dirname(ledgerPath), "processes.jsonl");
}

export interface ProcessRegistryRecord {
	kind: "pi-subagent-process";
	protocolVersion: typeof PROTOCOL_VERSION;
	event: "started" | "stopped";
	rootRunId: string;
	runId: string;
	parentRunId: string;
	pid: number;
	timestampMs: number;
}

export function appendProcessRegistryRecord(
	ledgerPath: string,
	record: Omit<ProcessRegistryRecord, "kind" | "protocolVersion" | "timestampMs">,
): void {
	const registryPath = getProcessRegistryPath(ledgerPath);
	fs.appendFileSync(
		registryPath,
		`${JSON.stringify({
			kind: "pi-subagent-process",
			protocolVersion: PROTOCOL_VERSION,
			...record,
			timestampMs: Date.now(),
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

/**
 * Return audit-only active Pi process IDs in a frame subtree. Callers must not
 * treat registry records as signal authority; only spawn-owned PIDs and fresh
 * operating-system ancestry are trusted for process cleanup.
 */
export function readActiveProcessPids(
	ledgerPath: string,
	ancestorRunId: string,
	expectedRootRunId: string,
): number[] {
	const registryPath = getProcessRegistryPath(ledgerPath);
	if (!fs.existsSync(registryPath)) return [];
	const stat = fs.statSync(registryPath);
	if (stat.size > MAX_PROCESS_REGISTRY_BYTES) {
		throw new Error("Subagent process registry exceeded its host byte limit.");
	}

	const latest = new Map<string, ProcessRegistryRecord>();
	for (const line of fs.readFileSync(registryPath, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(value) || value.kind !== "pi-subagent-process") continue;
		if (value.event !== "started" && value.event !== "stopped") continue;
		if (
			value.rootRunId !== expectedRootRunId ||
			typeof value.runId !== "string" || value.runId.length === 0 ||
			typeof value.parentRunId !== "string" || value.parentRunId.length === 0 ||
			!Number.isInteger(value.pid) ||
			Number(value.pid) <= 1 ||
			!Number.isInteger(value.timestampMs)
		) continue;
		latest.set(value.runId, value as unknown as ProcessRegistryRecord);
	}

	const subtree = new Set<string>([ancestorRunId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of latest.values()) {
			if (!subtree.has(record.runId) && subtree.has(record.parentRunId)) {
				subtree.add(record.runId);
				changed = true;
			}
		}
	}

	return [...latest.values()]
		.filter((record) => subtree.has(record.runId) && record.event === "started")
		.map((record) => record.pid);
}

export function createChildFrame(parent: AgentFrameV1, input: ChildFrameInput): AgentFrameV1 {
	if (!mayDelegate(parent)) throw new Error(`Agent role ${parent.role} at depth ${parent.depth}/${parent.maxDepth} may not delegate.`);
	if (input.role === "worker" && parent.role !== "main") {
		throw new Error("Only the main agent may request a direct worker.");
	}
	const nameKey = normalizeFrameKey(input.name);
	const taskKey = normalizeFrameKey(input.taskId);
	if (!nameKey) throw new Error("Subagent name may not be empty.");
	if (!taskKey) throw new Error("Subagent taskId may not be empty.");
	if (parent.preventCycles && parent.stack.some((item) => normalizeFrameKey(item) === nameKey)) {
		throw new Error(`Delegation cycle rejected: agent name ${JSON.stringify(input.name)} is already in this frame stack.`);
	}
	if (parent.preventCycles && parent.taskStack.some((item) => normalizeFrameKey(item) === taskKey)) {
		throw new Error(`Delegation cycle rejected: taskId ${JSON.stringify(input.taskId)} is already in this frame stack.`);
	}

	const depth = parent.depth + 1;
	const maxDepth = input.role === "worker" ? depth : parent.maxDepth;
	return {
		kind: "pi-subagent-frame",
		protocolVersion: PROTOCOL_VERSION,
		rootRunId: parent.rootRunId,
		runId: randomUUID(),
		parentRunId: parent.runId,
		role: roleForDepth(depth, maxDepth),
		name: input.name,
		taskId: input.taskId,
		depth,
		maxDepth,
		stack: [...parent.stack, input.name],
		taskStack: [...parent.taskStack, input.taskId],
		deadlineAtMs: input.deadlineAtMs,
		maxTurns: input.maxTurns,
		ledgerPath: input.ledgerPath,
		preventCycles: parent.preventCycles,
	};
}

export function createTaskSpec(input: {
	name: string;
	taskId: string;
	task: string;
	scope?: string[];
	nonGoals?: string[];
	acceptance?: string[];
	verification?: string[];
}): TaskSpecV1 {
	const task: TaskSpecV1 = {
		kind: "pi-subagent-task",
		protocolVersion: PROTOCOL_VERSION,
		taskId: input.taskId,
		name: input.name,
		objective: input.task,
		scope: input.scope ?? [],
		nonGoals: input.nonGoals ?? [],
		acceptance: input.acceptance ?? [],
		verification: input.verification ?? [],
	};
	if (Buffer.byteLength(JSON.stringify(task), "utf8") > MAX_TASK_SPEC_BYTES) {
		throw new Error(`Subagent task contract exceeded ${MAX_TASK_SPEC_BYTES} UTF-8 bytes.`);
	}
	return task;
}

export function buildTaskMessage(frame: AgentFrameV1, task: TaskSpecV1): string {
	const publicFrame = {
		kind: frame.kind,
		protocolVersion: frame.protocolVersion,
		runId: frame.runId,
		parentRunId: frame.parentRunId,
		role: frame.role,
		name: frame.name,
		taskId: frame.taskId,
		depth: frame.depth,
		maxDepth: frame.maxDepth,
		mayDelegate: mayDelegate(frame),
		deadlineAtMs: frame.deadlineAtMs,
		maxTurns: frame.maxTurns,
	};
	return [
		"[PI_SUBAGENT_RUN_FRAME_V1]",
		JSON.stringify(publicFrame),
		"[/PI_SUBAGENT_RUN_FRAME_V1]",
		"",
		"[PI_SUBAGENT_TASK_SPEC_V1]",
		JSON.stringify(task),
		"[/PI_SUBAGENT_TASK_SPEC_V1]",
		"",
		"Call agent_status before starting. Complete only this task. End by calling submit_result exactly once as the only tool call in your final assistant message.",
	].join("\n");
}

function stringsAreBounded(values: string[], maximumItems: number, maximumChars: number): boolean {
	return values.length <= maximumItems && values.every((value) => value.length <= maximumChars);
}

export function getReceiptConsistencyError(input: SubmitResultInput): string | null {
	if (input.summary.length === 0 || input.summary.length > MAX_SUMMARY_CHARS) {
		return `Receipt summary must contain 1 to ${MAX_SUMMARY_CHARS} characters.`;
	}
	for (const [label, values] of [
		["changedFiles", input.changedFiles],
		["artifacts", input.artifacts],
		["unresolved", input.unresolved],
	] as const) {
		if (!stringsAreBounded(values, MAX_RECEIPT_ITEMS, MAX_RECEIPT_ITEM_CHARS)) {
			return `Receipt ${label} exceeded its item or character limit.`;
		}
	}
	if (input.checks.length > MAX_RECEIPT_ITEMS) return "Receipt checks exceeded the item limit.";
	for (const check of input.checks) {
		if (!check.id || check.id.length > MAX_RECEIPT_ITEM_CHARS) return "Receipt check id is missing or too long.";
		if (check.command !== undefined && check.command.length > MAX_RECEIPT_ITEM_CHARS) return "Receipt check command is too long.";
		if (check.evidence !== undefined && check.evidence.length > MAX_RECEIPT_ITEM_CHARS) return "Receipt check evidence is too long.";
		if (check.exitCode !== undefined && !Number.isInteger(check.exitCode)) return "Receipt check exitCode must be an integer.";
		if (check.status === "passed" && check.exitCode !== undefined && check.exitCode !== 0) {
			return `Receipt check ${JSON.stringify(check.id)} cannot pass with a nonzero exit code.`;
		}
		if (check.status === "failed" && check.exitCode === 0) {
			return `Receipt check ${JSON.stringify(check.id)} cannot fail with exit code 0.`;
		}
		if (check.status === "skipped" && check.exitCode !== undefined) {
			return `Receipt check ${JSON.stringify(check.id)} cannot be skipped with an exit code.`;
		}
	}
	if (input.status === "completed" && input.checks.some((check) => check.status === "failed")) {
		return "A completed receipt cannot contain a failed check.";
	}
	if (input.status === "completed" && input.unresolved.length > 0) {
		return "A completed receipt cannot contain unresolved issues; use partial or blocked.";
	}
	return null;
}

export function createReceipt(frame: AgentFrameV1, input: SubmitResultInput): TaskReceiptV1 {
	if (frame.role === "main" || !frame.parentRunId || !frame.taskId) {
		throw new Error("The main agent cannot submit a child-task receipt.");
	}
	const consistencyError = getReceiptConsistencyError(input);
	if (consistencyError) throw new Error(consistencyError);
	return {
		kind: "pi-subagent-receipt",
		protocolVersion: PROTOCOL_VERSION,
		receiptId: randomUUID(),
		rootRunId: frame.rootRunId,
		runId: frame.runId,
		parentRunId: frame.parentRunId,
		taskId: frame.taskId,
		role: frame.role,
		name: frame.name,
		submittedAtMs: Date.now(),
		status: input.status,
		summary: input.summary,
		changedFiles: [...input.changedFiles],
		checks: input.checks.map((check) => ({ ...check, source: "agent-reported" as const })),
		artifacts: [...input.artifacts],
		unresolved: [...input.unresolved],
	};
}

export function writeReceipt(receiptPath: string, receipt: TaskReceiptV1): void {
	const serialized = `${JSON.stringify(receipt)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_FILE_BYTES) {
		throw new Error("Structured subagent receipt exceeded the host byte limit.");
	}
	const fd = fs.openSync(receiptPath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, serialized, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
	return value === "completed" || value === "partial" || value === "blocked" || value === "failed";
}

function isCheckStatus(value: unknown): value is CheckStatus {
	return value === "passed" || value === "failed" || value === "skipped";
}

function validateReceipt(value: unknown): value is TaskReceiptV1 {
	if (!isRecord(value)) return false;
	if (value.kind !== "pi-subagent-receipt" || value.protocolVersion !== PROTOCOL_VERSION) return false;
	for (const key of ["receiptId", "rootRunId", "runId", "parentRunId", "taskId", "name", "summary"] as const) {
		if (typeof value[key] !== "string") return false;
	}
	if (value.role !== "manager" && value.role !== "worker") return false;
	if (!isReceiptStatus(value.status)) return false;
	if (!Number.isInteger(value.submittedAtMs)) return false;
	if (!Array.isArray(value.changedFiles) || !value.changedFiles.every((item) => typeof item === "string")) return false;
	if (!Array.isArray(value.artifacts) || !value.artifacts.every((item) => typeof item === "string")) return false;
	if (!Array.isArray(value.unresolved) || !value.unresolved.every((item) => typeof item === "string")) return false;
	if (!Array.isArray(value.checks)) return false;
	for (const check of value.checks) {
		if (!isRecord(check) || typeof check.id !== "string" || !isCheckStatus(check.status) || check.source !== "agent-reported") return false;
		if (check.command !== undefined && typeof check.command !== "string") return false;
		if (check.exitCode !== undefined && !Number.isInteger(check.exitCode)) return false;
		if (check.evidence !== undefined && typeof check.evidence !== "string") return false;
	}
	return getReceiptConsistencyError(value as unknown as SubmitResultInput) === null;
}

export function parseReceiptValue(value: unknown, expectedFrame: AgentFrameV1): TaskReceiptV1 {
	if (!validateReceipt(value)) throw new Error("Structured subagent receipt did not match protocol v1.");
	if (
		value.rootRunId !== expectedFrame.rootRunId ||
		value.runId !== expectedFrame.runId ||
		value.parentRunId !== expectedFrame.parentRunId ||
		value.taskId !== expectedFrame.taskId ||
		value.role !== expectedFrame.role ||
		value.name !== expectedFrame.name
	) {
		throw new Error("Structured subagent receipt identity did not match its host-owned frame.");
	}
	return value;
}

export function readReceipt(receiptPath: string, expectedFrame: AgentFrameV1): TaskReceiptV1 | null {
	if (!fs.existsSync(receiptPath)) return null;
	const stat = fs.statSync(receiptPath);
	if (stat.size > MAX_RECEIPT_FILE_BYTES) throw new Error("Structured subagent receipt file exceeded the host byte limit.");
	return parseReceiptValue(JSON.parse(fs.readFileSync(receiptPath, "utf8")), expectedFrame);
}

export function buildChildEnvironment(
	frame: AgentFrameV1,
	receiptPath: string,
	maxTurnsPath: string,
	cacheInvariant?: CacheInvariantV1,
	cacheInvariantErrorPath?: string,
): NodeJS.ProcessEnv {
	return {
		[FRAME_ENV]: JSON.stringify(frame),
		[RECEIPT_PATH_ENV]: receiptPath,
		[MAX_TURNS_PATH_ENV]: maxTurnsPath,
		[DEPTH_ENV]: String(frame.depth),
		[MAX_DEPTH_ENV]: String(frame.maxDepth),
		[STACK_ENV]: JSON.stringify(frame.stack),
		[PREVENT_CYCLES_ENV]: frame.preventCycles ? "1" : "0",
		...(cacheInvariant ? { [CACHE_INVARIANT_ENV]: JSON.stringify(cacheInvariant) } : {}),
		...(cacheInvariantErrorPath ? { [CACHE_INVARIANT_ERROR_PATH_ENV]: cacheInvariantErrorPath } : {}),
	};
}

function truncateUtf8(value: string, maximumBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	return new StringDecoder("utf8").write(bytes.subarray(0, maximumBytes));
}

function compactReceiptProjection(receipt: TaskReceiptV1, ledgerPath: string, itemLimit: number, summaryBytes: number) {
	const compactItems = (items: string[]) => items.slice(0, itemLimit).map((item) => truncateUtf8(item, 256));
	return {
		kind: "pi-subagent-parent-result",
		protocolVersion: PROTOCOL_VERSION,
		receiptId: receipt.receiptId,
		taskId: receipt.taskId,
		name: receipt.name,
		role: receipt.role,
		status: receipt.status,
		summary: truncateUtf8(receipt.summary, summaryBytes),
		changedFiles: compactItems(receipt.changedFiles),
		checks: receipt.checks.slice(0, itemLimit).map((check) => ({
			id: truncateUtf8(check.id, 128),
			status: check.status,
			command: check.command === undefined ? undefined : truncateUtf8(check.command, 256),
			exitCode: check.exitCode,
			evidence: check.evidence === undefined ? undefined : truncateUtf8(check.evidence, 256),
		})),
		artifacts: compactItems(receipt.artifacts),
		unresolved: compactItems(receipt.unresolved),
		ledgerPath: truncateUtf8(ledgerPath, 1_024),
		truncated:
			Buffer.byteLength(receipt.summary, "utf8") > summaryBytes ||
			[receipt.changedFiles, receipt.checks, receipt.artifacts, receipt.unresolved]
				.some((items) => items.length > itemLimit),
	};
}

export function formatReceiptForParent(receipt: TaskReceiptV1, ledgerPath: string): string {
	let projection = compactReceiptProjection(receipt, ledgerPath, 8, 4_096);
	let text = `PI_SUBAGENT_RECEIPT_V1\n${JSON.stringify(projection)}`;
	if (Buffer.byteLength(text, "utf8") <= MAX_MODEL_RECEIPT_BYTES) return text;
	projection = compactReceiptProjection(receipt, ledgerPath, 4, 2_048);
	text = `PI_SUBAGENT_RECEIPT_V1\n${JSON.stringify(projection)}`;
	if (Buffer.byteLength(text, "utf8") <= MAX_MODEL_RECEIPT_BYTES) return text;
	const minimal = {
		kind: "pi-subagent-parent-result",
		protocolVersion: PROTOCOL_VERSION,
		receiptId: receipt.receiptId,
		taskId: receipt.taskId,
		status: receipt.status,
		summary: truncateUtf8(receipt.summary, 2_048),
		ledgerPath: truncateUtf8(ledgerPath, 1_024),
		truncated: true,
	};
	return `PI_SUBAGENT_RECEIPT_V1\n${JSON.stringify(minimal)}`;
}
