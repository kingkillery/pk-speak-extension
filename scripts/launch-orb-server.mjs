import { spawn, exec } from "node:child_process";
import { existsSync } from "node:fs";

process.env.PI_SPEAK_REALTIME_METRICS = "1";
if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
	process.env.PI_SPEAK_GEMINI_BACKEND = "simulated";
	process.env.PI_SPEAK_SIM_TIMESCALE = "0";
	console.log("[launch-orb] Using simulated backend for interactive demonstration");
}

console.log("[launch-orb] Starting node dist/server-app.js --no-window...");

const serverProc = spawn(process.argv[0], ["dist/server-app.js", "--no-window"], {
	detached: true,
	stdio: "ignore",
	env: process.env,
});

serverProc.unref();

const targetPort = 8767;
const orbUrl = `http://127.0.0.1:${targetPort}/orb/?mode=live&autoconnect=1`;

console.log(`[launch-orb] Polling server health on http://127.0.0.1:${targetPort}/health...`);

let healthPassed = false;
for (let attempt = 1; attempt <= 20; attempt++) {
	await new Promise((r) => setTimeout(r, 500));
	try {
		const res = await fetch(`http://127.0.0.1:${targetPort}/health`);
		if (res.ok) {
			console.log(`[launch-orb] ✅ Server healthy on port ${targetPort}`);
			healthPassed = true;
			break;
		}
	} catch (e) {}
}

if (!healthPassed) {
	console.error("[launch-orb] ❌ Server failed to respond to /health check");
	process.exit(1);
}

const chromePath = existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
	? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
	: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

console.log(`[launch-orb] Opening ${orbUrl} in ${chromePath}...`);

const browserProc = spawn(chromePath, [orbUrl], {
	detached: true,
	stdio: "ignore",
});
browserProc.unref();

console.log(`\n==================================================`);
console.log(`✅ SERVER LAUNCHED & ORB OPENED IN BROWSER`);
console.log(`- Health Check: http://127.0.0.1:${targetPort}/health (PASS)`);
console.log(`- Orb URL: ${orbUrl}`);
console.log(`==================================================\n`);

process.exit(0);
