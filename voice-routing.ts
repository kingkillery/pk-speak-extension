export type SessionRouteMatch = {
	sessionName: string;
	sessionPath: string;
	matchedBy: "exact" | "numeric-family";
};

export type SessionTargetMatch = {
	sessionPath: string;
	matchedLabel: string;
	matchedBy: "name" | "alias";
};

const SPEECH_INTERRUPT_COMMANDS = new Set([
	"stop",
	"stop speaking",
	"be quiet",
	"shut up",
	"shush",
	"quiet",
]);

export type SessionRouteConflict = {
	sessionName: string;
	sessionPath: string;
	reason: "exact" | "numeric-family";
	family?: "1" | "2";
};

const NUMERIC_ROUTE_FAMILIES: Record<string, "1" | "2"> = {
	"1": "1",
	one: "1",
	"2": "2",
	two: "2",
};

export function normalizeVoiceRouteKey(value: string) {
	return value
		.toLowerCase()
		.replace(/\./g, " ")
		.replace(/[^a-z0-9_\-\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function findNormalizedKey(target: string, values: Iterable<string>) {
	const normalizedTarget = normalizeVoiceRouteKey(target);
	if (!normalizedTarget) return undefined;
	for (const value of values) {
		if (normalizeVoiceRouteKey(value) === normalizedTarget) {
			return value;
		}
	}
	return undefined;
}

export function isSpeechInterruptCommand(text: string) {
	return SPEECH_INTERRUPT_COMMANDS.has(normalizeVoiceRouteKey(text));
}

export function resolveSessionTarget(
	target: string,
	sessions: Record<string, string>,
	aliases: Record<string, string> = {},
): SessionTargetMatch | undefined {
	const matchedName = findNormalizedKey(target, Object.keys(sessions));
	if (matchedName) {
		return { sessionPath: sessions[matchedName], matchedLabel: matchedName, matchedBy: "name" };
	}
	const matchedAlias = findNormalizedKey(target, Object.keys(aliases));
	if (matchedAlias) {
		return { sessionPath: aliases[matchedAlias], matchedLabel: matchedAlias, matchedBy: "alias" };
	}

	const targetFamily = getNumericRouteFamily(target);
	if (!targetFamily) return undefined;

	let familyMatch: SessionTargetMatch | undefined;
	for (const [label, sessionPath] of Object.entries(aliases)) {
		if (getNumericRouteFamily(label) !== targetFamily) continue;
		if (!familyMatch) {
			familyMatch = { sessionPath, matchedLabel: label, matchedBy: "alias" };
			continue;
		}
		if (familyMatch.sessionPath !== sessionPath) return undefined;
	}
	if (familyMatch) return familyMatch;

	for (const [label, sessionPath] of Object.entries(sessions)) {
		if (getNumericRouteFamily(label) !== targetFamily) continue;
		if (!familyMatch) {
			familyMatch = { sessionPath, matchedLabel: label, matchedBy: "name" };
			continue;
		}
		if (familyMatch.sessionPath !== sessionPath) return undefined;
	}
	return familyMatch;
}

export function listKnownTargets(sessions: Record<string, string>, aliases: Record<string, string> = {}) {
	const names = new Set<string>();
	for (const name of Object.keys(sessions)) names.add(name);
	for (const alias of Object.keys(aliases)) names.add(alias);
	return [...names].sort((a, b) => a.localeCompare(b));
}

export function getNumericRouteFamily(value: string): "1" | "2" | undefined {
	const normalized = normalizeVoiceRouteKey(value);
	if (!normalized || normalized.includes(" ")) return undefined;
	return NUMERIC_ROUTE_FAMILIES[normalized];
}

export function resolveSessionRoute(
	target: string,
	sessions: Record<string, string>,
): SessionRouteMatch | undefined {
	const normalizedTarget = normalizeVoiceRouteKey(target);
	if (!normalizedTarget) return undefined;

	for (const [sessionName, sessionPath] of Object.entries(sessions)) {
		if (normalizeVoiceRouteKey(sessionName) === normalizedTarget) {
			return { sessionName, sessionPath, matchedBy: "exact" };
		}
	}

	const targetFamily = getNumericRouteFamily(normalizedTarget);
	if (!targetFamily) return undefined;

	let found: SessionRouteMatch | undefined;
	for (const [sessionName, sessionPath] of Object.entries(sessions)) {
		if (getNumericRouteFamily(sessionName) !== targetFamily) continue;
		if (!found) {
			found = { sessionName, sessionPath, matchedBy: "numeric-family" };
			continue;
		}
		if (found.sessionPath !== sessionPath) {
			return undefined;
		}
	}

	return found;
}

export function findSessionRouteConflict(
	targetName: string,
	sessions: Record<string, string>,
	ownSessionPath?: string,
): SessionRouteConflict | undefined {
	const normalizedTarget = normalizeVoiceRouteKey(targetName);
	if (!normalizedTarget) return undefined;
	const targetFamily = getNumericRouteFamily(normalizedTarget);

	for (const [sessionName, sessionPath] of Object.entries(sessions)) {
		if (ownSessionPath && sessionPath === ownSessionPath) continue;
		const normalizedExisting = normalizeVoiceRouteKey(sessionName);
		if (normalizedExisting === normalizedTarget) {
			return { sessionName, sessionPath, reason: "exact" };
		}
		if (targetFamily && getNumericRouteFamily(normalizedExisting) === targetFamily) {
			return { sessionName, sessionPath, reason: "numeric-family", family: targetFamily };
		}
	}

	return undefined;
}
