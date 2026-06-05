export interface RealtimeControlMessage {
	type: "start" | "interrupt" | "text" | "transcript" | "text_reply" | "tool_start" | "tool_complete" | "error" | "reconnect" | "vad_state";
	text?: string;
	session?: string;
	name?: string;
	command?: string;
	output?: string;
	message?: string;
	clientSequenceId?: number;
	serverSequenceId?: number;
	vadThreshold?: number;
}

export type RealtimeMessage = Buffer | string;
