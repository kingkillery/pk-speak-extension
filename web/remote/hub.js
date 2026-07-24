// PK Hub — agent monitor + decision surface, e-ink-first (Boox Palma).
//
// Read path: GET /v1/herdr/agents (poll, diff-gated repaint) and
// GET /v1/herdr/agent/:id (detail with transcript tail).
// Decision path: the EXISTING gated gateway actions only — chat, revive,
// and the two-step kill confirm. No new mutation routes; disk-only mode
// surfaces the gateway's 409 hub_offline as a read-only banner.
"use strict";

const STORAGE = { token: "piSpeakRemoteToken" };
const POLL_MS = 5000;
const LANES_PER_PAGE = 6;
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
	chatBtn: document.getElementById("chatBtn"),
	reviveBtn: document.getElementById("reviveBtn"),
	killBtn: document.getElementById("killBtn"),
};

const state = {
	folders: [],
	agents: [],
	page: 0,
	lastPayload: "",
	detailId: null,
	pendingKill: null, // { id, token, expiresAt }
	timer: null,
};

function token() {
	const q = new URL(location.href).searchParams.get("token");
	if (q) {
		try { sessionStorage.setItem(STORAGE.token, q); } catch { /* private mode */ }
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
	if (body && body.code === "hub_offline") return "READ-ONLY: no live hub host (disk snapshot only).";
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

function statusGlyph(agent) {
	switch (agent.status) {
		case "running": return "\u25CF RUN";
		case "idle": return "\u25D0 IDLE";
		case "parked": return "\u25CB PARK";
		case "aborted": return "\u2715 ABRT";
		default: return String(agent.status).toUpperCase();
	}
}

function ago(ms) {
	const delta = Math.max(0, Date.now() - ms);
	const minutes = Math.floor(delta / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function agentCard(agent, extraClass) {
	const card = document.createElement("button");
	card.type = "button";
	card.className = `card ${extraClass ?? ""}`.trim();
	const top = document.createElement("div");
	top.className = "cardTop";
	const name = document.createElement("span");
	name.className = "name";
	name.textContent = agent.displayName;
	const status = document.createElement("span");
	status.className = "status";
	status.textContent = statusGlyph(agent);
	top.append(name, status);
	card.append(top);
	if (agent.description) {
		const desc = document.createElement("div");
		desc.className = "desc";
		desc.textContent = agent.description;
		card.append(desc);
	}
	const meta = document.createElement("div");
	meta.className = "meta";
	meta.textContent = [agent.model, ago(agent.lastActivityMs)].filter(Boolean).join(" - ");
	card.append(meta);
	if (agent.needsAttention && agent.attentionReason) {
		const reason = document.createElement("div");
		reason.className = "reason";
		reason.textContent = `\u26A0 ${agent.attentionReason}`;
		card.append(reason);
	}
	card.addEventListener("click", () => openDetail(agent.id));
	return card;
}

/** Lanes with their subs stay together; pages hold up to LANES_PER_PAGE lanes. */
function laneGroups() {
	const lanes = state.agents.filter((agent) => agent.kind !== "sub");
	return lanes.map((lane) => ({
		lane,
		subs: state.agents.filter((agent) => agent.kind === "sub" && agent.parentId === lane.id),
	}));
}

function renderList() {
	const attention = state.agents.filter((agent) => agent.needsAttention);
	els.attention.hidden = attention.length === 0;
	els.attentionCards.replaceChildren(...attention.map((agent) => agentCard(agent, "attention")));

	const groups = laneGroups();
	const pageCount = Math.max(1, Math.ceil(groups.length / LANES_PER_PAGE));
	state.page = Math.min(state.page, pageCount - 1);
	const pageGroups = groups.slice(state.page * LANES_PER_PAGE, (state.page + 1) * LANES_PER_PAGE);

	const rows = [];
	let lastFolder = null;
	for (const group of pageGroups) {
		if (group.lane.folderKey !== lastFolder) {
			lastFolder = group.lane.folderKey;
			const folder = state.folders.find((f) => f.key === group.lane.folderKey);
			const head = document.createElement("div");
			head.className = "folderHead";
			head.textContent = folder ? folder.name : "(unknown folder)";
			rows.push(head);
		}
		rows.push(agentCard(group.lane));
		for (const sub of group.subs) rows.push(agentCard(sub, "sub"));
	}
	if (rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent = "No background agents found.";
		rows.push(empty);
	}
	els.agentCards.replaceChildren(...rows);
	els.agentsHeading.textContent = `AGENTS (${groups.length})`;

	els.pager.hidden = pageCount <= 1;
	els.pageLabel.textContent = `${state.page + 1} / ${pageCount}`;
	els.prevBtn.disabled = state.page === 0;
	els.nextBtn.disabled = state.page >= pageCount - 1;
}

async function refresh(force) {
	const { status, ok, body } = await api("/v1/herdr/agents", { headers: authHeaders() });
	els.clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (!ok) {
		showBanner(describeFailure(status, body));
		return;
	}
	const payload = JSON.stringify({ folders: body.folders, agents: body.agents });
	if (!force && payload === state.lastPayload) return; // e-ink: no repaint without change
	state.lastPayload = payload;
	state.folders = body.folders ?? [];
	state.agents = body.agents ?? [];
	showBanner("");
	renderList();
}

async function openDetail(id) {
	const { status, ok, body } = await api(`/v1/herdr/agent/${encodeURIComponent(id)}?lines=${DETAIL_TAIL_LINES}`, {
		headers: authHeaders(),
	});
	if (!ok) {
		showBanner(describeFailure(status, body));
		return;
	}
	const agent = body.agent;
	state.detailId = id;
	disarmKill();
	els.detailName.textContent = agent.displayName;
	els.detailDescription.textContent = agent.description ?? "(no description)";
	els.detailMeta.textContent = [
		statusGlyph(agent),
		agent.model,
		agent.cwd,
		`active ${ago(agent.lastActivityMs)}`,
	].filter(Boolean).join(" - ");
	els.detailTranscript.textContent = agent.transcriptTail.join("\n") || "(transcript empty)";
	els.detailTranscript.scrollTop = els.detailTranscript.scrollHeight;
	els.listView.hidden = true;
	els.detailView.hidden = false;
}

function closeDetail() {
	state.detailId = null;
	disarmKill();
	els.detailView.hidden = true;
	els.listView.hidden = false;
	void refresh(true);
}

function disarmKill() {
	state.pendingKill = null;
	els.killBtn.textContent = "ARCHIVE";
	els.killBtn.classList.remove("arm");
}

async function actOnDetail(action, payload, headers) {
	if (!state.detailId) return { ok: false, status: 0, body: undefined };
	const outcome = await api(`/v1/herdr/agent/${encodeURIComponent(state.detailId)}/${action}`, {
		method: "POST",
		headers: authHeaders(Object.assign({ "Content-Type": "application/json" }, headers)),
		body: JSON.stringify(payload ?? {}),
	});
	if (!outcome.ok && !(outcome.body && outcome.body.code === "confirm_required")) {
		showBanner(describeFailure(outcome.status, outcome.body));
	}
	return outcome;
}

els.chatBtn.addEventListener("click", async () => {
	const text = window.prompt("Message for this agent:");
	if (!text) return;
	const idempotencyKey = `hub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const { ok } = await actOnDetail("chat", { text }, { "x-pi-speak-idempotency-key": idempotencyKey });
	if (ok) showBanner("Message sent.");
});

els.reviveBtn.addEventListener("click", async () => {
	const { ok } = await actOnDetail("revive");
	if (ok) {
		showBanner("Revive requested.");
		if (state.detailId) void openDetail(state.detailId);
	}
});

els.killBtn.addEventListener("click", async () => {
	const pending = state.pendingKill;
	if (pending && pending.id === state.detailId && pending.expiresAt > Date.now()) {
		const { ok } = await actOnDetail("kill", { confirmToken: pending.token });
		disarmKill();
		if (ok) {
			showBanner("Lane archived.");
			closeDetail();
		}
		return;
	}
	const { body } = await actOnDetail("kill", {});
	if (body && body.code === "confirm_required") {
		state.pendingKill = { id: state.detailId, token: body.confirmToken, expiresAt: Date.now() + body.expiresInMs };
		els.killBtn.textContent = "TAP AGAIN TO CONFIRM";
		els.killBtn.classList.add("arm");
		setTimeout(() => {
			if (state.pendingKill && state.pendingKill.expiresAt <= Date.now()) disarmKill();
		}, body.expiresInMs + 250);
	}
});

els.backBtn.addEventListener("click", closeDetail);
els.refreshBtn.addEventListener("click", () => void refresh(true));
els.prevBtn.addEventListener("click", () => { state.page -= 1; renderList(); });
els.nextBtn.addEventListener("click", () => { state.page += 1; renderList(); });

document.addEventListener("visibilitychange", () => {
	if (!document.hidden && !state.detailId) void refresh(false);
});

state.timer = setInterval(() => {
	if (document.hidden || state.detailId) return; // no background repaints on e-ink
	void refresh(false);
}, POLL_MS);

void refresh(true);
