import React from "react";
import { Box, Text } from "ink";
import type { SessionDashboard, SessionDashboardEntry } from "../../session-routing.js";

export type DashboardProps = {
	dashboard: SessionDashboard;
	focusedPath?: string;
};

function entryTags(entry: SessionDashboardEntry): string[] {
	const tags: string[] = [];
	if (entry.current) tags.push("current");
	if (entry.ready) tags.push("ready");
	tags.push(entry.activity);
	return tags;
}

function rowKey(entry: SessionDashboardEntry, index: number): string {
	return entry.path || `${entry.name}:${index}`;
}

export function Dashboard({ dashboard, focusedPath }: DashboardProps) {
	const readyLine = dashboard.ready.length > 0 ? dashboard.ready.join(", ") : "none";
	const storeText = dashboard.storePath ?? "(unset)";
	const focus = focusedPath ?? dashboard.sessions.find((s) => s.current)?.path;
	const nameWidth = Math.max(
		16,
		...dashboard.sessions.map((entry) => entry.name.length),
	);

	return (
		<Box flexDirection="column">
			<Box>
				<Text bold>pi-speak session manager</Text>
			</Box>
			<Box>
				<Text dimColor>store: {storeText}</Text>
			</Box>
			<Box height={1} />
			<Text>Current: {dashboard.current}</Text>
			<Text>Ready:   {readyLine}</Text>
			<Box height={1} />
			{dashboard.sessions.length === 0 ? (
				<Text dimColor>(no sessions)</Text>
			) : (
				dashboard.sessions.map((entry, index) => {
					const tags = entryTags(entry);
					const isFocused = !!(entry.path && entry.path === focus);
					const marker = isFocused ? ">" : " ";
					const aliasText = entry.aliases.length > 0 ? `aliases: ${entry.aliases.join(", ")}` : "";
					return (
						<Box key={rowKey(entry, index)} flexDirection="row">
							<Text color={isFocused ? "cyan" : undefined}>
								{marker} {entry.name.padEnd(nameWidth)}
							</Text>
							<Text>  </Text>
							{tags.map((tag, tagIndex) => (
								<Text
									key={`${tag}-${tagIndex}`}
									color={tag === "busy" ? "yellow" : tag === "ready" ? "green" : undefined}
								>
									[{tag}]{tagIndex < tags.length - 1 ? " " : ""}
								</Text>
							))}
							{aliasText ? (
								<Text dimColor>  {aliasText}</Text>
							) : null}
						</Box>
					);
				})
			)}
		</Box>
	);
}

export default Dashboard;
