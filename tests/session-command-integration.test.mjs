import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const speakExtensionModule = await import("../dist/index.js");
const speakExtension = speakExtensionModule.default?.default || speakExtensionModule.default || speakExtensionModule;

const { tailSessionEvents } = await import("../dist/session-events.js");
const { persistSessionRouting, loadPersistedSessionRouting } = await import("../dist/session-routing-store.js");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePi() {
	const commands = new Map();
	const events = new Map();
	let sessionName = "";
	return {
		commands,
		events,
		appended: [],
		messages: [],
		registerCommand(name, config) {
			commands.set(name, config);
		},
		on(name, handler) {
			events.set(name, handler);
		},
		appendEntry(customType, data) {
			this.appended.push({ customType, data });
		},
		setSessionName(name) {
			sessionName = name;
		},
		getSessionName() {
			return sessionName;
		},
		sendUserMessage(message, options) {
			this.messages.push({ message, options });
		},
	};
}

function makeCtx(sessionFile, overrides = {}) {
	const notifications = [];
	return {
		hasUI: true,
		notifications,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			setStatus() {},
		},
		sessionManager: {
			getSessionFile() {
				return sessionFile;
			},
			getBranch() {
				return [];
			},
		},
		isIdle() {
			return true;
		},
		hasPendingMessages() {
			return false;
		},
		async newSession() {
			this.newSessionCalls = (this.newSessionCalls || 0) + 1;
			return { cancelled: false };
		},
		async switchSession(path) {
			this.switchedTo = path;
			return { cancelled: false };
		},
		...overrides,
	};
}

async function withSessionStore(testFn) {
	const originalLocalAppData = process.env.LOCALAPPDATA;
	const originalAppData = process.env.APPDATA;
	const root = mkdtempSync(join(tmpdir(), "pi-speak-sess-cmd-"));
	process.env.LOCALAPPDATA = root;
	process.env.APPDATA = root;
	try {
		await testFn();
	} finally {
		if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = originalLocalAppData;
		if (originalAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = originalAppData;
		rmSync(root, { recursive: true, force: true });
	}
}

test("/sess new rejects duplicate names before creating a new session", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const first = makeCtx("/sessions/a.jsonl");
		await sess.handler("name bugfix", first);

		const duplicate = makeCtx("/sessions/b.jsonl");
		await sess.handler("new bugfix", duplicate);

		assert.equal(duplicate.newSessionCalls || 0, 0);
		assert.match(duplicate.notifications.at(-1)?.message || "", /already points to another session/i);
	});
});

test("/sess default view shows current status, aliases, and inline session state", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);
		await sess.handler("wake one", ctx);
		await sess.handler("", ctx);

		const message = ctx.notifications.at(-1)?.message || "";
		assert.match(message, /Current: bugfix/i);
		assert.match(message, /- bugfix \[current\] \[idle\]/i);
		assert.match(message, /aliases: one/i);
	});
});

test("/sess switch resolves wake aliases through the registered session map", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const owner = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", owner);
		await sess.handler("wake one", owner);

		const current = makeCtx("/sessions/current.jsonl");
		await sess.handler("switch one", current);

		assert.equal(current.switchedTo, "/sessions/bugfix.jsonl");
		assert.match(current.notifications.at(-1)?.message || "", /Switched to session: bugfix/i);
	});
});

test("/sess rename updates the saved session name", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);
		await sess.handler("rename bugfix voice-bugfix", ctx);
		await sess.handler("", ctx);

		assert.equal(pi.getSessionName(), "voice-bugfix");
		const message = ctx.notifications.at(-1)?.message || "";
		assert.match(message, /Current: voice-bugfix/i);
		assert.match(message, /- voice-bugfix \[current\] \[idle\]/i);
	});
});

test("/sess remove requires confirmation and clears saved routing metadata", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);
		await sess.handler("wake one", ctx);
		await sess.handler("remove bugfix", ctx);

		assert.match(ctx.notifications.at(-1)?.message || "", /Confirm with \/sess confirm remove bugfix/i);

		await sess.handler("confirm remove bugfix", ctx);
		await sess.handler("", ctx);

		const message = ctx.notifications.at(-1)?.message || "";
		assert.equal(pi.getSessionName(), "");
		assert.match(message, /Current: \(unnamed current session\)/i);
		assert.doesNotMatch(message, /bugfix/i);
		assert.doesNotMatch(message, /aliases: one/i);
	});
});

test("/sess edit shows shortcuts and can proxy a rename action", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);
		await sess.handler("wake one", ctx);
		await sess.handler("edit bugfix", ctx);
		const guide = ctx.notifications.at(-1)?.message || "";
		assert.match(guide, /Session: bugfix/i);
		assert.match(guide, /Shortcuts/i);
		assert.match(guide, /\/sess rename bugfix <new-name>/i);
		assert.match(guide, /\/sess alias remove one/i);

		await sess.handler("edit bugfix rename voice-bugfix", ctx);
		assert.equal(pi.getSessionName(), "voice-bugfix");
		assert.match(ctx.notifications.at(-1)?.message || "", /Session renamed: bugfix → voice-bugfix/i);
	});
});

test("/sess completions include edit shortcuts and alias-specific actions", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);
		await sess.handler("wake one", ctx);

		const editTargets = sess.getArgumentCompletions("edit ") || [];
		assert.ok(editTargets.some((entry) => entry.value === "edit bugfix"));

		const editShortcuts = sess.getArgumentCompletions("edit bugfix ") || [];
		assert.ok(editShortcuts.some((entry) => entry.value === "edit bugfix rename"));
		assert.ok(editShortcuts.some((entry) => entry.value === "edit bugfix alias remove"));

		const aliasRemovals = sess.getArgumentCompletions("edit bugfix alias remove") || [];
		assert.ok(aliasRemovals.some((entry) => entry.value === "edit bugfix alias remove one"));
	});
});

test("/sess export reports the persisted store path and current routing snapshot", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);
		await sess.handler("wake one", ctx);
		await sess.handler("export", ctx);

		const message = ctx.notifications.at(-1)?.message || "";
		assert.match(message, /Sessions: bugfix/i);
		assert.match(message, /Wake aliases: one → bugfix/i);
		assert.match(message, /Store:/i);
	});
});

test("/sess slots reports PK1 and PK2 lane assignments", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const bugfix = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", bugfix);
		await sess.handler("wake one", bugfix);

		const research = makeCtx("/sessions/research.jsonl");
		await sess.handler("name research", research);
		await sess.handler("wake two", research);
		await sess.handler("slots", research);

		const message = research.notifications.at(-1)?.message || "";
		assert.match(message, /Compact routes/i);
		assert.match(message, /- 1: bugfix via one/i);
		assert.match(message, /- 2: research via two/i);
	});
});

test("voice-originated /sess rename emits a session event with source='voice'", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		const voiceSess = pi.commands.get("_sessVoice");
		assert.ok(sess);
		assert.ok(voiceSess, "extension should register _sessVoice internal entry");

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);

		const baseline = tailSessionEvents();
		await voiceSess.handler("rename bugfix voice-bugfix", ctx);

		const { events } = tailSessionEvents(baseline.nextOffset);
		const rename = events.find((event) => event.kind === "sess.rename");
		assert.ok(rename, `expected a sess.rename event, saw: ${events.map((e) => e.kind).join(", ") || "none"}`);
		assert.equal(rename.source, "voice");
		assert.equal(rename.payload.from, "bugfix");
		assert.equal(rename.payload.to, "voice-bugfix");
		assert.equal(pi.getSessionName(), "voice-bugfix");
	});
});

test("voice-originated /sess wake alias set emits alias.add with source='voice'", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		const voiceSess = pi.commands.get("_sessVoice");
		assert.ok(sess);
		assert.ok(voiceSess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);

		const baseline = tailSessionEvents();
		await voiceSess.handler("wake one", ctx);

		const { events } = tailSessionEvents(baseline.nextOffset);
		const aliasAdd = events.find((event) => event.kind === "alias.add");
		assert.ok(aliasAdd, `expected an alias.add event, saw: ${events.map((e) => e.kind).join(", ") || "none"}`);
		assert.equal(aliasAdd.source, "voice");
		assert.equal(aliasAdd.payload.alias, "one");
		assert.equal(aliasAdd.payload.path, "/sessions/bugfix.jsonl");
	});
});

test("/sess reflects external routing-store mutations on the next call", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		// Prime an in-process session so the extension has a baseline mtime.
		const owner = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", owner);

		// Externally mutate the routing store (e.g. the Ink pane wrote to it).
		await sleep(20);
		const persisted = loadPersistedSessionRouting();
		persistSessionRouting({
			sessions: { ...persisted.sessions, "voice-research": "/sessions/research.jsonl" },
			aliases: { ...persisted.aliases, two: "/sessions/research.jsonl" },
		});

		// The next /sess call should reconcile against the external mutation.
		const viewer = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("", viewer);

		const message = viewer.notifications.at(-1)?.message || "";
		assert.match(message, /voice-research/i, `missing externally-added session in: ${message}`);
		assert.match(message, /aliases: two/i, `missing externally-added alias in: ${message}`);
	});
});

test("external rename of the current session syncs the current label on the next /sess call", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const owner = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", owner);
		assert.equal(pi.getSessionName(), "bugfix");

		await sleep(20);
		persistSessionRouting({
			sessions: { "voice-bugfix": "/sessions/bugfix.jsonl" },
			aliases: { one: "/sessions/bugfix.jsonl" },
		});

		const viewer = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("", viewer);

		assert.equal(pi.getSessionName(), "voice-bugfix");
		const message = viewer.notifications.at(-1)?.message || "";
		assert.match(message, /Current: voice-bugfix/i, `current session label did not update: ${message}`);
		assert.match(message, /- voice-bugfix \[current\]/i, `renamed current row missing: ${message}`);
	});
});

test("external routing-store writes do not trigger a feedback reload loop", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);

		// Self-writes should not be interpreted as external mutations by the next call.
		const beforeAppended = pi.appended.length;
		await sess.handler("", ctx);
		const afterAppended = pi.appended.length;
		assert.equal(
			afterAppended,
			beforeAppended,
			"self-triggered /sess writes must not re-broadcast registry/alias state entries",
		);
	});
});

test("typed /sess rename emits a session event with source='command'", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const sess = pi.commands.get("sess");
		assert.ok(sess);

		const ctx = makeCtx("/sessions/bugfix.jsonl");
		await sess.handler("name bugfix", ctx);

		const baseline = tailSessionEvents();
		await sess.handler("rename bugfix command-bugfix", ctx);

		const { events } = tailSessionEvents(baseline.nextOffset);
		const rename = events.find((event) => event.kind === "sess.rename");
		assert.ok(rename, "expected a sess.rename event from typed /sess");
		assert.equal(rename.source, "command");
		assert.equal(rename.payload.to, "command-bugfix");
	});
});

test("phone setup explains in-session Telegram configuration", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const phone = pi.commands.get("phone");
		assert.ok(phone);

		const ctx = makeCtx("/sessions/main.jsonl");
		await phone.handler("setup", ctx);

		const message = ctx.notifications.at(-1)?.message || "";
		assert.match(message, /@BotFather/);
		assert.match(message, /\/phone token <bot-token>/);
		assert.match(message, /\/phone code/);
	});
});

test("/pk-speak stop disables speech and reports hard stop", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const pkSpeak = pi.commands.get("pk-speak");
		const speak = pi.commands.get("speak");
		assert.ok(pkSpeak, "expected /pk-speak command");
		assert.ok(speak, "expected /speak command");

		const ctx = makeCtx("/sessions/main.jsonl");
		await speak.handler("on", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /Speech mode enabled/i);

		// /speak stop is playback-only: speech mode stays enabled.
		await speak.handler("stop", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /Stopped current speech playback/i);
		await speak.handler("status", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /Speech mode is on/i);

		await pkSpeak.handler("stop", ctx);
		const message = ctx.notifications.at(-1)?.message || "";
		assert.match(message, /pk-speak stopped/i);
		assert.match(message, /speech disabled/i);
		assert.match(message, /wake listener stopped/i);

		await pkSpeak.handler("status", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /speech off/i);

		// Hard-stop aliases also disable speech mode.
		await speak.handler("on", ctx);
		await pkSpeak.handler("quiet", ctx);
		await pkSpeak.handler("status", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /speech off/i);
	});
});

test("agent speech mode uses the bundled dispatcher and hard-stop persists as off", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const speak = pi.commands.get("speak");
		const pkSpeak = pi.commands.get("pk-speak");
		assert.ok(speak);
		assert.ok(pkSpeak);

		const ctx = makeCtx("/sessions/agent.jsonl");
		await speak.handler("agent", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /Agent speak mode enabled/i);
		const agentState = pi.appended.filter((entry) => entry.customType === "elevenlabs-speak-state").at(-1)?.data;
		assert.deepEqual({ mode: agentState.mode, enabled: agentState.enabled }, { mode: "agent", enabled: true });

		const beforeAgentStart = pi.events.get("before_agent_start");
		const prompt = await beforeAgentStart({ systemPrompt: "base" }, ctx);
		assert.match(prompt.systemPrompt, /pk-speak\.js["'] speak/);

		await pkSpeak.handler("stop", ctx);
		const stoppedState = pi.appended.filter((entry) => entry.customType === "elevenlabs-speak-state").at(-1)?.data;
		assert.deepEqual({ mode: stoppedState.mode, enabled: stoppedState.enabled }, { mode: "off", enabled: false });

		const resumed = makeCtx("/sessions/agent.jsonl");
		resumed.sessionManager.getBranch = () => [{ type: "custom", customType: "elevenlabs-speak-state", data: stoppedState }];
		const sessionShutdown = pi.events.get("session_shutdown");
		assert.ok(sessionShutdown);
		try {
			await pi.events.get("session_start")({}, resumed);
			await speak.handler("status", resumed);
			assert.match(resumed.notifications.at(-1)?.message || "", /Speech mode is off/i);

			await pkSpeak.handler("on", resumed);
			const enabledState = pi.appended.filter((entry) => entry.customType === "elevenlabs-speak-state").at(-1)?.data;
			assert.deepEqual({ mode: enabledState.mode, enabled: enabledState.enabled }, { mode: "on", enabled: true });
		} finally {
			await sessionShutdown({}, resumed);
		}
	});
});


test("normal speech mode injects layered speech instead of a final-text reader", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const speak = pi.commands.get("speak");
		assert.ok(speak);

		const ctx = makeCtx("/sessions/layered.jsonl");
		await speak.handler("on", ctx);
		const prompt = await pi.events.get("before_agent_start")({ systemPrompt: "base" }, ctx);

		assert.match(prompt.systemPrompt, /pk-speak\.js["'] speak/);
		assert.match(prompt.systemPrompt, /during the turn/i);
	});
});

test("agent_end never starts post-hoc TTS for final terminal text", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const speak = pi.commands.get("speak");
		assert.ok(speak);
		const statuses = [];
		const ctx = makeCtx("/sessions/layered.jsonl", {
			ui: {
				notify() {},
				setStatus(name, value) {
					statuses.push({ name, value });
				},
			},
		});

		await speak.handler("on", ctx);
		await speak.handler("provider edge", ctx);
		await pi.events.get("agent_start")({}, ctx);
		await pi.events.get("message_end")({
			message: { role: "assistant", content: [{ type: "text", text: "A long final terminal report that must stay visual." }] },
		}, ctx);
		const statusCountBeforeEnd = statuses.length;

		try {
			await pi.events.get("agent_end")({}, ctx);
			await sleep(0);
			const endStatuses = statuses.slice(statusCountBeforeEnd).map(({ value }) => value);
			assert.equal(endStatuses.some((value) => /(?:rewrite|voice|playing)$/.test(value)), false);
		} finally {
			await speak.handler("off", ctx);
		}
	});
});

test("/voice tts and off coordinate the real speech switch", async () => {
	await withSessionStore(async () => {
		const pi = makePi();
		speakExtension(pi);
		const voice = pi.commands.get("voice");
		assert.ok(voice);
		const ctx = makeCtx("/sessions/voice-mode.jsonl");

		await voice.handler("tts", ctx);
		const enabled = pi.appended.filter((entry) => entry.customType === "elevenlabs-speak-state").at(-1)?.data;
		assert.deepEqual({ mode: enabled.mode, enabled: enabled.enabled }, { mode: "on", enabled: true });

		await voice.handler("status", ctx);
		assert.match(ctx.notifications.at(-1)?.message || "", /Voice mode: tts/i);

		await voice.handler("off", ctx);
		const disabled = pi.appended.filter((entry) => entry.customType === "elevenlabs-speak-state").at(-1)?.data;
		const unified = pi.appended.filter((entry) => entry.customType === "voice-mode-state").at(-1)?.data;
		assert.deepEqual({ mode: disabled.mode, enabled: disabled.enabled }, { mode: "off", enabled: false });
		assert.deepEqual(unified, { mode: "off" });
	});
});
