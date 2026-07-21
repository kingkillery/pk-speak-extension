// @ts-check
/**
 * Pure helpers for desktop-orb Live approvals (no DOM).
 * Shared by orb.js and unit tests.
 */

/**
 * @param {Record<string, unknown>} message
 * @param {boolean} approved
 * @returns {"terminal_approve"|"terminal_reject"|"command_approve"|"command_reject"}
 */
export function approvalControlType(message, approved) {
	const name = typeof message?.name === "string" ? message.name : "";
	const reason = typeof message?.reason === "string" ? message.reason : "";
	if (name === "launch_agent" || name === "archive_session" || reason === "launch_agent" || reason === "archive_session") {
		return approved ? "command_approve" : "command_reject";
	}
	if (name === "execute_terminal_command" || reason === "requires_confirmation" || reason === "confirm" || reason === "allow") {
		return approved ? "terminal_approve" : "terminal_reject";
	}
	// Default command path for unknown mutating tools.
	return approved ? "command_approve" : "command_reject";
}

/**
 * @param {Record<string, unknown>} message
 * @returns {{
 *   approvalId: string,
 *   name: string,
 *   command: string,
 *   reason: string,
 *   cwd: string,
 *   timeoutMs: number,
 *   message: string,
 * } | null}
 */
export function normalizeApproval(message) {
	if (!message || typeof message.approvalId !== "string" || !message.approvalId) return null;
	/** @type {Record<string, unknown>} */
	let parsed = {};
	if (typeof message.output === "string" && message.output) {
		try {
			const value = JSON.parse(message.output);
			if (value && typeof value === "object") parsed = value;
		} catch {
			parsed = {};
		}
	}
	return {
		approvalId: message.approvalId,
		name: typeof message.name === "string" ? message.name : "",
		command: typeof message.command === "string" ? message.command : (typeof parsed.command === "string" ? parsed.command : ""),
		reason: typeof message.reason === "string" ? message.reason : (typeof parsed.reason === "string" ? parsed.reason : ""),
		cwd: typeof message.cwd === "string" ? message.cwd : (typeof parsed.cwd === "string" ? parsed.cwd : ""),
		timeoutMs: typeof message.timeoutMs === "number" ? message.timeoutMs : (typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : 0),
		message: typeof message.message === "string" ? message.message : "",
	};
}
