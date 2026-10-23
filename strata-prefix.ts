import { createHash } from "node:crypto";

export const STRATA_PROVIDER_ENV = "PI_SUBAGENT_STRATA_PROVIDER";
export const STRATA_PREFIX_ENV = "PI_SUBAGENT_STRATA_PREFIX";
export const STRATA_DEBUG_ENV = "PI_SUBAGENT_STRATA_DEBUG";

export interface StrataPrefixV1 {
	kind: "pi-subagent-strata-prefix";
	protocolVersion: 1;
	rootRunId: string;
	provider: string;
	model: string;
	baseUrl: string;
	messages: number;
	sha256: string;
}

interface ProviderModel {
	provider: string;
	api: string;
	id: string;
	baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePrefix(raw: string, rootRunId: string, provider: string | undefined): StrataPrefixV1 {
	if (Buffer.byteLength(raw) > 16_384) throw new Error("Inherited Strata prefix state is too large.");
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) || value.kind !== "pi-subagent-strata-prefix" || value.protocolVersion !== 1 ||
		value.rootRunId !== rootRunId || value.provider !== provider ||
		![value.provider, value.model, value.baseUrl].every(
			(item) => typeof item === "string" && item.length > 0 && item.length <= 4_096,
		) ||
		!Number.isSafeInteger(value.messages) || Number(value.messages) < 1 ||
		typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
	) throw new Error("Inherited Strata prefix state is malformed or belongs to another run/provider.");
	return value as unknown as StrataPrefixV1;
}

function textMessages(payload: Record<string, unknown>): Record<string, unknown>[] {
	if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
		throw new Error("Strata pinning requires a nonempty Chat Completions messages array.");
	}
	for (const message of payload.messages) {
		if (!isRecord(message) || !["system", "developer", "user", "assistant", "tool"].includes(String(message.role))) {
			throw new Error("Strata pinning requires Chat Completions message objects.");
		}
		const content = message.content;
		if (content !== undefined && content !== null && typeof content !== "string" && !(
			Array.isArray(content) && content.every(
				(part) => isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
		)) throw new Error("Strata prefix pinning currently supports text-only messages, not images/audio.");
	}
	return payload.messages as Record<string, unknown>[];
}

function fingerprint(payload: Record<string, unknown>, messages: Record<string, unknown>[], count: number): string {
	return createHash("sha256").update(JSON.stringify({
		model: payload.model,
		messages: messages.slice(0, count),
		tools: payload.tools,
		tool_choice: payload.tool_choice,
		parallel_tool_calls: payload.parallel_tool_calls,
		reasoning_effort: payload.reasoning_effort,
		reasoning: payload.reasoning,
		chat_template_kwargs: payload.chat_template_kwargs,
	})).digest("hex");
}

export class StrataPrefixController {
	private readonly rootRunId: string;
	private readonly child: boolean;
	private readonly log: (event: string, detail: Record<string, unknown>) => void;
	private readonly provider: string | undefined;
	private readonly inherited: StrataPrefixV1 | null;
	private readonly initializationError: string | null;
	private latest: StrataPrefixV1 | null = null;
	private resume: StrataPrefixV1 | null = null;
	private unavailable = "No serialized parent request has been observed.";

	constructor(
		rootRunId: string,
		child: boolean,
		env: NodeJS.ProcessEnv = process.env,
		log: (event: string, detail: Record<string, unknown>) => void = () => {},
	) {
		this.rootRunId = rootRunId;
		this.child = child;
		this.log = log;
		this.provider = env[STRATA_PROVIDER_ENV]?.trim() || undefined;
		let inherited: StrataPrefixV1 | null = null;
		let error: string | null = null;
		if (child && env[STRATA_PREFIX_ENV]) {
			try {
				inherited = parsePrefix(env[STRATA_PREFIX_ENV]!, rootRunId, this.provider);
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}
		}
		this.inherited = inherited;
		this.initializationError = error;
	}

	reset(): void {
		this.latest = null;
		this.resume = null;
		this.unavailable = "The session changed; no serialized parent request has been observed.";
	}

	beforeRequest(payload: unknown, model: ProviderModel | undefined): Record<string, unknown> | undefined {
		this.latest = null;
		if (this.initializationError) throw new Error(this.initializationError);
		if (!this.provider || model?.provider !== this.provider) {
			this.resume = null;
			if (this.inherited) throw new Error("The child changed away from its inherited Strata provider.");
			return;
		}
		try {
			if (model.api !== "openai-completions" || !model.baseUrl) {
				throw new Error("Strata pinning requires the openai-completions API and a base URL.");
			}
			if (!isRecord(payload)) throw new Error("Strata pinning requires a Chat Completions request object.");
			if (payload.strata_checkpoint === false) throw new Error("strata_checkpoint=false disables Strata pinning.");
			const messages = textMessages(payload);
			let boundary = this.inherited ?? this.resume;
			if (boundary && (
				boundary.model !== model.id || boundary.baseUrl !== model.baseUrl ||
				messages.length <= boundary.messages ||
				fingerprint(payload, messages, boundary.messages) !== boundary.sha256
			)) {
				if (this.child) throw new Error("The serialized Strata prefix, tools, thinking, model, or endpoint changed.");
				this.log("resume_skipped", { messages: boundary.messages, reason: "The parent prefix changed." });
				this.resume = null;
				boundary = null;
			}
			if (payload.strata_prefix !== undefined && !(
				boundary && isRecord(payload.strata_prefix) &&
				Object.keys(payload.strata_prefix).length === 1 &&
				payload.strata_prefix.messages === boundary.messages
			)) throw new Error("An existing strata_prefix conflicts with host-owned subagent pinning.");
			if (this.child && !boundary) throw new Error("The child is missing its host-owned Strata prefix boundary.");
			this.latest = {
				kind: "pi-subagent-strata-prefix",
				protocolVersion: 1,
				rootRunId: this.rootRunId,
				provider: this.provider,
				model: model.id,
				baseUrl: model.baseUrl,
				messages: messages.length,
				sha256: fingerprint(payload, messages, messages.length),
			};
			if (!boundary) return;
			this.resume = null;
			this.log("pin_requested", { messages: boundary.messages, inherited: this.child });
			return { ...payload, strata_prefix: { messages: boundary.messages } };
		} catch (cause) {
			this.resume = null;
			this.unavailable = cause instanceof Error ? cause.message : String(cause);
			this.log("pin_unavailable", { reason: this.unavailable });
			if (this.child) throw cause;
		}
	}

	prepareChild(model: ProviderModel | undefined): StrataPrefixV1 | undefined {
		if (this.initializationError) throw new Error(this.initializationError);
		if (!this.provider || model?.provider !== this.provider) {
			if (this.inherited) throw new Error("Cannot change provider while a Strata prefix is inherited.");
			return;
		}
		if (!this.latest || this.latest.model !== model.id || this.latest.baseUrl !== model.baseUrl ||
			model.api !== "openai-completions") {
			throw new Error(`Cannot pin the parent Strata prefix: ${this.unavailable}`);
		}
		const boundary = this.inherited ?? this.latest;
		if (!this.child) this.resume = boundary;
		this.log("boundary_selected", { messages: boundary.messages, inherited: this.child });
		return { ...boundary };
	}
}
