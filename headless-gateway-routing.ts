import { normalizeRunnableAgentProviderName, type RunnableAgentProviderName } from "./agent-provider-registry.js";

export type GatewayProviderOverride = RunnableAgentProviderName;

export type ResumedGatewayTarget = {
	target: string;
	provider: GatewayProviderOverride;
	sessionId: string;
	sessionPath: string;
	cwd?: string;
	title?: string;
	launchedAt: number;
};

export function normalizeGatewayProviderOverride(value: string | undefined): GatewayProviderOverride | undefined {
	return normalizeRunnableAgentProviderName(value);
}

export function buildResumeRouteTarget(input: {
	provider: string;
	sessionId?: string;
	sessionPath: string;
	title?: string;
	cwd?: string;
	cwdBasename?: string;
	now?: number;
}): ResumedGatewayTarget | undefined {
	const provider = normalizeGatewayProviderOverride(input.provider);
	const sessionId = input.sessionId?.trim();
	const sessionPath = input.sessionPath.trim();
	if (!provider || !sessionId || !sessionPath) return undefined;
	const label = input.title?.trim() || input.cwdBasename?.trim() || sessionId.slice(0, 8);
	return {
		target: `${provider}:resume:${sessionId}${label ? ` ${label}` : ""}`,
		provider,
		sessionId,
		sessionPath,
		cwd: input.cwd?.trim() || undefined,
		title: input.title?.trim() || undefined,
		launchedAt: input.now ?? Date.now(),
	};
}

export function resolveRequestedRouteTarget(input: {
	requestedTarget?: string;
	defaultTarget?: string;
	resumedTargets: Map<string, ResumedGatewayTarget>;
}): ResumedGatewayTarget | undefined {
	const requested = input.requestedTarget?.trim();
	if (requested && input.resumedTargets.has(requested)) return input.resumedTargets.get(requested);
	const current = input.defaultTarget?.trim();
	if (current && input.resumedTargets.has(current)) return input.resumedTargets.get(current);
	return undefined;
}
