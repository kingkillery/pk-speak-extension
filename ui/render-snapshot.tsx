import React from "react";
import { Box, renderToString } from "ink";
import { Dashboard } from "./components/Dashboard.js";
import { ActionBar } from "./components/ActionBar.js";
import { ToastBand } from "./components/Toast.js";
import CompactRoutes from "./components/CompactRoutes.js";
import StatusFooter from "./components/StatusFooter.js";
import {
	buildPaneCompactRouteSlots,
	describeFocusedSessionSlots,
	ensureFocusedPath,
	findFocusedEntry,
} from "./admin-state.js";
import { loadSessionDashboard } from "./selectors.js";

export type RenderSnapshotOptions = {
	currentSessionPath?: string;
	currentSessionName?: string;
};

export function renderSessionManagerSnapshot(options: RenderSnapshotOptions = {}): string {
	const dashboard = loadSessionDashboard({
		currentSessionPath: options.currentSessionPath,
		currentSessionName: options.currentSessionName,
	});
	const focusedPath = ensureFocusedPath(dashboard, options.currentSessionPath);
	const focusedEntry = findFocusedEntry(dashboard, focusedPath);
	const slots = buildPaneCompactRouteSlots(dashboard);
	const compactFamilies = describeFocusedSessionSlots(focusedEntry, slots);

	return renderToString(
		<Box flexDirection="column">
			<Dashboard dashboard={dashboard} focusedPath={focusedPath} />
			<CompactRoutes slots={slots} />
			<StatusFooter focusedEntry={focusedEntry} compactFamilies={compactFamilies} />
			<ActionBar mode={{ kind: "idle" }} />
			<ToastBand toasts={[]} />
		</Box>,
		{ columns: 120 },
	);
}

export default renderSessionManagerSnapshot;
