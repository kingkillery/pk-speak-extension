export interface RealtimeControlMessage {
	type: "start" | "interrupt" | "text" | "transcript" | "text_reply" | "tool_start" | "tool_complete" | "tool_approval_required" | "tool_approval_resolved" | "terminal_approve" | "terminal_reject" | "error" | "reconnect" | "vad_state";
	text?: string;
	session?: string;
	approvalId?: string;
	name?: string;
	command?: string;
	cwd?: string;
	reason?: string;
	timeoutMs?: number;
	output?: string;
	message?: string;
	clientSequenceId?: number;
	serverSequenceId?: number;
	vadThreshold?: number;
}

export type RealtimeMessage = Buffer | string;
