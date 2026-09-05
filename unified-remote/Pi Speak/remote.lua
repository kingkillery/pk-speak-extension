local data = require("data");
local http = require("http");
local server = require("server");
local timer = require("timer");

local CONFIG = {
	base_url = "http://127.0.0.1:8767",
	request_timeout_ms = 15000,
	collab_origins = {
		"https://oh-my-pk.pkking.computer"
	},
	-- Optional: paste the token here if the token file cannot be read.
	-- Canonical source: %LOCALAPPDATA%\pi-speak\http-token (same file the tray uses).
	token = ""
};

local cached_token = nil;
local prompt_text = "";
local session_prompt_text = "";
local last_status = "Run /remote on in Pi Speak first.";
local last_reply = "Text-turn replies will appear here.";
local prompt_request_id = 0;

-- Herdr session workspace state (/v1/sessions/live)
local live_sessions = {};
local session_by_index = {};
local selected_session_id = nil;

-- Collaboration handoff state. Links stay in memory and are only rendered in the Collab tab.
local collab_workspace_text = "";
local collab_web_link = nil;
local collab_view_link = nil;
local collab_status = "Refresh to check for an active Collab link.";
local collab_operation_id = 0;
local collab_pending = false;

local function trim(value)
	if not value then
		return "";
	end

	value = tostring(value);
	return (string.gsub(value, "^%s*(.-)%s*$", "%1"));
end

local function json_true(value)
	return value == true or value == 1 or value == "true";
end

local function json_false(value)
	return value == false or value == 0 or value == "false";
end

local function approved_collab_url(value)
	local url = trim(value);
	if url == "" then
		return nil;
	end

	local normalized = string.lower(url);
	for _, configured_origin in ipairs(CONFIG.collab_origins or {}) do
		local origin = string.lower(trim(configured_origin));
		if origin ~= "" and string.sub(origin, 1, 8) == "https://" and string.sub(normalized, 1, #origin) == origin then
			local separator = string.sub(normalized, #origin + 1, #origin + 1);
			if separator == "" or separator == "/" or separator == "?" or separator == "#" then
				return url;
			end
		end
	end

	return nil;
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

local function request_json(method, path, body, extra_headers, callback)
	local finished = false;
	local timeout_id = nil;
	local function finish(payload, err)
		if finished then
			return;
		end
		finished = true;
		if timeout_id then
			local active_timeout_id = timeout_id;
			timeout_id = nil;
			pcall(function ()
				timer.cancel(active_timeout_id);
			end);
		end
		if type(callback) == "function" then
			callback(payload, err);
		end
	end

	local token = load_token();
	if token == "" then
		finish(nil, "No auth token. Expected %LOCALAPPDATA%\\pi-speak\\http-token or CONFIG.token.");
		return;
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

	local request = {
		method = string.lower(method),
		url = CONFIG.base_url .. path,
		mime = "application/json",
		headers = headers
	};
	if body ~= nil then
		local encoded_ok, content = pcall(function ()
			return data.tojson(body);
		end);
		if not encoded_ok then
			finish(nil, "Could not encode request JSON.");
			return;
		end
		request.content = content;
	end

	timeout_id = timer.timeout(function ()
		finish(nil, "Pi Speak request timed out.");
	end, CONFIG.request_timeout_ms);

	local started_ok, started_err = pcall(function ()
		http.request(request, function (err, resp)
			if err then
				finish(nil, tostring(err));
				return;
			end

			local code = get_status_code(resp);
			if code == 401 or code == 403 then
				finish(nil, "Unauthorized (token rejected).");
				return;
			end
			if code == 405 then
				finish(nil, "Method not allowed.");
				return;
			end

			local text = get_body(resp);
			if text == "" then
				if code >= 200 and code < 300 then
					finish({ ok = true }, nil);
				else
					finish(nil, "HTTP " .. tostring(code) .. " returned an empty response.");
				end
				return;
			end

			local parsed_ok, payload = pcall(function ()
				return data.fromjson(text);
			end);
			if not parsed_ok or type(payload) ~= "table" then
				finish(nil, "Invalid JSON response.");
				return;
			end
			if json_false(payload.ok) or code >= 400 then
				finish(nil, tostring(payload.error or payload.message or ("HTTP " .. tostring(code))));
				return;
			end

			finish(payload, nil);
		end);
	end);
	if not started_ok then
		finish(nil, tostring(started_err));
	end
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

local function call_endpoint(method, path, on_success, body, on_error)
	request_json(method, path, body, nil, function (payload, err)
		if not payload then
			if type(on_error) == "function" then
				on_error(err);
			else
				set_status("Pi Speak call failed. (" .. err .. ")");
			end
			return;
		end

		if type(on_success) == "function" then
			on_success(payload);
		end

		if type(payload.message) == "string" and trim(payload.message) ~= "" then
			set_status(payload.message);
		end
	end);
end

local function update_collab_view()
	local link_text = "No active Collab link.";
	if collab_web_link then
		link_text = "Collaborate: " .. collab_web_link;
		if collab_view_link then
			link_text = link_text .. "\nView only: " .. collab_view_link;
		end
	end

	server.update({
		{ id = "collabstatus", text = collab_status },
		{ id = "collablink", text = link_text }
	});
end

local function clear_collab_links(status)
	collab_web_link = nil;
	collab_view_link = nil;
	collab_status = status;
	update_collab_view();
end

local function begin_collab_operation(status)
	collab_operation_id = collab_operation_id + 1;
	collab_pending = true;
	clear_collab_links(status);
	return collab_operation_id;
end

local function finish_collab_operation(operation_id)
	if operation_id ~= collab_operation_id then
		return false;
	end
	collab_pending = false;
	return true;
end

local function refresh_collab_link(on_complete)
	local operation_id = begin_collab_operation("Checking for an active Collab link...");
	local function complete(active, payload)
		if type(on_complete) == "function" then
			on_complete(active, payload);
		end
	end

	request_json("GET", "/v1/collab-link", nil, nil, function (payload, err)
		if not finish_collab_operation(operation_id) then
			return;
		end
		if not payload then
			clear_collab_links("Collab link unavailable: " .. err);
			complete(false, nil);
			return;
		end

		local collab = payload.collab;
		if type(collab) ~= "table" then
			clear_collab_links("No active Collab link.");
			complete(false, payload);
			return;
		end

		if not json_true(collab.active) then
			clear_collab_links("No active Collab link.");
			complete(false, payload);
			return;
		end

		local web_link = approved_collab_url(collab.webLink);
		if not web_link then
			clear_collab_links("Refused a Collab link outside the approved HTTPS origin.");
			complete(false, payload);
			return;
		end

		local raw_view_link = trim(collab.webViewLink);
		local view_link = approved_collab_url(raw_view_link);
		if raw_view_link ~= "" and not view_link then
			clear_collab_links("Refused a view-only link outside the approved HTTPS origin.");
			complete(false, payload);
			return;
		end

		collab_web_link = web_link;
		collab_view_link = view_link;
		collab_status = "Collab is active. Use the link below on another device, or open it on this PC.";
		update_collab_view();
		complete(true, payload);
	end);
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
	call_endpoint("GET", "/v1/sessions/live", function (payload)
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
	end, nil, function (err)
		live_sessions = {};
		session_by_index = {};
		update_session_list();
		set_status("Herdr sessions failed: " .. err);
	end);
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
		return;
	end
	if not (session.capabilities and session.capabilities[action]) then
		set_status("Session does not support " .. action .. ".");
		return;
	end

	local body = extra_body or {};
	body.expectedRevision = session.revision;

	-- Session ids are s_<24 hex> (sessionIdForAgent); no URL encoding needed.
	local path = "/v1/sessions/live/" .. session.id .. "/" .. action;
	request_json("POST", path, body, {
		["X-Pi-Speak-Idempotency-Key"] = new_idempotency_key()
	}, function (payload, err)
		if not payload then
			set_status("Session " .. action .. " failed: " .. err);
			return;
		end

		set_status("Session " .. action .. " ok: " .. tostring(session.displayName or session.id));
		refresh_sessions();
	end);
end

actions.refresh = function ()
	call_endpoint("GET", "/v1/status", function (resp)
		if type(resp.status) == "table" then
			set_status(summarize_status(resp.status));
		end
		if trim(last_reply) == "" then
			set_reply("No reply yet.");
		end
	end);
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

	prompt_request_id = prompt_request_id + 1;
	local request_id = prompt_request_id;
	set_status("Sending prompt...");
	request_json("POST", "/v1/turn/text", { text = prompt, audio = false }, nil, function (resp, err)
		if request_id ~= prompt_request_id then
			return;
		end
		if not resp then
			set_status("Turn failed: " .. tostring(err or "Unknown error."));
			return;
		end
		if type(resp.replyText) == "string" and trim(resp.replyText) ~= "" then
			set_reply(resp.replyText);
			set_status("Turn complete.");
		else
			set_status("Turn completed but no reply text was returned.");
		end
	end);
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

-- Collaboration launch and handoff

actions.set_collab_workspace = function (text)
	collab_workspace_text = text or "";
end

actions.collab_launch = function ()
	local body = { targetNode = "colab" };
	local workspace = trim(collab_workspace_text);
	if workspace ~= "" then
		body.cwd = workspace;
	end

	local operation_id = begin_collab_operation("Requesting a Collab launch...");
	request_json("POST", "/v1/sessions/launch", body, nil, function (payload, err)
		if not finish_collab_operation(operation_id) then
			return;
		end
		if not payload then
			clear_collab_links("Collab launch failed: " .. err);
			set_status("Collab launch failed.");
			return;
		end

		clear_collab_links("Collab launch requested. Refresh when the deployment is ready.");
		local message = trim(payload.message);
		set_status(message ~= "" and message or "Collab launch requested.");
	end);
end

actions.collab_refresh = function ()
	refresh_collab_link(function ()
		set_status(collab_status);
	end);
end

actions.collab_open_host = function ()
	local function open_cached_link()
		local safe_link = approved_collab_url(collab_web_link);
		if not safe_link then
			clear_collab_links("Refused a Collab link outside the approved HTTPS origin.");
			set_status(collab_status);
			return;
		end

		local ok, result = pcall(function ()
			return os.open(safe_link);
		end);
		if not ok or result == false then
			collab_status = "Could not open the collaborator link on this PC.";
			update_collab_view();
			set_status(collab_status);
			return;
		end

		collab_status = "Opened the collaborator link on this PC.";
		update_collab_view();
		set_status(collab_status);
	end

	if collab_pending then
		set_status("A Collab request is still pending.");
	elseif collab_web_link then
		open_cached_link();
	else
		refresh_collab_link(function (active)
			if active then
				open_cached_link();
			else
				set_status(collab_status);
			end
		end);
	end
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
