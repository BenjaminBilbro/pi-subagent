/** Rich, depth-aware TUI rendering for serial nested subagents. */

import * as os from "node:os";
import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getResultSummaryText } from "./runner-events.js";
import type { AgentRole, TaskReceiptV1 } from "./protocol.js";
import {
	type ActiveToolExecution,
	type DisplayItem,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	getDisplayItems,
	isResultError,
} from "./types.js";

const COLLAPSED_ACTION_COUNT = 4;
const COLLAPSED_SUMMARY_CHARS = 360;
const MAX_RENDER_NESTING = 12;
const DEPTH_COLORS: ThemeColor[] = ["accent", "warning", "success"];

type ThemeFg = (color: ThemeColor, text: string) => string;
type RenderTheme = Pick<Theme, "fg" | "bold">;

export interface SubagentCallIdentity {
	depth?: number;
	role?: AgentRole;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join("  ");
}

function formatDuration(startedAtMs?: number, finishedAtMs?: number): string {
	if (!startedAtMs) return "";
	const elapsedMs = Math.max(0, (finishedAtMs ?? Date.now()) - startedAtMs);
	if (elapsedMs < 1000) return `${elapsedMs}ms`;
	const seconds = elapsedMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, Math.max(0, maxLen - 1))}…` : text;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function prettyStructuredText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const newline = trimmed.indexOf("\n");
	const prefix = newline > 0 ? trimmed.slice(0, newline) : "";
	const candidate = newline > 0 ? trimmed.slice(newline + 1) : trimmed;
	if (!(candidate.startsWith("{") || candidate.startsWith("["))) return trimmed;
	try {
		const pretty = JSON.stringify(JSON.parse(candidate), null, 2);
		return prefix ? `${prefix}\n${pretty}` : pretty;
	} catch {
		return trimmed;
	}
}

function depthColor(depth: number): ThemeColor {
	return DEPTH_COLORS[Math.max(0, depth - 1) % DEPTH_COLORS.length] ?? "accent";
}

function depthForResult(result: SingleResult, fallback = 1): number {
	const value = result.frame?.depth;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(1, value) : fallback;
}

function roleForResult(result: SingleResult, depth: number): AgentRole {
	return result.frame?.role ?? (depth <= 1 ? "manager" : "worker");
}

function statusIcon(result: SingleResult, theme: Pick<Theme, "fg">): string {
	if (result.exitCode === -1) return theme.fg("warning", "◌");
	if (result.timeout) return theme.fg("error", "◷");
	if (result.maxTurnsExceeded) return theme.fg("error", "↻");
	return isResultError(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function formatToolCallSummary(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || args.name || "…") as string;
	switch (toolName) {
		case "bash":
			return fg("muted", "$ ") + fg("toolOutput", truncate(oneLine(String(args.command ?? "…")), 90));
		case "read":
			return fg("muted", "read ") + fg("accent", shortenPath(pathArg));
		case "write":
		case "edit":
			return fg("muted", `${toolName} `) + fg("accent", shortenPath(pathArg));
		case "subagent":
			return fg("accent", `spawn ${String(args.name ?? args.agent ?? "…")}`);
		case "submit_result":
			return fg("success", `submit ${String(args.status ?? "result")}`);
		default:
			return fg("accent", toolName);
	}
}

function asStringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getNestedResults(details: unknown): SingleResult[] {
	if (!details || typeof details !== "object") return [];
	const results = (details as Partial<SubagentDetails>).results;
	if (!Array.isArray(results)) return [];
	return results.filter(
		(result): result is SingleResult =>
			Boolean(result) && typeof result === "object" && typeof result.agent === "string" && Array.isArray(result.messages),
	);
}

function contentText(content: Array<{ type: string; text?: string; mimeType?: string }> | undefined): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			if (part?.type === "image") return `[image${part.mimeType ? `: ${part.mimeType}` : ""}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function executionResult(execution: ActiveToolExecution): { content?: unknown[]; details?: unknown } | undefined {
	return execution.result ?? execution.partialResult;
}

function getRunKey(result: SingleResult): string {
	return result.frame?.runId ?? `${result.agent}\u0000${result.task}\u0000${result.startedAtMs ?? ""}`;
}

function countNestedAgents(result: SingleResult, seen = new Set<string>()): number {
	const key = getRunKey(result);
	if (seen.has(key)) return 0;
	seen.add(key);
	let count = 0;
	for (const item of getDisplayItems(result.messages)) {
		if (item.type !== "toolResult" || item.name !== "subagent") continue;
		for (const child of getNestedResults(item.details)) {
			count += 1 + countNestedAgents(child, seen);
		}
	}
	for (const execution of result.activeToolExecutions ?? []) {
		if (execution.toolName !== "subagent") continue;
		for (const child of getNestedResults(executionResult(execution)?.details)) {
			count += 1 + countNestedAgents(child, seen);
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Shared visual building blocks
// ---------------------------------------------------------------------------

function addSectionLabel(
	container: Container,
	label: string,
	indent: number,
	color: ThemeColor,
	theme: RenderTheme,
	detail?: string,
): void {
	let text = theme.fg(color, "├─") + " " + theme.fg("toolTitle", theme.bold(label));
	if (detail) text += "  " + theme.fg("dim", detail);
	container.addChild(new Text(text, indent, 0));
}

function renderStringList(
	container: Container,
	label: string,
	items: string[],
	indent: number,
	color: ThemeColor,
	theme: RenderTheme,
): void {
	if (items.length === 0) return;
	addSectionLabel(container, label, indent, color, theme);
	for (const item of items) container.addChild(new Text(theme.fg("toolOutput", `• ${item}`), indent + 2, 0));
}

function renderTaskContract(
	container: Container,
	args: Record<string, unknown>,
	indent: number,
	color: ThemeColor,
	theme: RenderTheme,
): void {
	const objective = String(args.task ?? args.objective ?? "").trim();
	addSectionLabel(container, "task", indent, color, theme, typeof args.taskId === "string" ? args.taskId : undefined);
	if (objective) container.addChild(new Markdown(objective, indent + 2, 0, getMarkdownTheme()));
	else container.addChild(new Text(theme.fg("dim", "(waiting for task arguments…)"), indent + 2, 0));
	renderStringList(container, "scope", asStringList(args.scope), indent, color, theme);
	renderStringList(container, "non-goals", asStringList(args.nonGoals), indent, color, theme);
	renderStringList(container, "acceptance", asStringList(args.acceptance), indent, color, theme);
	renderStringList(container, "verification", asStringList(args.verification), indent, color, theme);
	const budgets: string[] = [];
	if (typeof args.timeout === "number") budgets.push(`${args.timeout}s timeout`);
	if (typeof args.maxTurns === "number") budgets.push(`${args.maxTurns} max turns`);
	if (typeof args.cwd === "string") budgets.push(shortenPath(args.cwd));
	if (budgets.length > 0) container.addChild(new Text(theme.fg("dim", budgets.join("  ·  ")), indent + 2, 0));
}

function renderReceipt(
	container: Container,
	receipt: TaskReceiptV1,
	indent: number,
	color: ThemeColor,
	theme: RenderTheme,
): void {
	addSectionLabel(container, "receipt", indent, color, theme, receipt.status);
	container.addChild(new Markdown(receipt.summary.trim(), indent + 2, 0, getMarkdownTheme()));
	if (receipt.changedFiles.length > 0) renderStringList(container, "changed files", receipt.changedFiles, indent + 1, color, theme);
	if (receipt.checks.length > 0) {
		addSectionLabel(container, "checks", indent + 1, color, theme);
		for (const check of receipt.checks) {
			const icon = check.status === "passed" ? "✓" : check.status === "failed" ? "✗" : "○";
			const checkColor: ThemeColor = check.status === "passed" ? "success" : check.status === "failed" ? "error" : "warning";
			let text = `${icon} ${check.id}`;
			if (check.command) text += `  ${check.command}`;
			if (check.exitCode !== undefined) text += `  (exit ${check.exitCode})`;
			if (check.evidence) text += `\n  ${check.evidence}`;
			container.addChild(new Text(theme.fg(checkColor, text), indent + 3, 0));
		}
	}
	if (receipt.artifacts.length > 0) renderStringList(container, "artifacts", receipt.artifacts, indent + 1, color, theme);
	if (receipt.unresolved.length > 0) renderStringList(container, "unresolved", receipt.unresolved, indent + 1, "error", theme);
}

// ---------------------------------------------------------------------------
// renderCall — always visible, and fully expanded by Ctrl+O
// ---------------------------------------------------------------------------

export function renderCall(
	args: Record<string, any>,
	expanded: boolean,
	theme: RenderTheme,
	identity: SubagentCallIdentity = {},
): Container | Text {
	const agentName = String(args.name ?? args.agent ?? "…");
	const depth = identity.depth ?? 1;
	const role = identity.role ?? (depth <= 1 ? "manager" : "worker");
	const color = depthColor(depth);
	const header =
		theme.fg(color, "◆") +
		" " +
		theme.fg("toolTitle", theme.bold("subagent")) +
		" " +
		theme.fg(color, agentName) +
		"  " +
		theme.fg("dim", `${role} · depth ${depth}`);

	if (!expanded) {
		const rawTask = typeof args.task === "string" ? args.task : "";
		const preview = rawTask ? truncate(oneLine(rawTask), 110) : "…";
		const hasMore = rawTask !== preview || /[\r\n]/.test(rawTask) ||
			["scope", "nonGoals", "acceptance", "verification"].some((key) => asStringList(args[key]).length > 0);
		let text = `${header}\n  ${theme.fg("toolOutput", preview)}`;
		if (hasMore) text += `\n  ${theme.fg("muted", "Ctrl+O for the full task contract")}`;
		return new Text(text, 0, 0);
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Spacer(1));
	renderTaskContract(container, args, 0, color, theme);
	return container;
}

// ---------------------------------------------------------------------------
// Expanded trace rendering
// ---------------------------------------------------------------------------

function renderToolCallExpanded(
	container: Container,
	item: Extract<DisplayItem, { type: "toolCall" }>,
	indent: number,
	depth: number,
	color: ThemeColor,
	theme: RenderTheme,
): void {
	addSectionLabel(container, `tool · ${item.name}`, indent, color, theme, item.id);
	if (item.name === "subagent") {
		renderTaskContract(container, item.args, indent + 2, depthColor(depth + 1), theme);
		return;
	}
	let body: string;
	if (item.name === "bash" && typeof item.args.command === "string") {
		const remaining = { ...item.args };
		delete remaining.command;
		body = `$ ${item.args.command}`;
		if (Object.keys(remaining).length > 0) body += `\n${safeJson(remaining)}`;
	} else {
		body = safeJson(item.args);
	}
	container.addChild(new Text(theme.fg("toolOutput", body), indent + 2, 0));
}

function renderToolResultExpanded(
	container: Container,
	item: Extract<DisplayItem, { type: "toolResult" }>,
	indent: number,
	depth: number,
	theme: RenderTheme,
	nesting: number,
	seen: Set<string>,
): void {
	const color = depthColor(depth);
	const children = item.name === "subagent" ? getNestedResults(item.details) : [];
	for (const child of children) {
		container.addChild(new Spacer(1));
		renderAgentExpanded(container, child, indent + 2, depth + 1, theme, nesting + 1, seen);
	}
	addSectionLabel(
		container,
		item.name === "subagent" ? "return to parent" : `result · ${item.name}`,
		indent,
		item.isError ? "error" : color,
		theme,
		item.toolCallId,
	);
	const text = prettyStructuredText(contentText(item.content));
	container.addChild(new Text(theme.fg(item.isError ? "error" : "toolOutput", text || "(no output)"), indent + 2, 0));
}

function renderActiveExecutions(
	container: Container,
	executions: ActiveToolExecution[],
	indent: number,
	depth: number,
	theme: RenderTheme,
	nesting: number,
	seen: Set<string>,
): void {
	for (const execution of executions) {
		const current = executionResult(execution);
		addSectionLabel(
			container,
			`${execution.complete ? "finishing" : "running"} · ${execution.toolName}`,
			indent,
			execution.isError ? "error" : "warning",
			theme,
			execution.toolCallId,
		);
		const children = execution.toolName === "subagent" ? getNestedResults(current?.details) : [];
		for (const child of children) renderAgentExpanded(container, child, indent + 2, depth + 1, theme, nesting + 1, seen);
		if (children.length === 0) {
			const text = prettyStructuredText(contentText(current?.content as Array<{ type: string; text?: string; mimeType?: string }>));
			container.addChild(new Text(theme.fg("toolOutput", text || "(awaiting result…)"), indent + 2, 0));
		}
	}
}

function renderAgentExpanded(
	container: Container,
	result: SingleResult,
	indent: number,
	fallbackDepth: number,
	theme: RenderTheme,
	nesting: number,
	seen: Set<string>,
): void {
	const depth = depthForResult(result, fallbackDepth);
	const role = roleForResult(result, depth);
	const color = depthColor(depth);
	const key = getRunKey(result);
	if (nesting > MAX_RENDER_NESTING || seen.has(key)) {
		container.addChild(new Text(theme.fg("warning", "↳ nested trace omitted (cycle or depth limit)"), indent, 0));
		return;
	}
	seen.add(key);

	const childCount = countNestedAgents(result);
	const duration = formatDuration(result.startedAtMs, result.finishedAtMs);
	const meta = [role, `depth ${depth}`, result.exitCode === -1 ? "running" : undefined, duration || undefined]
		.filter(Boolean)
		.join(" · ");
	let header =
		theme.fg(color, nesting > 0 ? "◇" : "◆") +
		" " +
		statusIcon(result, theme) +
		" " +
		theme.fg(color, theme.bold(result.agent)) +
		"  " +
		theme.fg("dim", meta);
	if (isResultError(result) && result.stopReason) header += `  ${theme.fg("error", `[${result.stopReason}]`)}`;
	container.addChild(new Text(header, indent, 0));
	if (result.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), indent + 2, 0));

	const items = getDisplayItems(result.messages);
	const traceMeta = [
		result.usage.turns ? `${result.usage.turns} turns` : undefined,
		childCount ? `${childCount} nested agent${childCount === 1 ? "" : "s"}` : undefined,
	].filter(Boolean).join(" · ");
	container.addChild(new Spacer(1));
	addSectionLabel(container, "trace", indent, color, theme, traceMeta || undefined);

	if (result.captureTruncated) {
		container.addChild(new Text(theme.fg("warning", "Earlier trace entries were omitted at the capture limit."), indent + 2, 0));
	}
	if (items.length === 0 && (result.activeToolExecutions?.length ?? 0) === 0) {
		container.addChild(new Text(theme.fg("muted", getResultSummaryText(result)), indent + 2, 0));
	}

	for (const item of items) {
		if (item.type === "thinking") {
			addSectionLabel(container, "reasoning", indent + 1, color, theme, item.redacted ? "redacted" : undefined);
			const thinking = item.redacted && !item.thinking.trim() ? "(provider-redacted reasoning)" : item.thinking.trim();
			if (thinking) {
				container.addChild(new Markdown(thinking, indent + 3, 0, getMarkdownTheme(), {
					color: (text) => theme.fg("thinkingText", text),
					italic: true,
				}));
			}
		} else if (item.type === "text" && item.text.trim()) {
			addSectionLabel(container, "assistant", indent + 1, color, theme);
			container.addChild(new Markdown(item.text.trim(), indent + 3, 0, getMarkdownTheme()));
		} else if (item.type === "toolCall") {
			renderToolCallExpanded(container, item, indent + 1, depth, color, theme);
		} else if (item.type === "toolResult") {
			renderToolResultExpanded(container, item, indent + 1, depth, theme, nesting, seen);
		}
	}

	if (result.activeToolExecutions?.length) {
		renderActiveExecutions(container, result.activeToolExecutions, indent + 1, depth, theme, nesting, seen);
	}

	if (result.receipt) {
		container.addChild(new Spacer(1));
		renderReceipt(container, result.receipt, indent, color, theme);
	}
	const usage = formatUsage(result.usage, result.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), indent + 2, 0));
	seen.delete(key);
}

// ---------------------------------------------------------------------------
// Collapsed result rendering
// ---------------------------------------------------------------------------

function renderSingleCollapsed(result: SingleResult, theme: RenderTheme): Text {
	const depth = depthForResult(result);
	const role = roleForResult(result, depth);
	const color = depthColor(depth);
	const duration = formatDuration(result.startedAtMs, result.finishedAtMs);
	let text =
		`${statusIcon(result, theme)} ${theme.fg(color, theme.bold(result.agent))}` +
		`  ${theme.fg("dim", [role, `depth ${depth}`, duration || undefined].filter(Boolean).join(" · "))}`;
	if (isResultError(result) && result.stopReason) text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;

	const summary = oneLine(getResultSummaryText(result));
	if (summary && summary !== "(no output)") text += `\n${theme.fg(isResultError(result) ? "error" : "toolOutput", truncate(summary, COLLAPSED_SUMMARY_CHARS))}`;

	const actions = getDisplayItems(result.messages)
		.filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall")
		.slice(-COLLAPSED_ACTION_COUNT);
	for (const action of actions) {
		text += `\n${theme.fg("muted", "→ ")}${formatToolCallSummary(action.name, action.args, theme.fg.bind(theme))}`;
	}

	const childCount = countNestedAgents(result);
	const usage = formatUsage(result.usage, result.model);
	const meta = [
		childCount ? `${childCount} nested agent${childCount === 1 ? "" : "s"}` : undefined,
		usage || undefined,
	].filter(Boolean).join("  ·  ");
	if (meta) text += `\n${theme.fg("dim", meta)}`;
	if (result.messages.length > 0 || result.task || childCount > 0) {
		text += `\n${theme.fg("muted", "Ctrl+O to inspect the full trace")}`;
	}
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — completed and streaming results
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: RenderTheme,
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || !Array.isArray(details.results) || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}
	if (!expanded && details.results.length === 1) return renderSingleCollapsed(details.results[0], theme);

	const container = new Container();
	const seen = new Set<string>();
	for (let index = 0; index < details.results.length; index++) {
		if (index > 0) container.addChild(new Spacer(1));
		if (expanded) renderAgentExpanded(container, details.results[index], 0, 1, theme, 0, seen);
		else container.addChild(renderSingleCollapsed(details.results[index], theme));
	}
	return container;
}
