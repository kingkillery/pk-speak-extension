import React from "react";
import { Box, Text } from "ink";
import type { SessionDashboardEntry } from "../../session-routing.js";

export type StatusFooterProps = {
	focusedEntry?: SessionDashboardEntry;
	compactFamilies?: string[];
};

function stateText(entry: SessionDashboardEntry): string {
	const parts: string[] = [entry.activity];
	if (entry.current) parts.unshift("current");
	if (entry.ready) parts.unshift("ready");
	return parts.join(" · ");
}

export function StatusFooter({ focusedEntry, compactFamilies = [] }: StatusFooterProps) {
	if (!focusedEntry?.path) {
		return (
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Focus: none</Text>
			</Box>
		);
	}

	return (
		<Box marginTop={1} flexDirection="column">
			<Text bold>Focused session</Text>
			<Text>
				{focusedEntry.name} <Text dimColor>({stateText(focusedEntry)})</Text>
			</Text>
			<Text dimColor>path: {focusedEntry.path}</Text>
			<Text dimColor>
				aliases: {focusedEntry.aliases.length > 0 ? focusedEntry.aliases.join(", ") : "none"}
			</Text>
			<Text dimColor>
				compact: {compactFamilies.length > 0 ? compactFamilies.join(", ") : "none"}
			</Text>
		</Box>
	);
}

export default StatusFooter;
