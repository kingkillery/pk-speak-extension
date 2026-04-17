#!/usr/bin/env node

import React from "react";
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

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log("Non-interactive terminal detected; rendering a read-only snapshot. Re-run in a live terminal for keyboard controls.");
		console.log(renderSessionManagerSnapshot({
			currentSessionPath: options.currentSessionPath,
			currentSessionName: options.currentSessionName,
		}));
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
