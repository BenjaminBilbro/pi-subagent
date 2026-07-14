/**
 * POSIX process-group guardian for one child-agent bash invocation.
 *
 * The extension starts this helper as a detached process-group leader. The
 * configured shell joins that group, while this guardian stays alive after the
 * shell exits so the group ID cannot be reused before child-agent cleanup.
 * Commands inherit only fd 0-2; stdin and fd 3 remain private control/status
 * channels between the extension and this guardian.
 */

import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_CONTROL_BYTES = 32 * 1024 * 1024;
const TERM_GRACE_MS = 250;

function fail(message) {
	try {
		fs.writeSync(3, `${JSON.stringify({ kind: "guardian_error", message })}\n`, undefined, "utf8");
	} catch {
		// The parent may already be gone.
	}
	process.exitCode = 1;
}

function parseConfiguration() {
	try {
		const value = JSON.parse(process.argv[2] ?? "");
		if (!value || typeof value !== "object") throw new Error("configuration must be an object");
		if (typeof value.shell !== "string" || value.shell.length === 0) throw new Error("missing shell");
		if (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) {
			throw new Error("invalid shell arguments");
		}
		if (value.commandTransport !== undefined && value.commandTransport !== "stdin") {
			throw new Error("invalid command transport");
		}
		if (typeof value.cwd !== "string" || value.cwd.length === 0) throw new Error("missing cwd");
		return value;
	} catch (error) {
		fail(`Invalid guardian configuration: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

const configuration = parseConfiguration();
if (!configuration) process.exit(1);

let commandStarted = false;
let cleanupStarted = false;
let shellProcess = null;
let controlBuffer = "";
const controlDecoder = new StringDecoder("utf8");

function sendStatus(value) {
	try {
		fs.writeSync(3, `${JSON.stringify(value)}\n`, undefined, "utf8");
		return true;
	} catch {
		startCleanup();
		return false;
	}
}

function signalOwnedGroup(signal) {
	try {
		process.kill(-process.pid, signal);
	} catch {
		// The group may already have been torn down.
	}
}

function startCleanup() {
	if (cleanupStarted) return;
	cleanupStarted = true;
	// The guardian ignores TERM so it continues to pin the process-group ID
	// until the unconditional group-wide KILL below.
	signalOwnedGroup("SIGTERM");
	setTimeout(() => signalOwnedGroup("SIGKILL"), TERM_GRACE_MS);
}

for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
	process.on(signal, () => {
		// Cleanup is driven by the private control pipe. Ignoring these signals
		// keeps the group identity live between the TERM and KILL phases.
	});
}

function startCommand(command) {
	if (commandStarted || cleanupStarted) {
		sendStatus({ kind: "command_error", message: "Guardian received an invalid duplicate or late start." });
		return;
	}
	commandStarted = true;
	const commandFromStdin = configuration.commandTransport === "stdin";
	try {
		shellProcess = spawn(
			configuration.shell,
			commandFromStdin ? configuration.args : [...configuration.args, command],
			{
				cwd: configuration.cwd,
				detached: false,
				env: process.env,
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
	} catch (error) {
		sendStatus({ kind: "command_error", message: error instanceof Error ? error.message : String(error) });
		return;
	}

	shellProcess.stdout?.on("data", (chunk) => {
		if (!process.stdout.write(chunk)) shellProcess?.stdout?.pause();
	});
	process.stdout.on("drain", () => shellProcess?.stdout?.resume());
	shellProcess.stderr?.on("data", (chunk) => {
		if (!process.stderr.write(chunk)) shellProcess?.stderr?.pause();
	});
	process.stderr.on("drain", () => shellProcess?.stderr?.resume());
	shellProcess.once("error", (error) => {
		sendStatus({ kind: "command_error", message: error.message });
	});
	shellProcess.once("exit", (exitCode, signal) => {
		sendStatus({ kind: "command_exit", exitCode, signal });
	});
	if (commandFromStdin) {
		shellProcess.stdin?.on("error", (error) => {
			sendStatus({ kind: "command_error", message: error.message });
		});
		shellProcess.stdin?.end(command);
	}
}

function handleControlLine(line) {
	if (!line.trim() || cleanupStarted) return;
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		fail("Guardian received malformed control JSON.");
		startCleanup();
		return;
	}
	if (value?.kind === "start" && typeof value.command === "string") {
		startCommand(value.command);
		return;
	}
	if (value?.kind === "cleanup") {
		startCleanup();
		return;
	}
	fail("Guardian received an invalid control record.");
	startCleanup();
}

process.stdin.on("data", (chunk) => {
	controlBuffer += controlDecoder.write(chunk);
	if (Buffer.byteLength(controlBuffer, "utf8") > MAX_CONTROL_BYTES) {
		fail("Guardian control record exceeded its byte limit.");
		startCleanup();
		return;
	}
	const lines = controlBuffer.split(/\r?\n/);
	controlBuffer = lines.pop() ?? "";
	for (const line of lines) handleControlLine(line);
});
process.stdin.once("end", () => {
	controlBuffer += controlDecoder.end();
	if (controlBuffer.trim()) handleControlLine(controlBuffer);
	startCleanup();
});
process.stdin.once("error", startCleanup);
process.stdout.once("error", startCleanup);
process.stderr.once("error", startCleanup);

sendStatus({ kind: "ready", pid: process.pid });
