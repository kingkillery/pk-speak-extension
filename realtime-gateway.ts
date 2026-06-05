import { WebSocket } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import { createGeminiClient, getGeminiLiveModel } from "./gemini-live-turn.js";
import { readAttentionSnapshots, readAttentionLeaderLease, claimAttentionLeader } from "./attention-broker.js";
import { readSessionWorkingDirectory } from "./session-working-directory.js";
import { loadPersistedSessionRouting } from "./session-routing-store.js";
import { discoverAgentInventoryCached } from "./agent-discovery.js";
import { buildAgentResumeArgs, isResumableAgentSession } from "./agent-provider-registry.js";
import { resolveAgentProviderConfig } from "./agent-provider.js";
import { resolveWindowsNpmShim } from "./agent-discovery.js";
import { exec, spawn } from "node:child_process";
import type { RealtimeControlMessage } from "./realtime-types.js";

// Helper to resolve current cwd of the active session
function getCurrentCwd(): string {
	const lease = readAttentionLeaderLease();
	if (lease?.ownerSessionId) {
		const snapshots = readAttentionSnapshots();
		const activeSnapshot = snapshots.find(s => s.sessionId === lease.ownerSessionId);
		if (activeSnapshot?.sessionPath) {
			const cwd = readSessionWorkingDirectory(activeSnapshot.sessionPath);
			if (cwd) return cwd;
		}
	}
	const snapshots = readAttentionSnapshots();
	if (snapshots.length > 0 && snapshots[0].sessionPath) {
		const cwd = readSessionWorkingDirectory(snapshots[0].sessionPath);
		if (cwd) return cwd;
	}
	return process.cwd();
}

function resolveResumeExecutable(provider: string | undefined) {
	const normalized = provider?.trim().toLowerCase();
	if (normalized === "codex") {
		return resolveAgentProviderConfig(process.env).codexBin;
	}
	if (normalized === "claude") {
		return process.env.CLAUDE_BIN || resolveWindowsNpmShim("claude.cmd") || "claude";
	}
	return undefined;
}

function launchDetachedCli(command: string, args: string[], cwd: string, title: string) {
	if (process.platform === "win32") {
		const child = spawn("cmd.exe", ["/c", "start", title, "/D", cwd, command, ...args], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} else {
		const child = spawn(command, args, {
			cwd,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	}
}

interface ActiveSession {
	sessionId: string;
	ws: WebSocket;
	session: any; // Gemini Live session
	clientSequenceId: number; // last processed client sequence ID
	serverSequenceId: number; // last assigned server sequence ID
	disconnectTimeout?: NodeJS.Timeout;
	pendingServerMessages: { seqId: number; isBinary: boolean; data: any }[];
	server: any; // store server reference
}

export const activeSessions = new Map<string, ActiveSession>();

export function sendToClient(activeSession: ActiveSession, message: any, isBinary: boolean) {
	const seqId = ++activeSession.serverSequenceId;
	let payload: any;
	if (isBinary) {
		// message is a Buffer containing raw audio.
		// prefix with 4-byte big-endian serverSequenceId.
		payload = Buffer.alloc(4 + message.length);
		payload.writeInt32BE(seqId, 0);
		message.copy(payload, 4);
	} else {
		// message is a JSON object.
		// add serverSequenceId to the object.
		payload = JSON.stringify({
			...message,
			serverSequenceId: seqId
		});
	}

	try {
		if (activeSession.ws.readyState === WebSocket.OPEN) {
			activeSession.ws.send(payload);
		} else {
			activeSession.pendingServerMessages.push({ seqId, isBinary, data: payload });
			if (activeSession.pendingServerMessages.length > 500) {
				activeSession.pendingServerMessages.shift();
			}
		}
	} catch (err) {
		activeSession.pendingServerMessages.push({ seqId, isBinary, data: payload });
		if (activeSession.pendingServerMessages.length > 500) {
			activeSession.pendingServerMessages.shift();
		}
	}
}

function flushPendingServerMessages(activeSession: ActiveSession, lastReceivedServerSequenceId: number) {
	const toSend = activeSession.pendingServerMessages.filter(m => m.seqId > lastReceivedServerSequenceId);
	toSend.sort((a, b) => a.seqId - b.seqId);
	for (const msg of toSend) {
		try {
			if (activeSession.ws.readyState === WebSocket.OPEN) {
				activeSession.ws.send(msg.data);
			}
		} catch (err) {
			// Stop flushing if websocket has issues again
			break;
		}
	}
	activeSession.pendingServerMessages = activeSession.pendingServerMessages.filter(m => m.seqId > lastReceivedServerSequenceId);
}

function setupSocketHandlers(activeSession: ActiveSession) {
	const ws = activeSession.ws;
	
	ws.on("message", (rawMsg, isBinary) => {
		try {
			if (isBinary) {
				// Binary message is [4 bytes sequence ID] [raw PCM audio frame] from client
				if (rawMsg.length >= 4) {
					const seqId = rawMsg.readInt32BE(0);
					if (seqId <= activeSession.clientSequenceId) {
						// Deduplicate / Discard
						return;
					}
					activeSession.clientSequenceId = seqId;
					const audioBuf = rawMsg.subarray(4);
					if (activeSession.session) {
						activeSession.session.sendRealtimeInput({
							media: {
								mimeType: "audio/pcm;rate=16000",
								data: audioBuf.toString("base64"),
							}
						});
					}
				}
			} else {
				// Text message is JSON stringified control event
				const textMsg = rawMsg.toString("utf8");
				const ctrl = JSON.parse(textMsg) as RealtimeControlMessage;
				
				if (ctrl.clientSequenceId !== undefined) {
					activeSession.clientSequenceId = Math.max(activeSession.clientSequenceId, ctrl.clientSequenceId);
				}

				if (ctrl.type === "interrupt") {
					// Barge-in / Interrupt from client
					if (activeSession.session) {
						activeSession.session.sendRealtimeInput({ activityStart: {} });
					}
					// Echo interrupt back to client to clear buffers immediately
					sendToClient(activeSession, { type: "interrupt" }, false);
				} else if (ctrl.type === "text" && ctrl.text) {
					// Text turn from client
					if (activeSession.session) {
						activeSession.session.sendClientContent({
							turns: [{ role: "user", parts: [{ text: ctrl.text }] }],
							turnComplete: true,
						});
					}
				}
			}
		} catch (err: any) {
			sendToClient(activeSession, {
				type: "error",
				message: `Error processing message: ${err.message}`,
			}, false);
		}
	});

	ws.on("close", () => {
		activeSession.disconnectTimeout = setTimeout(() => {
			try {
				activeSession.session?.close();
			} catch {}
			activeSessions.delete(activeSession.sessionId);
		}, 60000); // 60 seconds timeout
	});
}

async function startNewSession(ws: WebSocket, server: any, firstMsg?: any, firstMsgIsBinary?: boolean) {
	const sessionId = "sess_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
	
	const activeSession: ActiveSession = {
		sessionId,
		ws,
		session: null,
		clientSequenceId: 0,
		serverSequenceId: 0,
		pendingServerMessages: [],
		server
	};
	activeSessions.set(sessionId, activeSession);

	// Send start message with sessionId. We want this to be serverSequenceId = 1.
	sendToClient(activeSession, {
		type: "start",
		session: sessionId
	}, false);

	const model = getGeminiLiveModel();
	const clientConfig = createGeminiClient(process.env, { live: true });
	const ai = clientConfig.ai;

	// Tool definitions
	const tools = [
		{
			functionDeclarations: [
				{
					name: "execute_terminal_command",
					description: "Executes a shell command in the local workspace directory, returning the stdout, stderr, and exit code.",
					parameters: {
						type: "OBJECT",
						properties: {
							command: {
								type: "STRING",
								description: "The exact shell command to execute."
							}
						},
						required: ["command"]
					}
				},
				{
					name: "switch_session",
					description: "Resumes or switches the active workspace session to the specified session name, alias, or path.",
					parameters: {
						type: "OBJECT",
						properties: {
							name: {
								type: "STRING",
								description: "The name, alias, or session path to switch to."
							}
						},
						required: ["name"]
					}
				},
				{
					name: "get_session_info",
					description: "Gets information about the active session, available sessions, running session snapshots, and current working directory.",
					parameters: {
						type: "OBJECT",
						properties: {}
					}
				}
			]
		}
	];

	try {
		const geminiSession = await ai.live.connect({
			model,
			config: {
				responseModalities: [Modality.AUDIO],
				outputAudioTranscription: {},
				systemInstruction: process.env.PI_SPEAK_GEMINI_SYSTEM_PROMPT || "You are a concise voice coding assistant.",
				tools: tools as any,
			},
			callbacks: {
				onopen: () => {
					// Connection opened
				},
				onmessage: async (message: LiveServerMessage) => {
					// 1. Forward raw audio chunk
					for (const part of message.serverContent?.modelTurn?.parts || []) {
						if (part.inlineData?.data) {
							const audioBuf = Buffer.from(part.inlineData.data, "base64");
							sendToClient(activeSession, audioBuf, true);
						}
					}

					// 2. Forward transcript text updates
					const text = extractText(message);
					if (text) {
						sendToClient(activeSession, {
							type: "transcript",
							text,
						}, false);
					}

					// 3. Handle model interruption/barge-in signal from server
					if (message.serverContent?.interrupted) {
						sendToClient(activeSession, {
							type: "interrupt"
						}, false);
					}

					// 4. Handle Tool calls
					if (message.toolCall?.functionCalls) {
						for (const call of message.toolCall.functionCalls) {
							if (!call.name || !call.id) continue;
							
							// Send tool_start event
							sendToClient(activeSession, {
								type: "tool_start",
								name: call.name,
								command: call.args?.command as string || undefined,
							}, false);

							let outputText = "";
							try {
								if (call.name === "execute_terminal_command") {
									const command = call.args?.command as string;
									if (!command) {
										outputText = JSON.stringify({ ok: false, error: "Missing 'command' argument" });
									} else {
										const cwd = getCurrentCwd();
										const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
											exec(command, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
												resolve({
													stdout,
													stderr,
													code: error?.code ?? 0,
												});
											});
										});
										outputText = JSON.stringify({
											ok: result.code === 0,
											code: result.code,
											stdout: result.stdout,
											stderr: result.stderr,
										});
									}
								} else if (call.name === "switch_session") {
									const name = call.args?.name as string;
									if (!name) {
										outputText = JSON.stringify({ ok: false, error: "Missing 'name' argument" });
									} else {
										const persisted = loadPersistedSessionRouting();
										
										// Find matching sessionPath
										let matchedPath: string | undefined;
										let matchedName: string | undefined;
										
										// 1. Match directly by name in registry
										for (const [sName, sPath] of Object.entries(persisted.sessions)) {
											if (sName.toLowerCase() === name.toLowerCase()) {
												matchedPath = sPath;
												matchedName = sName;
												break;
											}
										}
										// 2. Match by alias
										if (!matchedPath) {
											for (const [alias, sPath] of Object.entries(persisted.aliases)) {
												if (alias.toLowerCase() === name.toLowerCase()) {
													matchedPath = sPath;
													matchedName = findSessionNameByPath(sPath, persisted.sessions) || alias;
													break;
												}
											}
										}
										// 3. Match by path substring or exact path
										if (!matchedPath) {
											for (const sPath of Object.values(persisted.sessions)) {
												if (sPath.toLowerCase() === name.toLowerCase() || sPath.toLowerCase().includes(name.toLowerCase())) {
													matchedPath = sPath;
													matchedName = findSessionNameByPath(sPath, persisted.sessions) || "path-match";
													break;
												}
											}
										}

										if (!matchedPath) {
											outputText = JSON.stringify({ ok: false, error: `Session not found: ${name}` });
										} else {
											// Check if running
											const snapshots = readAttentionSnapshots();
											const runningSession = snapshots.find(s => s.sessionPath === matchedPath);
											
											if (runningSession) {
												// Already running, claim leader lease
												claimAttentionLeader(runningSession.sessionId);
												// Update routing target
												if (activeSession.server && typeof activeSession.server.setRoutingTarget === "function") {
													await activeSession.server.setRoutingTarget(matchedName || matchedPath);
												}
												outputText = JSON.stringify({
													ok: true,
													message: `Switched routing target to active session: ${matchedName || matchedPath}`,
													sessionPath: matchedPath,
													sessionId: runningSession.sessionId,
													active: true,
												});
											} else {
												// Not running, resume it
												if (activeSession.server && typeof activeSession.server.onSessionResume === "function") {
													const resumeRes = await activeSession.server.onSessionResume({ sessionPath: matchedPath });
													outputText = JSON.stringify({
														ok: resumeRes.ok,
														message: resumeRes.message,
														sessionPath: matchedPath,
														active: false,
													});
												} else {
													// Fallback to manual launch
													const inventory = discoverAgentInventoryCached();
													const session = inventory.recent.find(s => s.path === matchedPath);
													if (session) {
														const executable = resolveResumeExecutable(session.provider);
														const args = buildAgentResumeArgs(session.provider, session.sessionId || "", session.cwd);
														if (executable && args) {
															launchDetachedCli(executable, args, session.cwd || process.cwd(), `${session.provider} resume`);
															outputText = JSON.stringify({
																ok: true,
																message: `Launching detached resume for ${session.provider} session.`,
																sessionPath: matchedPath,
																active: false,
															});
														} else {
															outputText = JSON.stringify({
																ok: false,
																error: `Unable to resume session: unsupported provider ${session.provider}`,
															});
														}
													} else {
														outputText = JSON.stringify({
															ok: false,
															error: "Session found in routing store but not in recent resume inventory.",
														});
													}
												}
											}
										}
									}
								} else if (call.name === "get_session_info") {
									const persisted = loadPersistedSessionRouting();
									const snapshots = readAttentionSnapshots();
									const lease = readAttentionLeaderLease();
									const cwd = getCurrentCwd();
									
									outputText = JSON.stringify({
										currentSession: lease?.ownerSessionId || "unknown",
										currentCwd: cwd,
										persistedSessions: persisted.sessions,
										persistedAliases: persisted.aliases,
										runningSnapshots: snapshots.map(s => ({
											sessionId: s.sessionId,
											sessionName: s.sessionName,
											sessionPath: s.sessionPath,
											pid: s.pid,
											phase: s.phase,
											waitingForAttention: s.waitingForAttention,
										})),
									});
								} else {
									outputText = JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
								}
							} catch (err: any) {
								outputText = JSON.stringify({ ok: false, error: err.message });
							}

							// Send tool_complete event
							sendToClient(activeSession, {
								type: "tool_complete",
								name: call.name,
								output: outputText,
							}, false);

							// Send function response back to Gemini Live
							if (activeSession.session) {
								activeSession.session.sendToolResponse({
									functionResponses: [
										{
											id: call.id,
											name: call.name,
											response: {
												output: outputText,
											}
										}
									]
								});
							}
						}
					}
				},
				onerror: (event) => {
					sendToClient(activeSession, {
						type: "error",
						message: event.error?.message || event.message || "Gemini Live error",
					}, false);
				},
				onclose: (event) => {
					activeSessions.delete(activeSession.sessionId);
					if (activeSession.ws.readyState === WebSocket.OPEN) {
						activeSession.ws.close(event.code || 1000, event.reason || "Gemini Live closed connection");
					}
				}
			}
		});
		activeSession.session = geminiSession;

		setupSocketHandlers(activeSession);

		if (firstMsg !== undefined) {
			ws.emit("message", firstMsg, firstMsgIsBinary);
		}
	} catch (error: any) {
		activeSessions.delete(sessionId);
		ws.close(1011, `Failed to connect to Gemini Live: ${error.message}`);
	}
}

function resumeSession(ws: WebSocket, reconnectMsg: RealtimeControlMessage) {
	const sessionId = reconnectMsg.session!;
	const activeSession = activeSessions.get(sessionId)!;

	if (activeSession.disconnectTimeout) {
		clearTimeout(activeSession.disconnectTimeout);
		activeSession.disconnectTimeout = undefined;
	}

	activeSession.ws = ws;
	setupSocketHandlers(activeSession);

	// Flush pending/buffered server messages that client has not yet received
	const lastClientReceived = reconnectMsg.serverSequenceId || 0;
	flushPendingServerMessages(activeSession, lastClientReceived);
}

export async function handleRealtimeGateway(this: any, ws: WebSocket) {
	const server = this;

	let initialized = false;
	const initTimeout = setTimeout(() => {
		if (!initialized) {
			initialized = true;
			startNewSession(ws, server).catch(err => {
				ws.close(1011, `Failed to start session: ${err.message}`);
			});
		}
	}, 500);

	ws.once("message", (rawMsg, isBinary) => {
		if (initialized) return;
		clearTimeout(initTimeout);
		initialized = true;

		if (!isBinary) {
			try {
				const ctrl = JSON.parse(rawMsg.toString("utf8")) as RealtimeControlMessage;
				if (ctrl.type === "reconnect" && ctrl.session && activeSessions.has(ctrl.session)) {
					resumeSession(ws, ctrl);
					return;
				}
			} catch (err) {
				// Ignore
			}
		}

		startNewSession(ws, server, rawMsg, isBinary).catch(err => {
			ws.close(1011, `Failed to start session: ${err.message}`);
		});
	});
}

function extractText(message: LiveServerMessage): string {
	let text = "";
	const transcript = message.serverContent?.outputTranscription?.text;
	if (typeof transcript === "string") text += transcript;
	for (const part of message.serverContent?.modelTurn?.parts || []) {
		if (typeof part.text === "string") text += part.text;
	}
	return text;
}

function findSessionNameByPath(sessionPath: string, sessions: Record<string, string>) {
	for (const [name, path] of Object.entries(sessions)) {
		if (path === sessionPath) return name;
	}
	return undefined;
}

