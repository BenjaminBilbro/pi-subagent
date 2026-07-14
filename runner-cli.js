/** Build child CLI inheritance from Pi's own current argument grammar. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "@earendil-works/pi-coding-agent";

function isLocalResourceSource(value) {
  const trimmed = value.trim();
  return ![
    "npm:",
    "git:",
    "github:",
    "http:",
    "https:",
    "ssh:",
  ].some((prefix) => trimmed.startsWith(prefix));
}

/** Mirror Pi's local CLI resource resolution against the parent launch cwd. */
function resolveResourceSource(value) {
  if (!value || !isLocalResourceSource(value)) return value;
  let normalized = value;
  if (normalized === "~") normalized = os.homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return path.resolve(process.cwd(), normalized);
}

// Pi accepts literal text or a file path for prompt flags. Resolve only an
// existing relative file; resolving arbitrary literal text would change it.
function resolvePromptTextOrFile(value) {
  if (!value || path.isAbsolute(value)) return value;
  const resolved = path.resolve(process.cwd(), value);
  return fs.existsSync(resolved) ? resolved : value;
}

function pushRepeated(target, flag, values, mapper = (value) => value) {
  for (const value of values ?? []) target.push(flag, mapper(value));
}

/**
 * Parse the parent argv with Pi itself, then reconstruct only settings that a
 * cache-stable child must inherit. Session/run controls and tool selectors are
 * intentionally omitted; the runner supplies its snapshot and current tools.
 */
export function parseInheritedCliArgs(argv) {
  const parsed = parseArgs(argv.slice(2));
  const extensionArgs = [];
  const alwaysProxy = [];

  if (parsed.noExtensions) extensionArgs.push("--no-extensions");
  pushRepeated(extensionArgs, "--extension", parsed.extensions, resolveResourceSource);

  if (parsed.apiKey !== undefined) alwaysProxy.push("--api-key", parsed.apiKey);
  if (parsed.systemPrompt !== undefined) {
    alwaysProxy.push("--system-prompt", resolvePromptTextOrFile(parsed.systemPrompt));
  }
  pushRepeated(alwaysProxy, "--append-system-prompt", parsed.appendSystemPrompt, resolvePromptTextOrFile);
  pushRepeated(alwaysProxy, "--skill", parsed.skills, resolveResourceSource);
  pushRepeated(alwaysProxy, "--prompt-template", parsed.promptTemplates, resolveResourceSource);
  pushRepeated(alwaysProxy, "--theme", parsed.themes, resolveResourceSource);

  if (parsed.noSkills) alwaysProxy.push("--no-skills");
  if (parsed.noPromptTemplates) alwaysProxy.push("--no-prompt-templates");
  if (parsed.noThemes) alwaysProxy.push("--no-themes");
  if (parsed.noContextFiles) alwaysProxy.push("--no-context-files");
  if (parsed.projectTrustOverride === true) alwaysProxy.push("--approve");
  if (parsed.projectTrustOverride === false) alwaysProxy.push("--no-approve");

  // Unknown flags belong to extensions. Re-emitting string values with '='
  // preserves Pi's own Map semantics and never consumes the child task prompt.
  for (const [name, value] of parsed.unknownFlags) {
    alwaysProxy.push(value === true ? `--${name}` : `--${name}=${value}`);
  }

  return {
    extensionArgs,
    alwaysProxy,
    fallbackModel: parsed.model,
    fallbackThinking: parsed.thinking,
    fallbackTools: parsed.tools?.join(","),
    fallbackNoTools: parsed.noTools === true,
  };
}
