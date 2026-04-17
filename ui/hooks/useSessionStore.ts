import { useEffect, useRef, useState } from "react";
import { existsSync, statSync } from "node:fs";
import {
	getSessionEventsPath,
	tailSessionEvents,
	type SessionEvent,
	type SessionEventSource,
} from "../../session-events.js";
import { getSessionRoutingStorePath } from "../../session-routing-store.js";
import type { SessionDashboard, SessionRuntimeSnapshot } from "../../session-routing.js";
import {
	loadSessionDashboard,
	type LoadSessionDashboardOptions,
} from "../selectors.js";

export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_TOAST_TTL_MS = 3000;

export type Toast = {
	id: string;
	kind: string;
	source: SessionEventSource;
	message: string;
	ts: number;
	expiresAt: number;
};

export type SessionStoreState = {
	dashboard: SessionDashboard;
	toasts: Toast[];
	recentEvents: SessionEvent[];
	storeMtime: number;
	eventOffset: number;
};

export type UseSessionStoreOptions = {
	pollIntervalMs?: number;
	toastTtlMs?: number;
	dashboardOptions?: LoadSessionDashboardOptions;
	runtimeSnapshotProvider?: () => SessionRuntimeSnapshot[] | undefined;
	now?: () => number;
};

export function getFileMtime(path: string): number {
	if (!existsSync(path)) return 0;
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

export function getRoutingStoreMtime(storePath?: string): number {
	return getFileMtime(storePath ?? getSessionRoutingStorePath());
}

export function getEventLogMtime(): number {
	return getFileMtime(getSessionEventsPath());
}

function shortPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "";
	const parts = value.split(/[\\/]/);
	return parts[parts.length - 1] || value;
}

function payloadString(payload: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const raw = payload[key];
		if (typeof raw === "string" && raw.length > 0) return raw;
	}
	return "";
}

export function formatEventMessage(event: SessionEvent): string {
	const { kind, payload } = event;
	const name = payloadString(payload, "name", "session", "to");
	const alias = payloadString(payload, "alias");
	const from = payloadString(payload, "from");
	const to = payloadString(payload, "to");
	const target = name || shortPath(payload.path);
	switch (kind) {
		case "sess.new":
			return target ? `new session ${target}` : "new session";
		case "sess.switch":
			return target ? `switch to ${target}` : "switch session";
		case "sess.rename":
			if (from && to) return `rename ${from} -> ${to}`;
			return target ? `rename ${target}` : "rename session";
		case "sess.remove":
			return target ? `remove ${target}` : "remove session";
		case "sess.name":
			return target ? `name ${target}` : "name session";
		case "alias.add":
			if (alias && target) return `alias ${alias} -> ${target}`;
			if (alias) return `alias ${alias}`;
			return "alias set";
		case "alias.remove":
			if (alias) return `alias clear ${alias}`;
			return "alias clear";
		default:
			return target ? `${kind} ${target}` : kind;
	}
}

export function eventToToast(event: SessionEvent, now: number, ttlMs: number): Toast {
	return {
		id: `${event.ts}-${event.kind}-${now}-${Math.random().toString(36).slice(2, 8)}`,
		kind: event.kind,
		source: event.source,
		message: formatEventMessage(event),
		ts: event.ts,
		expiresAt: now + ttlMs,
	};
}

export function filterActiveToasts(toasts: Toast[], now: number): Toast[] {
	return toasts.filter((toast) => toast.expiresAt > now);
}

export function toastsFromEvents(
	events: SessionEvent[],
	now: number,
	ttlMs: number,
): Toast[] {
	const toasts: Toast[] = [];
	for (const event of events) {
		if (event.source === "command") continue;
		toasts.push(eventToToast(event, now, ttlMs));
	}
	return toasts;
}

export type PollTick = {
	dashboard?: SessionDashboard;
	storeMtime: number;
	eventOffset: number;
	toasts: Toast[];
	newEvents: SessionEvent[];
};

export type PollTickInput = {
	previousStoreMtime: number;
	previousEventOffset: number;
	previousToasts: Toast[];
	dashboardOptions?: LoadSessionDashboardOptions;
	now: number;
	toastTtlMs: number;
};

export function pollTick(input: PollTickInput): PollTick {
	const storeMtime = getRoutingStoreMtime(input.dashboardOptions?.storePath);
	const storeChanged = storeMtime !== input.previousStoreMtime;
	const dashboard = storeChanged
		? loadSessionDashboard(input.dashboardOptions)
		: undefined;

	const tail = tailSessionEvents(input.previousEventOffset);
	const newToasts = toastsFromEvents(tail.events, input.now, input.toastTtlMs);
	const surviving = filterActiveToasts(input.previousToasts, input.now);
	const mergedToasts = [...surviving, ...newToasts];

	return {
		dashboard,
		storeMtime,
		eventOffset: tail.nextOffset,
		toasts: mergedToasts,
		newEvents: tail.events,
	};
}

export function useSessionStore(options: UseSessionStoreOptions = {}): {
	dashboard: SessionDashboard;
	toasts: Toast[];
	recentEvents: SessionEvent[];
} {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const toastTtlMs = options.toastTtlMs ?? DEFAULT_TOAST_TTL_MS;
	const now = options.now ?? (() => Date.now());

	const initialMtime = useRef(getRoutingStoreMtime(options.dashboardOptions?.storePath));
	const initialEventOffset = useRef(tailSessionEvents(0).nextOffset);
	const [state, setState] = useState<SessionStoreState>(() => ({
		dashboard: loadSessionDashboard(options.dashboardOptions),
		toasts: [],
		recentEvents: [],
		storeMtime: initialMtime.current,
		eventOffset: initialEventOffset.current,
	}));

	useEffect(() => {
		const id = setInterval(() => {
			setState((prev) => {
				const snapshotOverride = options.runtimeSnapshotProvider?.();
				const dashboardOptions: LoadSessionDashboardOptions = {
					...(options.dashboardOptions ?? {}),
					...(snapshotOverride !== undefined ? { runtimeSnapshots: snapshotOverride } : {}),
				};
				const tick = pollTick({
					previousStoreMtime: prev.storeMtime,
					previousEventOffset: prev.eventOffset,
					previousToasts: prev.toasts,
					dashboardOptions,
					now: now(),
					toastTtlMs,
				});
				return {
					dashboard: tick.dashboard ?? prev.dashboard,
					toasts: tick.toasts,
					recentEvents: tick.newEvents,
					storeMtime: tick.storeMtime,
					eventOffset: tick.eventOffset,
				};
			});
		}, pollIntervalMs);
		return () => clearInterval(id);
	}, [pollIntervalMs, toastTtlMs, options.dashboardOptions, options.runtimeSnapshotProvider, now]);

	return { dashboard: state.dashboard, toasts: state.toasts, recentEvents: state.recentEvents };
}
