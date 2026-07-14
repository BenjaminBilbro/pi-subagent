import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

const markerPath = process.env.PI_SUBAGENT_TEST_MARKER;
if (!markerPath) throw new Error("PI_SUBAGENT_TEST_MARKER is required");
const extensionUrl = process.env.PI_SUBAGENT_TEST_EXTENSION_URL;
if (!extensionUrl) throw new Error("PI_SUBAGENT_TEST_EXTENSION_URL is required");
const { default: extension } = await import(extensionUrl);

const handlers = new Map();
const tools = [];
const upstreamBash = createBashToolDefinition(process.cwd());
const baseTools = [{
	name: "bash",
	description: upstreamBash.description,
	parameters: upstreamBash.parameters,
	promptGuidelines: upstreamBash.promptGuidelines,
	sourceInfo: { source: "builtin" },
}];

const pi = {
	on(event, handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerTool(tool) {
		tools.push(tool);
	},
	getAllTools() {
		const byName = new Map(baseTools.map((tool) => [tool.name, tool]));
		for (const tool of tools) byName.set(tool.name, { ...tool, sourceInfo: { source: "extension" } });
		return [...byName.values()];
	},
	getActiveTools() {
		return ["bash", ...tools.map((tool) => tool.name).filter((name) => name !== "bash")];
	},
	getThinkingLevel() {
		return "off";
	},
};

extension(pi);
for (const handler of handlers.get("session_start") ?? []) {
	await handler({ type: "session_start", reason: "startup" }, {});
}
const bash = tools.find((tool) => tool.name === "bash");
if (!bash) throw new Error("contained Bash was not installed");
await bash.execute("fixture-bash", {
	command: `sleep 30 & printf '%s %s\\n' "$!" "$PPID" > '${markerPath}'`,
}, undefined, undefined, {});

setInterval(() => {}, 1_000);
