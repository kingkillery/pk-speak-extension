// PK Sessions — live Herdr session workspace, e-ink-first (Boox Palma).
//
// The page talks only to the authenticated semantic session API. It never
// targets windows, terminal titles, raw keystrokes, or client-derived pane IDs.
"use strict";

const STORAGE = { token: "piSpeakRemoteToken" };
const POLL_MS = 5000;
const SESSIONS_PER_PAGE = 6;
const DETAIL_TAIL_LINES = 60;

const els = {
	banner: document.getElementById("banner"),
	clock: document.getElementById("clock"),
	refreshBtn: document.getElementById("refreshBtn"),
	listView: document.getElementById("listView"),
	attention: document.getElementById("attention"),
	attentionCards: document.getElementById("attentionCards"),
	agentsHeading: document.getElementById("agentsHeading"),
	agentCards: document.getElementById("agentCards"),
	pager: document.getElementById("pager"),
	prevBtn: document.getElementById("prevBtn"),
	nextBtn: document.getElementById("nextBtn"),
	pageLabel: document.getElementById("pageLabel"),
	detailView: document.getElementById("detailView"),
	backBtn: document.getElementById("backBtn"),
	detailName: document.getElementById("detailName"),
	detailDescription: document.getElementById("detailDescription"),
	detailMeta: document.getElementById("detailMeta"),
	detailTranscript: document.getElementById("detailTranscript"),
	promptForm: document.getElementById("promptForm"),
	promptInput: document.getElementById("promptInput"),
	promptBtn: document.getElementById("promptBtn"),
	focusBtn: document.getElementById("focusBtn"),
	resumeBtn: document.getElementById("resumeBtn"),
};

const state = {
	sessions: [],
	available: false,
	herdrError: "",
	page: 0,
	lastPayload: "",
	detail: null,
	streamAbort: null,
	timer: null,
};

function token() {
	const q = new URL(location.href).searchParams.get("token");
	if (q) {
		try { sessionStorage.setItem(STORAGE.token, q); } catch { /* private mode */ }
		const cleaned = new URL(location.href);
		cleaned.searchParams.delete("token");
		history.replaceState({}, "", `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
		return q;
	}
	try {
		return sessionStorage.getItem(STORAGE.token) || localStorage.getItem(STORAGE.token) || "";
	} catch {
		return "";
	}
}

function authHeaders(extra) {
	const headers = Object.assign({}, extra);
	const t = token();
	if (t) headers["x-pi-speak-token"] = t;
	return headers;
}

function showBanner(text) {
	els.banner.textContent = text;
	els.banner.hidden = !text;
}

function describeFailure(status, body) {
	if (status === 401 || status === 403) return "Not authorized - open this page with ?token=<remote token>.";
	if (body && body.code === "herdr_unavailable") return `Herdr unavailable: ${body.error || "not running"}`;
	if (body && body.code === "revision_mismatch") return "Session changed before the action ran; refreshed details are required.";
	if (body && body.code === "idempotency_conflict") return "That action key was already used with different arguments.";
	if (body && body.error) return String(body.error);
	return `Request failed (${status}).`;
}

async function api(path, options) {
	const res = await fetch(path, options);
	let body;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	return { status: res.status, ok: res.ok && !!body && body.ok !== false, body };
}

function statusGlyph(session) {
	switch (session.status) {
		case "working": return "\u25CF WORK";
		case "blocked": return "\u26A0 BLOCK";
		case "idle": return "\u25D0 IDLE";
		case "done": return "\u2713 DONE";
		default: return String(session.status || "unknown").toUpperCase();
	}
}

function sessionMeta(session) {
	return [
		session.provider,
		session.cwd || "",
		`rev ${session.revision}`,
		session.focused ? "focused" : "",
	].filter(Boolean).join(" - ");
}

function sessionCard(session, extraClass) {
	const card = document.createElement("button");
	card.type = "button";
	card.className = `card ${extraClass ?? ""}`.trim();
	const top = document.createElement("div");
	top.className = "cardTop";
	const name = document.createElement("span");
	name.className = "name";
	name.textContent = session.displayName;
	const status = document.createElement("span");
	status.className = "status";
	status.textContent = statusGlyph(session);
	top.append(name, status);
	card.append(top);
	const desc = document.createElement("div");
	desc.className = "desc";
	desc.textContent = session.nativeSession
		? `${session.provider} native session ${session.nativeSession.kind}`
		: `${session.provider} session`;
	card.append(desc);
	const meta = document.createElement("div");
	meta.className = "meta";
	meta.textContent = sessionMeta(session);
	card.append(meta);
	if (session.status === "blocked") {
		const reason = document.createElement("div");
		reason.className = "reason";
		reason.textContent = "\u26A0 waiting for a decision";
		card.append(reason);
	}
	card.addEventListener("click", () => openDetail(session.id));
	return card;
}

function workspaceGroups() {
	const groups = new Map();
	for (const session of state.sessions) {
		const key = session.cwd || "(unknown workspace)";
		const group = groups.get(key) || [];
		group.push(session);
		groups.set(key, group);
	}
	return [...groups.entries()].map(([name, sessions]) => ({ name, sessions }));
}

function renderList() {
	const attention = state.sessions.filter((session) => session.status === "blocked");
	els.attention.hidden = attention.length === 0;
	els.attentionCards.replaceChildren(...attention.map((session) => sessionCard(session, "attention")));

	const groups = workspaceGroups();
	const pageCount = Math.max(1, Math.ceil(groups.length / SESSIONS_PER_PAGE));
	state.page = Math.min(state.page, pageCount - 1);
	const pageGroups = groups.slice(state.page * SESSIONS_PER_PAGE, (state.page + 1) * SESSIONS_PER_PAGE);

	const rows = [];
	for (const group of pageGroups) {
		const head = document.createElement("div");
		head.className = "folderHead";
		head.textContent = group.name;
		rows.push(head);
		for (const session of group.sessions) rows.push(sessionCard(session));
	}
	if (rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = state.available
			? "No live Herdr agent sessions found."
			: "Herdr is unavailable; no live session list can be shown.";
		rows.push(empty);
	}
	els.agentCards.replaceChildren(...rows);
	els.agentsHeading.textContent = `[ SESSIONS (${state.sessions.length}) ]`;

	els.pager.hidden = pageCount <= 1;
	els.pageLabel.textContent = `${state.page + 1} / ${pageCount}`;
	els.prevBtn.disabled = state.page === 0;
	els.nextBtn.disabled = state.page >= pageCount - 1;
}

async function refresh(force) {
	const { status, ok, body } = await api("/v1/sessions/live", { headers: authHeaders() });
	els.clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (!ok) {
		showBanner(describeFailure(status, body));
		return;
	}
	const workspace = body.workspace || {};
	const payload = JSON.stringify({ available: workspace.available, error: workspace.error, sessions: workspace.sessions });
	if (!force && payload === state.lastPayload) return; // e-ink: no repaint without change
	state.lastPayload = payload;
	state.available = workspace.available === true;
	state.herdrError = workspace.error || "";
	state.sessions = workspace.sessions ?? [];
	showBanner(state.available ? "" : `Herdr unavailable: ${state.herdrError || "not running"}`);
	renderList();
}

function renderDetail() {
	const detail = state.detail;
	if (!detail) return;
	const session = detail.session;
	els.detailName.textContent = session.displayName;
	els.detailDescription.textContent = session.nativeSession
		? `${session.provider} native ${session.nativeSession.kind} session`
		: `${session.provider} session`;
	els.detailMeta.textContent = sessionMeta(session);
	els.detailTranscript.textContent = detail.tail.text || "(no recent output)";
	els.detailTranscript.scrollTop = els.detailTranscript.scrollHeight;
	const promptEnabled = !!session.capabilities.prompt;
	els.promptBtn.disabled = !promptEnabled;
	els.promptInput.disabled = !promptEnabled;
	els.focusBtn.disabled = !session.capabilities.focus;
	els.resumeBtn.disabled = !session.capabilities.resume;
}

async function openDetail(id) {
	stopStream();
	const { status, ok, body } = await api(`/v1/sessions/live/${encodeURIComponent(id)}?lines=${DETAIL_TAIL_LINES}`, {
		headers: authHeaders(),
	});
	if (!ok) {
		showBanner(describeFailure(status, body));
		return;
	}
	state.detail = body.detail;
	showBanner("");
	renderDetail();
	els.listView.hidden = true;
	els.detailView.hidden = false;
	void startStream(id);
}

function closeDetail() {
	stopStream();
	state.detail = null;
	els.promptInput.value = "";
	els.detailView.hidden = true;
	els.listView.hidden = false;
	void refresh(true);
}

function stopStream() {
	if (state.streamAbort) {
		state.streamAbort.abort();
		state.streamAbort = null;
	}
}

async function startStream(id) {
	stopStream();
	const controller = new AbortController();
	state.streamAbort = controller;
	try {
		const res = await fetch(`/v1/sessions/live/${encodeURIComponent(id)}/stream?lines=${DETAIL_TAIL_LINES}`, {
			headers: authHeaders(),
			signal: controller.signal,
		});
		if (!res.ok || !res.body) {
			let body;
			try { body = await res.json(); } catch { /* non-JSON */ }
			showBanner(describeFailure(res.status, body));
			return;
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				handleSseBlock(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
			}
		}
	} catch (error) {
		if (!controller.signal.aborted) showBanner(error instanceof Error ? error.message : String(error));
	}
}

function handleSseBlock(block) {
	if (!state.detail || block.startsWith(":")) return;
	let event = "message";
	const data = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("event: ")) event = line.slice(7);
		if (line.startsWith("data: ")) data.push(line.slice(6));
	}
	if (!data.length) return;
	let payload;
	try {
		payload = JSON.parse(data.join("\n"));
	} catch {
		return;
	}
	if (event === "session" && payload.session && payload.session.id === state.detail.session.id) {
		state.detail.session = payload.session;
		renderDetail();
	}
	if (event === "tail" && payload.tail) {
		state.detail.tail = payload.tail;
		renderDetail();
	}
	if (event === "error" && payload.error) showBanner(payload.error);
}

function mutationKey(prefix) {
	if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function actOnDetail(action, payload) {
	if (!state.detail) return { ok: false, status: 0, body: undefined };
	const sessionId = state.detail.session.id;
	const outcome = await api(`/v1/sessions/live/${encodeURIComponent(sessionId)}/${action}`, {
		method: "POST",
		headers: authHeaders({
			"Content-Type": "application/json",
			"X-Pi-Speak-Idempotency-Key": mutationKey(action),
		}),
		body: JSON.stringify({
			...payload,
			expectedRevision: state.detail.session.revision,
		}),
	});
	if (!outcome.ok) {
		showBanner(describeFailure(outcome.status, outcome.body));
		if (outcome.body && outcome.body.code === "revision_mismatch") void openDetail(sessionId);
		return outcome;
	}
	state.detail.session = outcome.body.session;
	renderDetail();
	return outcome;
}

els.promptForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const text = els.promptInput.value.trim();
	if (!text) {
		els.promptInput.focus();
		return;
	}
	els.promptBtn.disabled = true;
	try {
		const { ok } = await actOnDetail("prompt", { text });
		if (ok) {
			els.promptInput.value = "";
			showBanner("Prompt accepted by the session.");
		}
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
	} finally {
		const promptEnabled = !!state.detail?.session.capabilities.prompt;
		els.promptBtn.disabled = !promptEnabled;
		els.promptInput.disabled = !promptEnabled;
	}
});

els.promptInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
		event.preventDefault();
		els.promptForm.requestSubmit();
	}
});

els.focusBtn.addEventListener("click", async () => {
	const { ok } = await actOnDetail("focus", {});
	if (ok) showBanner("Session focused on the workstation.");
});

els.resumeBtn.addEventListener("click", async () => {
	const { ok } = await actOnDetail("resume", {});
	if (ok) showBanner("Session is active.");
});

els.backBtn.addEventListener("click", closeDetail);
els.refreshBtn.addEventListener("click", () => void refresh(true));
els.prevBtn.addEventListener("click", () => { state.page -= 1; renderList(); });
els.nextBtn.addEventListener("click", () => { state.page += 1; renderList(); });

document.addEventListener("visibilitychange", () => {
	if (!document.hidden && !state.detail) void refresh(false);
});

state.timer = setInterval(() => {
	if (document.hidden || state.detail) return; // no background repaints on e-ink
	void refresh(false);
}, POLL_MS);

void refresh(true);
