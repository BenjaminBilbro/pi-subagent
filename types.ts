/** Shared result types and normalization for one serial subagent invocation. */

import type { Message } from "@earendil-works/pi-ai";
import { getFinalAssistantText, hasAttributedToolError } from "./runner-events.js";
import type { AgentFrameV1, TaskReceiptV1, TaskSpecV1 } from "./protocol.js";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	task: string;
	taskSpec?: TaskSpecV1;
	frame?: AgentFrameV1;
	exitCode: number;
	exitSignal?: NodeJS.Signals;
	messages: Message[];
	stderr: string;
	stderrTruncated?: boolean;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentStart?: boolean;
	sawAgentEnd?: boolean;
	sawAgentSettled?: boolean;
	pendingToolError?: string;
	captureTruncated?: boolean;
	processError?: boolean;
	timeout?: boolean;
	maxTurnsLimit?: number;
	maxTurnsExceeded?: boolean;
	receiptRequired?: boolean;
	receipt?: TaskReceiptV1;
	receiptTruncated?: boolean;
	submittedReceiptEvent?: { toolCallId: string; details: unknown };
	submitResultToolCallIds?: string[];
	ledgerPath?: string;
	startedAtMs?: number;
	finishedAtMs?: number;
}

export interface SubagentDetails {
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
}

export function hasFinalAssistantOutput(result: Pick<SingleResult, "messages">): boolean {
	return getFinalAssistantText(result.messages).trim().length > 0;
}

export function hasSemanticCompletion(
	result: Pick<
		SingleResult,
		"messages" | "sawAgentEnd" | "sawAgentSettled" | "stopReason" | "pendingToolError" | "receipt" | "receiptRequired"
	>,
): boolean {
	if (result.receipt) return result.sawAgentSettled === true;
	if (result.receiptRequired) return false;
	if (!result.sawAgentEnd || !result.sawAgentSettled || !hasFinalAssistantOutput(result)) return false;
	if (result.stopReason === "aborted") return false;
	if (result.stopReason === "error") return hasAttributedToolError(result);
	return true;
}

export function isResultSuccess(result: SingleResult): boolean {
	if (result.exitCode !== 0 || result.processError || result.timeout || result.maxTurnsExceeded) return false;
	if (result.stopReason === "timeout" || result.stopReason === "max_turns" || result.stopReason === "aborted") return false;
	if (result.receipt && result.receipt.status !== "completed") return false;
	if (result.receipt?.status === "completed" && (
		result.receipt.unresolved.length > 0 || result.receipt.checks.some((check) => check.status === "failed")
	)) return false;
	return hasSemanticCompletion(result);
}

export function isResultError(result: SingleResult): boolean {
	if (result.exitCode === -1) return false;
	return !isResultSuccess(result);
}

function truncateText(value: string | undefined, maximumChars: number): string | undefined {
	if (value === undefined || value.length <= maximumChars) return value;
	return `${value.slice(0, maximumChars)}\n[truncated]`;
}

/** Keep persisted parent tool details small; the ledger retains the full receipt. */
export function compactResultForSession(result: SingleResult): SingleResult {
	const receipt = result.receipt
		? {
			...result.receipt,
			summary: truncateText(result.receipt.summary, 4_000) ?? "",
			changedFiles: result.receipt.changedFiles.slice(0, 8),
			checks: result.receipt.checks.slice(0, 8),
			artifacts: result.receipt.artifacts.slice(0, 8),
			unresolved: result.receipt.unresolved.slice(0, 8),
		}
		: undefined;
	const receiptTruncated = Boolean(result.receipt && receipt && (
		result.receipt.summary !== receipt.summary ||
		result.receipt.changedFiles.length !== receipt.changedFiles.length ||
		result.receipt.checks.length !== receipt.checks.length ||
		result.receipt.artifacts.length !== receipt.artifacts.length ||
		result.receipt.unresolved.length !== receipt.unresolved.length
	));
	return {
		agent: result.agent,
		task: truncateText(result.task, 4_000) ?? "",
		frame: result.frame,
		exitCode: result.exitCode,
		exitSignal: result.exitSignal,
		messages: [],
		stderr: truncateText(result.stderr, 8_000) ?? "",
		stderrTruncated: result.stderrTruncated || result.stderr.length > 8_000,
		usage: result.usage,
		model: result.model,
		stopReason: result.stopReason,
		errorMessage: truncateText(result.errorMessage, 4_000),
		sawAgentStart: result.sawAgentStart,
		sawAgentEnd: result.sawAgentEnd,
		sawAgentSettled: result.sawAgentSettled,
		captureTruncated: result.captureTruncated,
		processError: result.processError,
		timeout: result.timeout,
		maxTurnsLimit: result.maxTurnsLimit,
		maxTurnsExceeded: result.maxTurnsExceeded,
		receiptRequired: result.receiptRequired,
		receipt,
		receiptTruncated,
		ledgerPath: result.ledgerPath,
		startedAtMs: result.startedAtMs,
		finishedAtMs: result.finishedAtMs,
	};
}

function ensureFailureText(result: SingleResult, fallback: string): void {
	if (!result.errorMessage) result.errorMessage = fallback;
	if (!result.stderr.trim()) result.stderr = result.errorMessage;
}

/** Reconcile process exit status with the protocol-level completion state. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const semanticSuccess = hasSemanticCompletion(result);

	if (result.timeout) {
		result.exitCode = 124;
		result.stopReason = "timeout";
		ensureFailureText(result, "Subagent exceeded its deadline.");
		return result;
	}

	if (result.maxTurnsExceeded) {
		result.exitCode = 1;
		result.stopReason = "max_turns";
		ensureFailureText(result, `Subagent exceeded maximum turns (${result.maxTurnsLimit ?? "unknown"}).`);
		return result;
	}

	if (wasAborted) {
		if (!result.processError) {
			result.exitCode = 130;
			result.stopReason = "aborted";
			ensureFailureText(result, "Subagent was aborted.");
		}
		return result;
	}

	if (result.processError) {
		if (result.exitCode <= 0) result.exitCode = 1;
		if (!new Set(["cache_invariant", "protocol_error", "output_limit"]).has(result.stopReason ?? "")) {
			result.stopReason = "error";
		}
		ensureFailureText(result, "Subagent process failed.");
		return result;
	}

	if (result.exitCode !== 0) {
		result.stopReason = "error";
		ensureFailureText(result, `Subagent process exited with code ${result.exitCode}.`);
		return result;
	}

	if (result.receipt) {
		if (
			result.receipt.status === "completed" &&
			(result.receipt.unresolved.length > 0 || result.receipt.checks.some((check) => check.status === "failed"))
		) {
			result.exitCode = 1;
			result.stopReason = "protocol_error";
			ensureFailureText(result, "Completed receipt contradicted its failed checks or unresolved issues.");
		} else if (!result.sawAgentSettled) {
			result.exitCode = 1;
			result.stopReason = "protocol_error";
			ensureFailureText(result, "Subagent submitted a receipt but exited before agent_settled.");
		} else if (result.receipt.status === "completed") {
			result.exitCode = 0;
			result.stopReason = undefined;
			result.errorMessage = undefined;
		} else {
			result.exitCode = 1;
			result.stopReason = `receipt_${result.receipt.status}`;
			ensureFailureText(result, result.receipt.summary);
		}
		return result;
	}

	if (result.receiptRequired) {
		if (result.exitCode === 0) result.exitCode = 1;
		result.stopReason = "missing_receipt";
		ensureFailureText(result, "Subagent exited without calling submit_result.");
		return result;
	}

	if (!semanticSuccess) {
		if (result.exitCode === 0) result.exitCode = 1;
		if (!result.stopReason) result.stopReason = "error";
		ensureFailureText(
			result,
			result.sawAgentEnd
				? "Subagent completed without final assistant output."
				: "Subagent exited without completing an agent run.",
		);
		return result;
	}

	result.exitCode = 0;
	if (result.stopReason === "error" && hasAttributedToolError(result)) result.stopReason = undefined;
	if (result.errorMessage === result.pendingToolError) result.errorMessage = undefined;
	return result;
}

export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") {
				items.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall") {
				items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}
