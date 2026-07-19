import test from "node:test";
import assert from "node:assert/strict";

const { publishOwnerHubSession, resumeOwnerHubSession } = await import("../dist/hub-handoff.js");

function ownerContext(overrides = {}) {
	let sessionPath = "C:\\sessions\\active.jsonl";
	const commands = [];
	return {
		commands,
		ctx: {
			cwd: "C:\\dev\\project",
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getSessionFile: () => sessionPath },
			executeBuiltinCommand: async (command) => {
				commands.push(command);
				if (command === "/hub publish") {
					return {
						handled: true,
						output: [
							"Hub link: https://relay.example/h/hub_alpha01#secret-key",
							"Saved 2 device snapshot(s). Paste the full link into /hub resume on the next device.",
						],
					};
				}
				sessionPath = "C:\\sessions\\imported.jsonl";
				return {
					handled: true,
					output: ["Resumed 42 hub entries from 2 device(s) into a local session fork."],
				};
			},
			...overrides,
		},
	};
}

test("publishes through the owning OMP process and returns its encrypted link", async () => {
	const owner = ownerContext();
	const result = await publishOwnerHubSession(owner.ctx, {
		sessionPath: "C:\\sessions\\active.jsonl",
	});

	assert.equal(result.ok, true);
	assert.equal(result.link, "https://relay.example/h/hub_alpha01#secret-key");
	assert.equal(result.hubId, "hub_alpha01");
	assert.equal(result.devices, 2);
	assert.deepEqual(owner.commands, ["/hub publish"]);
});

test("refuses to publish a session not owned by the active process", async () => {
	const owner = ownerContext();
	const result = await publishOwnerHubSession(owner.ctx, {
		sessionPath: "C:\\sessions\\different.jsonl",
	});

	assert.equal(result.ok, false);
	assert.equal(result.status, 409);
	assert.deepEqual(owner.commands, []);
});

test("resumes through the owner-local command without echoing the link", async () => {
	const owner = ownerContext();
	const link = "https://relay.example/h/hub_alpha01#secret-key";
	const result = await resumeOwnerHubSession(owner.ctx, { link });

	assert.equal(result.ok, true);
	assert.equal(result.sessionPath, "C:\\sessions\\imported.jsonl");
	assert.equal(result.entryCount, 42);
	assert.equal(result.devices, 2);
	assert.equal(JSON.stringify(result).includes("secret-key"), false);
	assert.deepEqual(owner.commands, [`/hub resume ${link}`]);
});

test("rejects a parallel handoff while the owner session is mutating", async () => {
	let release;
	const blocked = new Promise((resolve) => {
		release = resolve;
	});
	const owner = ownerContext({
		executeBuiltinCommand: async () => {
			await blocked;
			return {
				handled: true,
				output: [
					"Hub link: https://relay.example/h/hub_alpha01#secret-key",
					"Saved 1 device snapshot(s). Paste the full link into /hub resume on the next device.",
				],
			};
		},
	});
	const first = publishOwnerHubSession(owner.ctx, { sessionPath: "C:\\sessions\\active.jsonl" });
	await Promise.resolve();

	const second = await publishOwnerHubSession({ ...owner.ctx }, { sessionPath: "C:\\sessions\\active.jsonl" });

	assert.equal(second.ok, false);
	assert.equal(second.status, 409);
	release();
	assert.equal((await first).ok, true);
});

test("rejects a handoff when the owner has queued messages", async () => {
	const owner = ownerContext({ hasPendingMessages: () => true });

	const result = await publishOwnerHubSession(owner.ctx, { sessionPath: "C:\\sessions\\active.jsonl" });

	assert.equal(result.ok, false);
	assert.equal(result.status, 409);
	assert.deepEqual(owner.commands, []);
});

test("reports unsupported gateways instead of spawning a competing writer", async () => {
	const result = await publishOwnerHubSession(undefined, {
		sessionPath: "C:\\sessions\\active.jsonl",
	});

	assert.equal(result.ok, false);
	assert.equal(result.status, 501);
});
