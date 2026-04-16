import { normalizeVoiceRouteKey } from "./voice-routing.js";

export type VoiceSlashCommandMatch = {
	kind: "slash-command";
	command: string;
};

export type VoiceBridgePromptMatch = {
	kind: "bridge-prompt";
	prompt: string;
};

function hasExactMatch(text: string, values: string[]) {
	return values.includes(text);
}

function matchPrefixedValue(text: string, prefixes: string[]) {
	for (const prefix of prefixes) {
		if (text.startsWith(prefix)) {
			const value = text.slice(prefix.length).trim();
			if (value) return value;
		}
	}
	return undefined;
}

export function parseVoiceSlashCommand(text: string): VoiceSlashCommandMatch | undefined {
	const normalized = normalizeVoiceRouteKey(text);
	if (!normalized) return undefined;

	const newSessionName = matchPrefixedValue(normalized, ["new session ", "create session "]);
	if (newSessionName) return { kind: "slash-command", command: `/sess new ${newSessionName}` };

	const switchTarget = matchPrefixedValue(normalized, [
		"switch to session ",
		"switch session ",
		"go to session ",
	]);
	if (switchTarget) return { kind: "slash-command", command: `/sess switch ${switchTarget}` };

	const removeTarget = matchPrefixedValue(normalized, ["remove session ", "delete session "]);
	if (removeTarget) return { kind: "slash-command", command: `/sess remove ${removeTarget}` };

	const sessionName = matchPrefixedValue(normalized, [
		"name this session ",
		"rename this session ",
		"call this session ",
	]);
	if (sessionName) return { kind: "slash-command", command: `/sess name ${sessionName}` };

	if (hasExactMatch(normalized, ["list sessions", "show sessions", "show my sessions", "what sessions do i have"])) {
		return { kind: "slash-command", command: "/sess" };
	}

	if (hasExactMatch(normalized, [
		"current session",
		"what session am i in",
		"what is my current session",
		"whats my current session",
	])) {
		return { kind: "slash-command", command: "/sess" };
	}

	if (hasExactMatch(normalized, [
		"list wake aliases",
		"show wake aliases",
		"show my wake aliases",
		"what wake aliases do i have",
	])) {
		return { kind: "slash-command", command: "/sess" };
	}

	const clearWakeAlias = matchPrefixedValue(normalized, [
		"clear wake alias ",
		"remove wake alias ",
		"delete wake alias ",
	]);
	if (clearWakeAlias) return { kind: "slash-command", command: `/sess wake clear ${clearWakeAlias}` };

	const wakeAlias = matchPrefixedValue(normalized, ["set wake alias ", "wake alias ", "alias this session "]);
	if (wakeAlias) return { kind: "slash-command", command: `/sess wake ${wakeAlias}` };

	if (hasExactMatch(normalized, ["export sessions", "show session store", "show session routing store"])) {
		return { kind: "slash-command", command: "/sess export" };
	}

	if (hasExactMatch(normalized, [
		"what s ready",
		"whats ready",
		"what is ready",
		"which sessions are ready",
		"list ready sessions",
	])) {
		return { kind: "slash-command", command: "/sess" };
	}

	if (hasExactMatch(normalized, ["attention status", "session attention status"])) {
		return { kind: "slash-command", command: "/attn status" };
	}

	const clearAttention = matchPrefixedValue(normalized, ["clear attention for ", "clear ready state for "]);
	if (clearAttention) return { kind: "slash-command", command: `/attn clear ${clearAttention}` };

	return undefined;
}

function buildSkillBridgePrompt(skillName: string, task?: string) {
	const lines = [
		`Use the installed skill "${skillName}" if it exists and is relevant. Follow that skill's instructions before acting.`,
	];
	if (task) lines.push(`User request: ${task}`);
	return lines.join("\n\n");
}

function buildAutoSkillBridgePrompt(task: string) {
	return [
		"Find and use the best matching installed skill for this request. Follow that skill before acting.",
		"If the request is about improving a prompt, instructions, skills, or workflow behavior, use the most relevant improvement workflow as needed.",
		`User request: ${task}`,
	].join("\n\n");
}

export function parseVoiceBridgePrompt(text: string): VoiceBridgePromptMatch | undefined {
	const normalized = normalizeVoiceRouteKey(text);
	if (!normalized) return undefined;

	const explicitSkillMatch = normalized.match(/^(?:use|run|bridge to) (?:the )?(.+?) skill (?:for|on) (.+)$/);
	if (explicitSkillMatch) {
		const [, skillName, task] = explicitSkillMatch;
		return { kind: "bridge-prompt", prompt: buildSkillBridgePrompt(skillName.trim(), task.trim()) };
	}

	const explicitSkillOnlyMatch = normalized.match(/^(?:use|run|bridge to) (?:the )?(.+?) skill$/);
	if (explicitSkillOnlyMatch) {
		const [, skillName] = explicitSkillOnlyMatch;
		return { kind: "bridge-prompt", prompt: buildSkillBridgePrompt(skillName.trim()) };
	}

	const autoSkillMatch = normalized.match(
		/^(?:pick|find|use|route|bridge) (?:this to )?(?:the )?(?:right|best|best matching) skill (?:for|on) (.+)$/,
	);
	if (autoSkillMatch) {
		const [, task] = autoSkillMatch;
		return { kind: "bridge-prompt", prompt: buildAutoSkillBridgePrompt(task.trim()) };
	}

	return undefined;
}

export function shouldBlockCrossSessionVoiceRoute(options: {
	currentSessionPath?: string;
	targetSessionPath: string;
	idle: boolean;
}) {
	if (options.idle) return false;
	if (!options.currentSessionPath) return true;
	return options.currentSessionPath !== options.targetSessionPath;
}
