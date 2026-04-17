import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { SessionEvent } from "../session-events.js";
import { Dashboard } from "./components/Dashboard.js";
import { ActionBar, type ActionMode } from "./components/ActionBar.js";
import { ToastBand } from "./components/Toast.js";
import CompactRoutes from "./components/CompactRoutes.js";
import StatusFooter from "./components/StatusFooter.js";
import {
	addWakeAlias,
	beginRemoveSession,
	confirmRemoveSession,
	renameSession,
	type PendingRemoval,
} from "./actions.js";
import { useSessionStore } from "./hooks/useSessionStore.js";
import {
	buildPaneCompactRouteSlots,
	describeFocusedSessionSlots,
	ensureFocusedPath,
	findFocusedEntry,
	moveFocusedPath,
} from "./admin-state.js";

export type SessionManagerPaneProps = {
	initialCurrentSessionPath?: string;
	initialCurrentSessionName?: string;
};

function isEditableMode(mode: ActionMode): mode is Extract<ActionMode, { kind: "rename" | "alias" }> {
	return mode.kind === "rename" || mode.kind === "alias";
}

function getImmediateMessage(result: { ok: true } | { ok: false; error: string }, successMessage: string) {
	if (!result.ok) {
		return { message: result.error, tone: "error" as const };
	}
	return { message: successMessage, tone: "info" as const };
}

function applyCurrentSessionEvent(
	currentPath: string | undefined,
	currentName: string | undefined,
	event: SessionEvent,
): { currentSessionPath?: string; currentSessionName?: string } {
	if (!currentPath || event.payload.path !== currentPath) {
		return { currentSessionPath: currentPath, currentSessionName: currentName };
	}
	if (event.kind === "sess.rename" || event.kind === "sess.name") {
		return {
			currentSessionPath: currentPath,
			currentSessionName: typeof event.payload.to === "string"
				? event.payload.to
				: typeof event.payload.name === "string"
					? event.payload.name
					: currentName,
		};
	}
	if (event.kind === "sess.remove") {
		return {
			currentSessionPath: currentPath,
			currentSessionName: undefined,
		};
	}
	return { currentSessionPath: currentPath, currentSessionName: currentName };
}

export function SessionManagerPane({
	initialCurrentSessionPath,
	initialCurrentSessionName,
}: SessionManagerPaneProps) {
	const { exit } = useApp();
	const [currentSessionPath, setCurrentSessionPath] = useState(initialCurrentSessionPath);
	const [currentSessionName, setCurrentSessionName] = useState(initialCurrentSessionName);
	const dashboardOptions = useMemo(
		() => ({ currentSessionPath, currentSessionName }),
		[currentSessionName, currentSessionPath],
	);
	const { dashboard, toasts, recentEvents } = useSessionStore({ dashboardOptions });
	const [focusedPath, setFocusedPath] = useState<string | undefined>(() =>
		ensureFocusedPath(dashboard, initialCurrentSessionPath),
	);
	const [mode, setMode] = useState<ActionMode>({ kind: "idle" });
	const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | undefined>();
	const [message, setMessage] = useState<string | undefined>();
	const [messageTone, setMessageTone] = useState<"info" | "error" | undefined>();

	const focusedEntry = findFocusedEntry(dashboard, focusedPath);
	const compactSlots = useMemo(() => buildPaneCompactRouteSlots(dashboard), [dashboard]);
	const focusedCompactFamilies = useMemo(
		() => describeFocusedSessionSlots(focusedEntry, compactSlots),
		[compactSlots, focusedEntry],
	);

	useEffect(() => {
		setFocusedPath((previous) => ensureFocusedPath(dashboard, previous));
	}, [dashboard]);

	useEffect(() => {
		if (mode.kind === "idle") return;
		if (mode.kind === "remove-confirm") {
			if (!focusedEntry || focusedEntry.name !== mode.sessionName) {
				setPendingRemoval(undefined);
				setMode({ kind: "idle" });
			}
			return;
		}
		if (!focusedEntry || focusedEntry.name !== mode.sessionName) {
			setMode({ kind: "idle" });
		}
	}, [focusedEntry, mode]);

	useEffect(() => {
		if (!recentEvents || recentEvents.length === 0) return;
		let nextPath = currentSessionPath;
		let nextName = currentSessionName;
		for (const event of recentEvents) {
			const next = applyCurrentSessionEvent(nextPath, nextName, event);
			nextPath = next.currentSessionPath;
			nextName = next.currentSessionName;
		}
		if (nextPath !== currentSessionPath) setCurrentSessionPath(nextPath);
		if (nextName !== currentSessionName) setCurrentSessionName(nextName);
	}, [currentSessionName, currentSessionPath, recentEvents]);

	const setImmediateMessage = (nextMessage: string, tone: "info" | "error") => {
		setMessage(nextMessage);
		setMessageTone(tone);
	};

	const requireFocusedEntry = () => {
		if (!focusedEntry || !focusedEntry.path) {
			setImmediateMessage("No session is focused.", "error");
			return undefined;
		}
		return focusedEntry;
	};

	const submitRename = () => {
		if (mode.kind !== "rename") return;
		const entry = requireFocusedEntry();
		if (!entry) return;
		const result = renameSession({ sessionPath: entry.path!, newName: mode.draft });
		const feedback = getImmediateMessage(
			result,
			result.ok ? `Session renamed: ${result.from} → ${result.to}` : "",
		);
		if (result.ok && currentSessionPath === result.sessionPath) {
			setCurrentSessionName(result.to);
		}
		setImmediateMessage(feedback.message, feedback.tone);
		setMode({ kind: "idle" });
	};

	const submitAlias = () => {
		if (mode.kind !== "alias") return;
		const entry = requireFocusedEntry();
		if (!entry) return;
		const result = addWakeAlias({ sessionPath: entry.path!, alias: mode.draft });
		const suffix = result.ok && result.replacedAlias ? ` (replaced ${result.replacedAlias})` : "";
		const feedback = getImmediateMessage(
			result,
			result.ok ? `Wake alias set: ${result.alias} → ${result.sessionName}${suffix}` : "",
		);
		setImmediateMessage(feedback.message, feedback.tone);
		setMode({ kind: "idle" });
	};

	const beginRemove = () => {
		const entry = requireFocusedEntry();
		if (!entry) return;
		const result = beginRemoveSession({ sessionPath: entry.path! });
		if (!result.ok) {
			setImmediateMessage(result.error, "error");
			return;
		}
		setPendingRemoval(result);
		setMode({ kind: "remove-confirm", sessionName: result.sessionName });
		setImmediateMessage(`Press x again to remove ${result.sessionName}.`, "info");
	};

	const confirmRemove = () => {
		const entry = requireFocusedEntry();
		if (!entry) return;
		const result = confirmRemoveSession({
			pending: pendingRemoval,
			sessionPath: entry.path!,
		});
		if (!result.ok) {
			setImmediateMessage(result.error, "error");
			setPendingRemoval(undefined);
			setMode({ kind: "idle" });
			return;
		}
		if (currentSessionPath === result.sessionPath) {
			setCurrentSessionName(undefined);
		}
		setPendingRemoval(undefined);
		setMode({ kind: "idle" });
		setFocusedPath((previous) => (previous === result.sessionPath ? undefined : previous));
		const aliasText = result.removedAliases.length > 0
			? ` Cleared aliases: ${result.removedAliases.join(", ")}.`
			: "";
		setImmediateMessage(`Removed ${result.sessionName}.${aliasText}`.trim(), "info");
	};

	useInput((input, key) => {
		if ((key.ctrl && input === "c") || (key.escape && mode.kind === "idle")) {
			exit();
			return;
		}

		if (mode.kind === "remove-confirm") {
			if (input === "x") {
				confirmRemove();
				return;
			}
			setPendingRemoval(undefined);
			setMode({ kind: "idle" });
			setImmediateMessage(`Cancelled removal for ${mode.sessionName}.`, "info");
			return;
		}

		if (isEditableMode(mode)) {
			if (key.return) {
				if (mode.kind === "rename") submitRename();
				else submitAlias();
				return;
			}
			if (key.escape) {
				setMode({ kind: "idle" });
				setImmediateMessage(`Cancelled ${mode.kind}.`, "info");
				return;
			}
			if (key.backspace || key.delete) {
				setMode({ ...mode, draft: mode.draft.slice(0, -1) });
				return;
			}
			if (!key.ctrl && !key.meta && input.length > 0) {
				setMode({ ...mode, draft: `${mode.draft}${input}` });
			}
			return;
		}

		if (key.upArrow || input === "k") {
			setFocusedPath((previous) => moveFocusedPath(dashboard, previous, -1));
			return;
		}
		if (key.downArrow || input === "j") {
			setFocusedPath((previous) => moveFocusedPath(dashboard, previous, 1));
			return;
		}
		if (key.tab) {
			setFocusedPath((previous) => moveFocusedPath(dashboard, previous, key.shift ? -1 : 1));
			return;
		}

		if (input === "q") {
			exit();
			return;
		}
		if (input === "r") {
			const entry = requireFocusedEntry();
			if (!entry) return;
			setMode({ kind: "rename", sessionName: entry.name, draft: "" });
			setMessage(undefined);
			return;
		}
		if (input === "a") {
			const entry = requireFocusedEntry();
			if (!entry) return;
			setMode({ kind: "alias", sessionName: entry.name, draft: "" });
			setMessage(undefined);
			return;
		}
		if (input === "x") {
			beginRemove();
		}
	});

	return (
		<Box flexDirection="column">
			<Dashboard dashboard={dashboard} focusedPath={focusedEntry?.path} />
			<CompactRoutes slots={compactSlots} />
			<StatusFooter focusedEntry={focusedEntry} compactFamilies={focusedCompactFamilies} />
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>Use ↑/↓, tab, or j/k to move focus.</Text>
			</Box>
			<ActionBar mode={mode} message={message} messageTone={messageTone} />
			<ToastBand toasts={toasts} />
		</Box>
	);
}

export default SessionManagerPane;
