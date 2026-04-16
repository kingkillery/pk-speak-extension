import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const speakExtensionModule = await import("../dist/index.js");
const speakExtension = speakExtensionModule.default?.default || speakExtensionModule.default || speakExtensionModule;

const { tailSessionEvents } = await import("../dist/session-events.js");

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
