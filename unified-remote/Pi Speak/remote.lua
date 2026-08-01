local data = require("data");
local http = require("http");
local server = require("server");

local CONFIG = {
	base_url = "http://127.0.0.1:8767",
	-- Optional: paste the token here if the token file cannot be read.
	-- Canonical source: %LOCALAPPDATA%\pi-speak\http-token (same file the tray uses).
	token = ""
};

local cached_token = nil;
local prompt_text = "";
local session_prompt_text = "";
local last_status = "Run /remote on in Pi Speak first.";
local last_reply = "Text-turn replies will appear here.";

-- Herdr session workspace state (/v1/sessions/live)
local live_sessions = {};
local session_by_index = {};
local selected_session_id = nil;

local function trim(value)
	if not value then
		return "";
	end

	value = tostring(value);
	return (string.gsub(value, "^%s*(.-)%s*$", "%1"));
end

local function update_view()
	server.update({
		{ id = "status", text = last_status },
		{ id = "reply", text = last_reply }
	});
end

local function set_status(text)
	last_status = trim(text);
	if last_status == "" then
		last_status = "Ready.";
	end
	update_view();
end

local function set_reply(text)
	last_reply = trim(text);
	if last_reply == "" then
		last_reply = "No reply yet.";
	end
	update_view();
end

local function load_token()
	if cached_token then
		return cached_token;
	end

	if trim(CONFIG.token) ~= "" then
		cached_token = trim(CONFIG.token);
		return cached_token;
	end

	local candidates = {};
	local localappdata = os.getenv("LOCALAPPDATA");
	if localappdata then
		table.insert(candidates, localappdata .. "\\pi-speak\\http-token");
	end
	local appdata = os.getenv("APPDATA");
	if appdata then
		table.insert(candidates, appdata .. "\\pi-speak\\http-token");
	end
	local profile = os.getenv("USERPROFILE");
	if profile then
		table.insert(candidates, profile .. "\\.pi-speak\\http-token");
	end

	for _, path in ipairs(candidates) do
		local ok, content = pcall(function ()
			local fh = io.open(path, "r");
			if not fh then
				return nil;
			end
			local text = fh:read("*a");
			fh:close();
			return text;
		end);
		if ok and trim(content) ~= "" then
			cached_token = trim(content);
			return cached_token;
		end
	end

	-- Do not cache the empty result: the token file may appear after first use.
	return "";
end

local function get_body(resp)
	if type(resp) == "table" then
		if type(resp.content) == "string" then
			return resp.content;
		end
		if type(resp.body) == "string" then
			return resp.body;
		end
		if type(resp.text) == "string" then
			return resp.text;
		end
	end
	if type(resp) == "string" then
		return resp;
	end
	return "";
end

local function get_status_code(resp)
	if type(resp) == "table" then
		return tonumber(resp.status) or tonumber(resp.code) or 0;
	end
	return 0;
end

local function request_json(method, path, body, extra_headers)
	local token = load_token();
	if token == "" then
		return nil, "No auth token. Expected %LOCALAPPDATA%\\pi-speak\\http-token or CONFIG.token.";
	end

	local headers = {
		["X-Pi-Speak-Token"] = token,
		["Content-Type"] = "application/json"
	};
	if extra_headers then
		for key, value in pairs(extra_headers) do
			headers[key] = value;
		end
	end

	local options = {
		url = CONFIG.base_url .. path,
		headers = headers
	};
	if body ~= nil then
		options.body = data.tojson(body);
	end

	local ok, resp = pcall(function ()
		if method == "POST" then
			return http.post(options);
		end
		return http.get(options);
	end);

	if not ok then
		return nil, tostring(resp);
	end

	local code = get_status_code(resp);
	if code == 401 or code == 403 then
		return nil, "Unauthorized (token rejected).";
	end
	if code == 405 then
		return nil, "Method not allowed.";
	end

	local text = get_body(resp);
	if text == "" then
		if code >= 200 and code < 300 then
			return { ok = true }, nil;
		end
		return nil, "Empty response";
	end

	local parsed_ok, payload = pcall(function ()
		return data.fromjson(text);
	end);
	if not parsed_ok or type(payload) ~= "table" then
		return nil, "Invalid JSON response";
	end

	if payload.ok == false then
		return nil, tostring(payload.error or "Request failed");
	end

	return payload, nil;
end

local function bool_word(value, on_text, off_text)
	if value then
		return on_text;
	end
	return off_text;
end

local function summarize_status(status)
	if type(status) ~= "table" then
		return "Pi Speak API reachable.";
	end

	local remote = status.remote or {};
	local speak = status.speak or {};
	local mono = status.mono or {};
	local phone = status.phone or {};

	local speak_label = "off";
	if speak.enabled then
		local provider = speak.provider or speak.configuredProvider or "unknown";
		local rewrite = bool_word(speak.rewriteEnabled, " rewrite", "");
		speak_label = provider .. rewrite;
	end

	local mono_label = "off";
	if mono.running then
		mono_label = mono.voiceInputActive and "active" or "standby";
	end

	local phone_label = "off";
	if phone.enabled then
		if phone.linkedChatId then
			phone_label = "linked";
		else
			phone_label = "pair " .. tostring(phone.linkCode or "?");
		end
	end

	return (
		"API " .. bool_word(remote.enabled, "on", "off") ..
		" @ " .. tostring(remote.port or 8767) ..
		" | speak " .. speak_label ..
		" | mono " .. mono_label ..
		" | phone " .. phone_label
	);
end

local function call_endpoint(method, path, on_success, body)
	local payload, err = request_json(method, path, body);
	if not payload then
		set_status("Pi Speak call failed. (" .. err .. ")");
		return nil;
	end

	if type(on_success) == "function" then
		on_success(payload);
	end

	if type(payload.message) == "string" and trim(payload.message) ~= "" then
		set_status(payload.message);
	end

	return payload;
end

math.randomseed(os.time() + math.floor(os.clock() * 1000));
local idempotency_counter = 0;
local function new_idempotency_key()
	idempotency_counter = idempotency_counter + 1;
	return string.format("ur-%d-%04x-%06x", os.time(), idempotency_counter % 0x10000, math.random(0, 0xffffff));
end

local function update_session_list()
	local children = {};
	for _, session in ipairs(live_sessions) do
		local marker = session.focused and "* " or (session.id == selected_session_id and "> " or "");
		local label = marker .. "[" .. tostring(session.provider or "?") .. "] " ..
			tostring(session.displayName or session.id) ..
			" (" .. tostring(session.status or "?") .. ")";
		table.insert(children, { type = "item", text = label });
	end
	if #children == 0 then
		table.insert(children, { type = "item", text = "No live Herdr sessions" });
	end
	server.update({ id = "sessionlist", children = children });
end

local function refresh_sessions()
	local payload = call_endpoint("GET", "/v1/sessions/live");
	if not payload then
		live_sessions = {};
		session_by_index = {};
		update_session_list();
		return nil;
	end

	local workspace = payload.workspace or {};
	live_sessions = workspace.sessions or {};
	session_by_index = {};
	for i, session in ipairs(live_sessions) do
		session_by_index[i - 1] = session;
	end
	update_session_list();

	if workspace.available == false then
		set_status("Herdr unavailable: " .. tostring(workspace.error or "unknown"));
	else
		set_status(tostring(#live_sessions) .. " live session(s).");
	end
	return payload;
end

local function get_selected_session()
	if not selected_session_id then
		return nil;
	end
	for _, session in ipairs(live_sessions) do
		if session.id == selected_session_id then
			return session;
		end
	end
	return nil;
end

local function session_action(session, action, extra_body)
	if not session then
		set_status("Select a session first.");
		return nil;
	end
	if not (session.capabilities and session.capabilities[action]) then
		set_status("Session does not support " .. action .. ".");
		return nil;
	end

	local body = extra_body or {};
	body.expectedRevision = session.revision;

	-- Session ids are s_<24 hex> (sessionIdForAgent); no URL encoding needed.
	local path = "/v1/sessions/live/" .. session.id .. "/" .. action;
	local payload, err = request_json("POST", path, body, {
		["X-Pi-Speak-Idempotency-Key"] = new_idempotency_key()
	});
	if not payload then
		set_status("Session " .. action .. " failed: " .. err);
		return nil;
	end

	set_status("Session " .. action .. " ok: " .. tostring(session.displayName or session.id));
	refresh_sessions();
	return payload;
end

actions.refresh = function ()
	local payload = call_endpoint("GET", "/v1/status", function (resp)
		if type(resp.status) == "table" then
			set_status(summarize_status(resp.status));
		end
	end);

	if payload and trim(last_reply) == "" then
		set_reply("No reply yet.");
	end
end

actions.set_prompt = function (text)
	prompt_text = text or "";
end

actions.clear_prompt = function ()
	prompt_text = "";
	layout.prompt.text = "";
end

actions.send_prompt = function ()
	local prompt = trim(prompt_text);
	if prompt == "" then
		set_status("Enter a prompt first.");
		return;
	end

	call_endpoint("POST", "/v1/turn/text", function (resp)
		if type(resp.replyText) == "string" and trim(resp.replyText) ~= "" then
			set_reply(resp.replyText);
			set_status("Turn complete.");
		else
			set_status("Turn completed but no reply text was returned.");
		end
	end, { text = prompt, audio = false });
end

actions.mono_on = function ()
	call_endpoint("POST", "/v1/mono/on");
end

actions.mono_off = function ()
	call_endpoint("POST", "/v1/mono/off");
end

actions.speak_on = function ()
	call_endpoint("POST", "/v1/speak/on");
end

actions.speak_off = function ()
	call_endpoint("POST", "/v1/speak/off");
end

actions.speak_stop = function ()
	call_endpoint("POST", "/v1/speak/stop");
end

actions.speak_test = function ()
	call_endpoint("POST", "/v1/speak/test");
end

actions.provider_auto = function ()
	call_endpoint("POST", "/v1/speak/provider/auto");
end

actions.provider_edge = function ()
	call_endpoint("POST", "/v1/speak/provider/edge");
end

actions.provider_openai = function ()
	call_endpoint("POST", "/v1/speak/provider/openai");
end

actions.provider_elevenlabs = function ()
	call_endpoint("POST", "/v1/speak/provider/elevenlabs");
end

actions.phone_on = function ()
	call_endpoint("POST", "/v1/phone/on");
end

actions.phone_off = function ()
	call_endpoint("POST", "/v1/phone/off");
end

actions.phone_status = function ()
	call_endpoint("GET", "/v1/phone/status");
end

actions.phone_code = function ()
	call_endpoint("POST", "/v1/phone/code");
end

-- Herdr session workspace

actions.sessions_refresh = function ()
	refresh_sessions();
end

actions.select_session = function (index)
	local session = session_by_index[tonumber(index)];
	if not session then
		return;
	end
	selected_session_id = session.id;
	update_session_list();
	set_status("Selected " .. tostring(session.displayName or session.id) .. ". Use Focus, Prompt, or Resume.");
end

actions.session_focus = function ()
	session_action(get_selected_session(), "focus");
end

actions.session_resume = function ()
	session_action(get_selected_session(), "resume");
end

actions.set_session_prompt = function (text)
	session_prompt_text = text or "";
end

actions.clear_session_prompt = function ()
	session_prompt_text = "";
	layout.sessionprompt.text = "";
end

actions.session_prompt = function ()
	local session = get_selected_session();
	if not session then
		set_status("Select a session first.");
		return;
	end
	local prompt = trim(session_prompt_text);
	if prompt == "" then
		set_status("Enter a session prompt first.");
		return;
	end
	session_action(session, "prompt", { text = prompt });
end
