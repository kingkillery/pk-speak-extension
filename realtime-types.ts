export type RealtimeControlType =
	| "start"
	| "configure"
	| "interrupt"
	| "text"
	| "transcript"
	| "transcript_complete"
	| "text_reply"
	| "tool_start"
	| "tool_complete"
	| "tool_approval_required"
	| "tool_approval_resolved"
	| "terminal_approve"
	| "terminal_reject"
	| "command_approve"
	| "command_reject"
	| "error"
	| "reconnect"
	| "vad_state"
	| "reconnecting"
	| "image"
	| "camera_capture"
	| "camera_frame"
	| "live_state"
	| "audio_format"
	| "voice_metric";

export interface RealtimeControlMessage {
	type: RealtimeControlType;
	text?: string;
	role?: "user" | "assistant";
	session?: string;
	reconnectToken?: string;
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
	/** Base64 image payload (no data: prefix) for camera_frame / image. */
	data?: string;
	mimeType?: string;
	/** Correlates camera_capture ↔ camera_frame with a pending tool call. */
	callId?: string;
	/** Assistant/live UI state hint (listening | processing | ai-speaking | …). */
	state?: string;
	/** Output PCM sample rate announced once per session. */
	rate?: number;
	timeLeft?: string;
	/** Opt-in realtime latency instrumentation fields. */
	voiceMetricsEnabled?: boolean;
	event?: "speech_end" | "upstream_timing";
	turnId?: number;
	clientTimeMs?: number;
	lastPcmSentUpstreamMs?: number;
	firstUpstreamEventMs?: number;
	provider?: string;
	model?: string;
}

export type RealtimeMessage = Buffer | string;
