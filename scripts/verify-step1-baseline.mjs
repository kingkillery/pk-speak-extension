import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Set environment variables BEFORE importing control-server / realtime-gateway
process.env.PI_SPEAK_REALTIME_METRICS = "1";
process.env.PI_SPEAK_GEMINI_BACKEND = "simulated";
process.env.PI_SPEAK_SIM_TIMESCALE = "0";

const { ControlServer } = await import("../dist/control-server.js");
const { handleRealtimeGateway } = await import("../dist/realtime-gateway.js");

const port = 8770;
const cdpPort = 9224;
let browserProc = null;
let wsUpgradeObserved = false;
let startHandshakeObserved = false;
let voiceMetricsEnabledConfirmed = false;
let audioContextRunningConfirmed = false;
let metricsReceived = [];

const server = new ControlServer({
	state: {
		enabled: true,
		host: "127.0.0.1",
		port,
		authToken: "",
	},
	onStateChange: () => {},
	onRealtimeConnection: (ws) => {
		wsUpgradeObserved = true;
		console.log("[SERVER] WebSocket connection established on /v1/live");
		handleRealtimeGateway(ws);
	},
	getStatus: () => ({
		agent: { provider: "pi", model: "test-model" },
		speak: { enabled: false },
		mono: { running: false },
		phone: { enabled: false },
		remote: { enabled: true, host: "127.0.0.1", port, authRequired: false },
	}),
	getDiagnostics: () => ({ status: {} }),
	getRoutingStatus: () => ({ availableTargets: ["pi"] }),
	setRoutingTarget: async () => ({ ok: true, message: "ok" }),
	onMonoAction: async () => ({ ok: true, message: "ok" }),
	onSpeakAction: async () => ({ ok: true, message: "ok" }),
	onPhoneAction: async () => ({ ok: true, message: "ok" }),
	onTextTurn: async () => ({ replyText: "ok" }),
	onVoiceTurn: async () => ({ replyText: "ok" }),
	getHerdrSnapshot: () => ({ panes: [] }),
	readHerdrPane: () => null,
	sendHerdrPane: () => {},
	sendHerdrAgent: () => {},
	isHubHandoffReady: () => false,
	getSlashCommands: () => [],
});

await server.start();
console.log(`[server] ControlServer running on http://127.0.0.1:${port} with PI_SPEAK_REALTIME_METRICS=1`);

const chromePath = existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
	? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
	: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

console.log(`[browser] Launching ${chromePath}...`);

const url = `http://127.0.0.1:${port}/orb/?mode=live&autoconnect=1`;

browserProc = spawn(chromePath, [
	"--headless=new",
	`--remote-debugging-port=${cdpPort}`,
	"--autoplay-policy=no-user-gesture-required",
	"--use-fake-ui-for-media-stream",
	"--use-fake-device-for-media-stream",
	"--no-sandbox",
	url,
]);

let pollCount = 0;
const pollInterval = setInterval(async () => {
	pollCount += 1;
	try {
		const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
		const pages = await res.json();
		const page = pages.find((p) => p.url.includes("/orb/"));
		if (page && page.webSocketDebuggerUrl) {
			clearInterval(pollInterval);
			console.log("[CDP] Connected to Chrome page debugger:", page.webSocketDebuggerUrl);
			const { WebSocket } = await import("ws");
			const ws = new WebSocket(page.webSocketDebuggerUrl);

			ws.on("open", () => {
				ws.send(JSON.stringify({ id: 1, method: "Console.enable" }));
				ws.send(JSON.stringify({ id: 2, method: "Runtime.enable" }));
			});

			ws.on("message", (data) => {
				const msg = JSON.parse(String(data));
				let text = "";
				if (msg.method === "Console.messageAdded") {
					text = msg.params.message.text || "";
				} else if (msg.method === "Runtime.consoleAPICalled") {
					text = msg.params.args.map((a) => a.value || a.description || JSON.stringify(a)).join(" ");
				}
				if (text) {
					if (text.includes("[pi-speak-voice-metric]")) {
						console.log("[METRIC LOG]", text);
						metricsReceived.push(text);
						if (text.includes("voiceMetricsEnabled\":true") || text.includes("kind\":\"handshake\"")) {
							startHandshakeObserved = true;
							voiceMetricsEnabledConfirmed = true;
						}
					}
				}

				if (msg.id === 10 && msg.result?.result?.value !== undefined) {
					const acState = msg.result.result.value;
					console.log(`[BROWSER AudioContext state]`, acState);
					if (acState === "running") {
						audioContextRunningConfirmed = true;
					}
				}

				if (msg.id === 12 && msg.result?.result?.value !== undefined) {
					const vmVal = msg.result.result.value;
					console.log(`[BROWSER window.voiceMetricsEnabled]`, vmVal);
					if (vmVal === true) {
						voiceMetricsEnabledConfirmed = true;
					}
				}
			});

			let evalTimer = setInterval(() => {
				// 1. Check AudioContext state
				ws.send(JSON.stringify({
					id: 10,
					method: "Runtime.evaluate",
					params: { expression: "window.audioCtx?.state || (typeof audioCtx !== 'undefined' ? audioCtx.state : null)" }
				}));

				// 2. Check window.voiceMetricsEnabled
				ws.send(JSON.stringify({
					id: 12,
					method: "Runtime.evaluate",
					params: { expression: "window.voiceMetricsEnabled" }
				}));

				// 3. Trigger turn text
				ws.send(JSON.stringify({
					id: 11,
					method: "Runtime.evaluate",
					params: { expression: "if (typeof sendJson === 'function') { sendJson({ type: 'text', text: 'hello baseline metric' }); }" }
				}));
			}, 1000);

			setTimeout(() => clearInterval(evalTimer), 7000);
		}
	} catch (e) {
		if (pollCount > 10) clearInterval(pollInterval);
	}
}, 500);

setTimeout(async () => {
	console.log(`\n========================================`);
	console.log(`=== STEP 1 BASELINE VERIFICATION ===`);
	console.log(`========================================`);
	console.log(`1. Server started with PI_SPEAK_REALTIME_METRICS=1: TRUE`);
	console.log(`2. WebSocket upgrade on /v1/live observed: ${wsUpgradeObserved ? "PASS" : "FAIL"}`);
	console.log(`3. Handshake voiceMetricsEnabled: true confirmed: ${voiceMetricsEnabledConfirmed ? "PASS" : "FAIL"}`);
	console.log(`4. Chrome /orb/ AudioContext state === "running": ${audioContextRunningConfirmed ? "PASS" : "FAIL"}`);
	console.log(`5. [pi-speak-voice-metric] console log lines captured: ${metricsReceived.length}`);

	if (browserProc) browserProc.kill();
	await server.stop();

	if (!wsUpgradeObserved || !voiceMetricsEnabledConfirmed || !audioContextRunningConfirmed || metricsReceived.length === 0) {
		console.error("\n❌ STEP 1 VERIFICATION FAILED: Mandatory baseline assertions not met.");
		process.exit(1);
	} else {
		console.log("\n✅ STEP 1 VERIFICATION SUCCESSFUL: Baseline verified end-to-end.");
		process.exit(0);
	}
}, 9000);
