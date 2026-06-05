export interface RealtimeControlMessage {
	type: "start" | "interrupt" | "text" | "transcript" | "text_reply" | "tool_start" | "tool_complete" | "error";
	text?: string;
	session?: string;
	name?: string;
	command?: string;
	output?: string;
	message?: string;
}

export type RealtimeMessage = Buffer | string;
