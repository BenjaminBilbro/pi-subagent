/** Helpers for parsing Pi JSON events and retaining bounded diagnostics. */

import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export const MAX_CAPTURED_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_DEDUP_SIGNATURES = 8192;
const TRUNCATION_MARKER = "\n\n[Subagent response truncated during capture]";

function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

function getCapturedMessageState(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__capturedMessageState")) {
    Object.defineProperty(result, "__capturedMessageState", {
      value: { sizes: [], totalBytes: 0 },
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__capturedMessageState;
}

function serializeMessage(message) {
  try {
    const serialized = JSON.stringify(message);
    return {
      bytes: Buffer.byteLength(serialized, "utf8"),
      signature: createHash("sha256").update(serialized).digest("hex"),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function rememberSignature(seen, signature) {
  while (seen.size >= MAX_DEDUP_SIGNATURES) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  seen.add(signature);
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function rememberSubmitResultToolCalls(result, message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
  const ids = result.submitResultToolCallIds ?? (result.submitResultToolCallIds = []);
  for (const part of message.content) {
    if (part?.type !== "toolCall" || part.name !== "submit_result" || typeof part.id !== "string") continue;
    if (!ids.includes(part.id) && ids.length < 16) ids.push(part.id);
  }
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

function getTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function compactOversizedAssistantMessage(message) {
  const text = getTextContent(message.content);
  if (!text) return null;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const compactText =
    Buffer.byteLength(text, "utf8") > MAX_CAPTURED_MESSAGE_BYTES - markerBytes - 1024
      ? `${truncateUtf8(text, MAX_CAPTURED_MESSAGE_BYTES - markerBytes - 1024)}${TRUNCATION_MARKER}`
      : text;
  return {
    role: "assistant",
    content: [{ type: "text", text: compactText }],
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp,
    usage: message.usage,
  };
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;
  updateAssistantMetadata(result, message);
  rememberSubmitResultToolCalls(result, message);

  let capturedMessage = message;
  let serialized = serializeMessage(capturedMessage);
  if (serialized.error) {
    result.captureTruncated = true;
    result.processError = true;
    result.stopReason = "error";
    result.errorMessage = `Could not safely capture a subagent message: ${serialized.error}`;
    return false;
  }
  if (serialized.bytes > MAX_CAPTURED_MESSAGE_BYTES) {
    result.captureTruncated = true;
    capturedMessage = compactOversizedAssistantMessage(message);
    if (!capturedMessage) return false;
    serialized = serializeMessage(capturedMessage);
    if (serialized.error) {
      result.processError = true;
      result.stopReason = "error";
      result.errorMessage = `Could not safely capture a subagent message: ${serialized.error}`;
      return false;
    }
  }

  const seen = getSeenMessageSignatures(result);
  if (seen.has(serialized.signature)) return false;
  const capture = getCapturedMessageState(result);
  while (
    result.messages.length > 0 &&
    capture.totalBytes + serialized.bytes > MAX_CAPTURED_MESSAGE_BYTES
  ) {
    result.messages.shift();
    capture.totalBytes -= capture.sizes.shift() ?? 0;
    result.captureTruncated = true;
  }
  if (serialized.bytes > MAX_CAPTURED_MESSAGE_BYTES) {
    result.captureTruncated = true;
    return false;
  }

  rememberSignature(seen, serialized.signature);
  result.messages.push(capturedMessage);
  capture.sizes.push(serialized.bytes);
  capture.totalBytes += serialized.bytes;

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }
  return true;
}

function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

function addToolError(result, event) {
  if (!event?.isError) return;
  const text = getTextContent(event.result?.content);
  if (text) result.pendingToolError = text;
}

function captureSubmittedReceipt(result, event) {
  if (event?.toolName !== "submit_result" || event.isError) return;
  if (result.submittedReceiptEvent) {
    result.processError = true;
    result.stopReason = "error";
    result.errorMessage = "Subagent emitted more than one successful submit_result event.";
    return;
  }
  result.submittedReceiptEvent = {
    toolCallId: event.toolCallId,
    details: event.result?.details,
  };
}

export function hasAttributedToolError(result) {
  if (result?.stopReason !== "error") return false;
  const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage.trim() : "";
  const pendingToolError =
    typeof result.pendingToolError === "string" ? result.pendingToolError.trim() : "";
  return Boolean(errorMessage && pendingToolError && pendingToolError === errorMessage);
}

export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "agent_start":
      result.sawAgentStart = true;
      return false;
    case "message_end":
      if (event.message?.role === "assistant") result.pendingToolError = undefined;
      return addAssistantMessage(result, event.message);
    case "turn_end":
      if (event.message?.role === "assistant") result.pendingToolError = undefined;
      return addAssistantMessage(result, event.message);
    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);
    case "agent_settled":
      result.sawAgentSettled = true;
      return false;
    case "tool_execution_end":
      addToolError(result, event);
      captureSubmittedReceipt(result, event);
      return false;
    default:
      return false;
  }
}

export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }
  return processPiEvent(event, result);
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .filter((partText) => partText.length > 0)
      .join("");
    if (text) return text;
  }
  return "";
}

export function getResultSummaryText(result) {
  const processErrorText = result?.processError
    ? `Subagent process error: ${result.errorMessage || result.stderr || "unknown process failure"}`
    : "";
  const terminalErrorText =
    !processErrorText &&
    (result?.stopReason === "error" || result?.stopReason === "aborted" || result?.stopReason === "timeout" || result?.stopReason === "max_turns") &&
    !hasAttributedToolError(result) &&
    typeof result?.errorMessage === "string" &&
    result.errorMessage.trim()
      ? result.errorMessage.trim()
      : "";
  if (processErrorText || terminalErrorText) return processErrorText || terminalErrorText;
  if (result?.receipt) return result.receipt.summary;
  const finalText = getFinalAssistantText(result?.messages);
  const captureText = result?.captureTruncated
    ? "[Earlier or oversized subagent messages were omitted at the capture limit.]"
    : "";
  const suffix = [captureText].filter(Boolean).join("\n\n");
  if (finalText && suffix) return `${finalText}\n\n${suffix}`;
  if (finalText) return finalText;
  if (suffix) return suffix;
  if (typeof result?.stderr === "string" && result.stderr.trim() && result.exitCode > 0) {
    return result.stderr.trim();
  }
  return "(no output)";
}
