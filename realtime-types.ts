export interface RealtimeControlMessage {
	type: "start" | "configure" | "interrupt" | "text" | "transcript" | "transcript_complete" | "text_reply" | "tool_start" | "tool_complete" | "tool_approval_required" | "tool_approval_resolved" | "terminal_approve" | "terminal_reject" | "command_approve" | "command_reject" | "error" | "reconnect" | "vad_state";
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
