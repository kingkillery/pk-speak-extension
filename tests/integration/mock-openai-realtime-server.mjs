import { WebSocketServer } from "ws";
import { createServer } from "node:http";

/**
 * Minimal OpenAI-Realtime GA mock for integration tests.
 * Emits session.created, accepts session.update / audio append,
 * can emit a tiny audio delta and a function_call_arguments.done.
 */
export async function startMockOpenAiRealtimeServer(options = {}) {
	const httpServer = createServer((_req, res) => {
		res.writeHead(200);
		res.end("ok");
	});
	const wss = new WebSocketServer({ server: httpServer, path: "/v1/realtime" });
	/** @type {import('ws').WebSocket[]} */
	const clients = [];
	const events = [];

	wss.on("connection", (socket) => {
		let toolEmitted = false;
		clients.push(socket);
		const created = {
			type: "session.created",
			session: { id: "sess_mock", model: "mock-realtime" },
		};
		events.push(created);
		socket.send(JSON.stringify(created));

		socket.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			events.push(msg);
			if (msg.type === "session.update") {
				const updated = { type: "session.updated", session: msg.session || {} };
				events.push(updated);
				socket.send(JSON.stringify(updated));
			}
			if (msg.type === "input_audio_buffer.append" && options.echoAudio) {
				// 10 samples of silence as base64 pcm16
				const pcm = Buffer.alloc(20);
				const delta = {
					type: "response.output_audio.delta",
					delta: pcm.toString("base64"),
				};
				events.push(delta);
				socket.send(JSON.stringify(delta));
			}
			if (msg.type === "response.create" && options.emitToolCall && !toolEmitted) {
				toolEmitted = true;
				const tool = {
					type: "response.function_call_arguments.done",
					call_id: "call_mock_1",
					name: options.toolName || "get_session_info",
					arguments: JSON.stringify(options.toolArgs || {}),
				};
				events.push(tool);
				socket.send(JSON.stringify(tool));
			}
			if (msg.type === "conversation.item.create" && msg.item?.type === "function_call_output") {
				const done = { type: "response.done", response: { id: "resp_mock" } };
				events.push(done);
				socket.send(JSON.stringify(done));
			}
		});
	});

	await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const { port } = httpServer.address();
	const url = `ws://127.0.0.1:${port}/v1/realtime`;

	return {
		url,
		port,
		events,
		clients,
		async close() {
			for (const c of clients) {
				try { c.close(); } catch {}
			}
			await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));
		},
	};
}
