import React from "react";
import { Box, Text } from "ink";

export type ActionMode =
	| { kind: "idle" }
	| { kind: "rename"; sessionName: string; draft: string }
	| { kind: "alias"; sessionName: string; draft: string }
	| { kind: "remove-confirm"; sessionName: string };

export type ActionBarProps = {
	mode?: ActionMode;
	message?: string;
	messageTone?: "info" | "error";
};

const KEYBINDINGS = "[r] rename  [a] alias  [x] remove  [q] quit";

function promptFor(mode: ActionMode): string | undefined {
	if (mode.kind === "rename") return `rename ${mode.sessionName} -> ${mode.draft}_`;
	if (mode.kind === "alias") return `alias for ${mode.sessionName}: ${mode.draft}_`;
	if (mode.kind === "remove-confirm") {
		return `remove ${mode.sessionName}? press x again to confirm, any other key to cancel`;
	}
	return undefined;
}

export function ActionBar({ mode, message, messageTone }: ActionBarProps) {
	const active: ActionMode = mode ?? { kind: "idle" };
	const prompt = promptFor(active);
	const messageColor = messageTone === "error" ? "red" : undefined;
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text dimColor>{KEYBINDINGS}</Text>
			{prompt ? <Text color="yellow">{prompt}</Text> : null}
			{message ? <Text color={messageColor}>{message}</Text> : null}
		</Box>
	);
}

export default ActionBar;
