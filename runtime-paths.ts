import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type CommandInvocation = {
	command: string;
	args: string[];
};

function trimEnv(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function getHome(env: NodeJS.ProcessEnv): string {
	return env.USERPROFILE || env.HOME || "";
}

function getRoamingPythonRoot(env: NodeJS.ProcessEnv): string | undefined {
	const home = getHome(env);
	if (!home) return undefined;
	return join(home, "AppData", "Roaming", "Python");
}

function getPythonVersionRank(name: string): number {
	const match = /^Python(\d+)$/i.exec(name);
	if (!match) return -1;
	return Number.parseInt(match[1], 10);
}

export function listUserSiteScriptCandidates(
	scriptFileName: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const root = getRoamingPythonRoot(env);
	if (!root || !existsSync(root)) return [];

	let entries: string[] = [];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => getPythonVersionRank(name) >= 0)
			.sort((left, right) => getPythonVersionRank(right) - getPythonVersionRank(left));
	} catch {
		return [];
	}

	const candidates: string[] = [];
	for (const entry of entries) {
		const candidate = join(root, entry, "Scripts", scriptFileName);
		if (existsSync(candidate)) candidates.push(candidate);
	}
	return candidates;
}

export function getPythonCommand(env: NodeJS.ProcessEnv = process.env): string {
	const configured = trimEnv(env.PI_SPEAK_PYTHON);
	if (configured) return configured;
	if (existsSync("C:/Python314/python.exe")) return "C:/Python314/python.exe";
	const home = getHome(env);
	if (home) {
		const localPy = join(home, "AppData", "Local", "Microsoft", "WindowsApps", "python3.exe");
		if (existsSync(localPy)) return localPy;
	}
	return process.platform === "win32" ? "python" : "python3";
}

function buildPythonScriptInvocation(
	pythonCommand: string,
	scriptPath: string,
	outputPath: string,
	voice: string,
): CommandInvocation {
	return {
		command: pythonCommand,
		args: [scriptPath, "--stdin", "-s", "-v", voice, "-o", outputPath],
	};
}

export function getSpeakInvocationFromEnv(
	outputPath: string,
	voice: string,
	env: NodeJS.ProcessEnv = process.env,
): CommandInvocation {
	const pythonCommand = getPythonCommand(env);
	const configuredSpeak11Path = trimEnv(env.PI_SPEAK_SPEAK11_PATH);
	if (configuredSpeak11Path) {
		if (/\.py$/i.test(configuredSpeak11Path)) {
			return buildPythonScriptInvocation(pythonCommand, configuredSpeak11Path, outputPath, voice);
		}
		if (/\.(cmd|bat)$/i.test(configuredSpeak11Path)) {
			return {
				command: "cmd.exe",
				args: ["/c", configuredSpeak11Path, "--stdin", "-s", "-v", voice, "-o", outputPath],
			};
		}
		return {
			command: configuredSpeak11Path,
			args: ["--stdin", "-s", "-v", voice, "-o", outputPath],
		};
	}

	const pythonScripts = listUserSiteScriptCandidates("speak11.py", env);
	if (pythonScripts.length > 0) {
		return buildPythonScriptInvocation(pythonCommand, pythonScripts[0], outputPath, voice);
	}

	const cmdScripts = [
		...listUserSiteScriptCandidates("speak11.cmd", env),
		...listUserSiteScriptCandidates("speak11.bat", env),
	];
	if (cmdScripts.length > 0) {
		return {
			command: "cmd.exe",
			args: ["/c", cmdScripts[0], "--stdin", "-s", "-v", voice, "-o", outputPath],
		};
	}

	return {
		command: process.platform === "win32" ? "cmd.exe" : "speak11",
		args: process.platform === "win32"
			? ["/c", "speak11", "--stdin", "-s", "-v", voice, "-o", outputPath]
			: ["--stdin", "-s", "-v", voice, "-o", outputPath],
	};
}
