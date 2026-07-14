import { resolve } from "node:path";
import type { ControlActionResult, HubPublishPayload, HubResumePayload } from "./control-server.js";

interface BuiltinCommandResult {
	handled: boolean;
	output: string[];
	prompt?: string;
	busy?: boolean;
}

export interface HubOwnerContext {
	cwd: string;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	sessionManager: {
		getSessionFile(): string | undefined;
	};
	executeBuiltinCommand?: (command: string) => Promise<BuiltinCommandResult>;
}

const activeHubOwners = new WeakSet<object>();

export async function publishOwnerHubSession(
	ctx: HubOwnerContext | undefined,
	payload: HubPublishPayload,
): Promise<ControlActionResult> {
	const unavailable = validateOwnerContext(ctx, payload.cwd);
	if (unavailable) return unavailable;
	const owner = ctx as HubOwnerContext;
	const activePath = owner.sessionManager.getSessionFile();
	if (!activePath || normalizePath(activePath) !== normalizePath(payload.sessionPath)) {
		return {
			ok: false,
			status: 409,
			message: "The requested session is not owned by this OMP process.",
		};
	}
	return runOwnerHubOperation(owner, async () => {
		const result = await owner.executeBuiltinCommand?.("/hub publish");
		if (result?.busy) return { ok: false, status: 409, message: "The owning OMP session is busy." };
		const parsed = result ? parseHubPublishOutput(result.output) : undefined;
		if (!result?.handled || result.prompt || !parsed) {
			return { ok: false, status: 502, message: "OMP Hub publish failed." };
		}
		return {
			ok: true,
			message: "Published encrypted OMP Hub snapshot.",
			sessionPath: activePath,
			link: parsed.link,
			hubId: parsed.hubId,
			devices: parsed.devices,
		};
	});
}

export async function resumeOwnerHubSession(
	ctx: HubOwnerContext | undefined,
	payload: HubResumePayload,
): Promise<ControlActionResult> {
	const unavailable = validateOwnerContext(ctx, payload.cwd);
	if (unavailable) return unavailable;
	const owner = ctx as HubOwnerContext;
	return runOwnerHubOperation(owner, async () => {
		const result = await owner.executeBuiltinCommand?.(`/hub resume ${payload.link}`);
		if (result?.busy) return { ok: false, status: 409, message: "The owning OMP session is busy." };
		const parsed = result ? parseHubResumeOutput(result.output) : undefined;
		const sessionPath = owner.sessionManager.getSessionFile();
		if (!result?.handled || result.prompt || !parsed || !sessionPath) {
			return { ok: false, status: 502, message: "OMP Hub resume failed." };
		}
		return {
			ok: true,
			message: "Resumed encrypted OMP Hub into a local session.",
			sessionPath,
			entryCount: parsed.entryCount,
			devices: parsed.devices,
		};
	});
}

export function parseHubPublishOutput(output: readonly string[]): {
	link: string;
	hubId: string;
	devices: number;
} | undefined {
	const text = output.join("\n");
	const link = text.match(/^Hub link: (https:\/\/\S+)$/m)?.[1];
	const devicesText = text.match(/^Saved (\d+) device snapshot\(s\)\./m)?.[1];
	if (!link || devicesText === undefined) return undefined;
	try {
		const url = new URL(link);
		const hubId = url.pathname.split("/").filter(Boolean).at(-1);
		const devices = Number(devicesText);
		if (!hubId || !url.hash || !Number.isSafeInteger(devices) || devices < 0) return undefined;
		return { link, hubId, devices };
	} catch {
		return undefined;
	}
}

export function parseHubResumeOutput(output: readonly string[]): {
	entryCount: number;
	devices: number;
} | undefined {
	const match = output.join("\n").match(/^Resumed (\d+) hub entries from (\d+) device\(s\) into a local session fork\.$/m);
	if (!match) return undefined;
	const entryCount = Number(match[1]);
	const devices = Number(match[2]);
	if (!Number.isSafeInteger(entryCount) || !Number.isSafeInteger(devices)) return undefined;
	return { entryCount, devices };
}

async function runOwnerHubOperation(
	owner: HubOwnerContext,
	operation: () => Promise<ControlActionResult>,
): Promise<ControlActionResult> {
	const ownerIdentity = owner.sessionManager;
	if (activeHubOwners.has(ownerIdentity)) {
		return { ok: false, status: 409, message: "A Hub handoff is already running for this OMP session." };
	}
	activeHubOwners.add(ownerIdentity);
	try {
		return await operation();
	} finally {
		activeHubOwners.delete(ownerIdentity);
	}
}

function validateOwnerContext(ctx: HubOwnerContext | undefined, requestedCwd: string | undefined): ControlActionResult | undefined {
	if (!ctx?.executeBuiltinCommand) {
		return { ok: false, status: 501, message: "This gateway cannot reach an owning OMP session." };
	}
	if (!ctx.isIdle()) {
		return { ok: false, status: 409, message: "The owning OMP session is busy." };
	}
	if (requestedCwd && normalizePath(requestedCwd) !== normalizePath(ctx.cwd)) {
		return { ok: false, status: 409, message: "The requested working directory is not owned by this OMP process." };
	}
	if (ctx.hasPendingMessages()) {
		return { ok: false, status: 409, message: "The owning OMP session has queued work." };
	}
	return undefined;
}

function normalizePath(value: string): string {
	const normalized = resolve(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
