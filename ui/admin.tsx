#!/usr/bin/env node

import React from "react";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import SessionManagerPane from "./app.js";
import { parseAdminCliArgs } from "./admin-state.js";
import { renderSessionManagerSnapshot } from "./render-snapshot.js";

const USAGE = [
	"pi-speak-admin - management pane for pi-speak session routing",
	"",
	"Usage:",
	"  pi-speak-admin [--help] [--snapshot] [--current-path <path>] [--current-name <name>]",
	"",
	"Options:",
	"  --snapshot             Render one deterministic frame and exit",
	"  --current-path <path>  Seed the pane with the launching session path",
	"  --current-name <name>  Seed the pane with the launching session name",
	].join("\n");

function getPaneLockPath(): string {
	return join(tmpdir(), "pi-speak-admin-pane.lock.json");
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function claimSingleInstance(): (() => void) | undefined {
	const lockPath = getPaneLockPath();
	if (existsSync(lockPath)) {
		try {
			const existing = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
			if (typeof existing.pid === "number" && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
				console.error(`pi-speak-admin is already running (pid ${existing.pid}).`);
				process.exitCode = 0;
				return undefined;
			}
		} catch {}
	}

	writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
	const release = () => {
		try {
			const existing = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
			if (existing.pid === process.pid) rmSync(lockPath, { force: true });
		} catch {}
	};
	process.once("exit", release);
	process.once("SIGINT", () => {
		release();
		process.exit(0);
	});
	process.once("SIGTERM", () => {
		release();
		process.exit(0);
	});
	return release;
}

async function main(argv: string[]): Promise<number> {
	const options = parseAdminCliArgs(argv);
	if (options.showHelp) {
		console.log(USAGE);
		return 0;
	}
	if (options.showSnapshot) {
		console.log(renderSessionManagerSnapshot({
			currentSessionPath: options.currentSessionPath,
			currentSessionName: options.currentSessionName,
		}));
		return 0;
	}

	const releaseLock = claimSingleInstance();
	if (!releaseLock) return 0;

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log("Non-interactive terminal detected; rendering a read-only snapshot. Re-run in a live terminal for keyboard controls.");
		console.log(renderSessionManagerSnapshot({
			currentSessionPath: options.currentSessionPath,
			currentSessionName: options.currentSessionName,
		}));
		releaseLock();
		return 0;
	}

	const instance = render(
		<SessionManagerPane
			initialCurrentSessionPath={options.currentSessionPath}
			initialCurrentSessionName={options.currentSessionName}
		/>,
		{ interactive: true },
	);
	await instance.waitUntilExit();
	releaseLock();
	return 0;
}

main(process.argv)
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.stack ?? error.message : error);
		process.exitCode = 1;
	});
