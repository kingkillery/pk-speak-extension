local data = require("data");
local http = require("http");
local server = require("server");

local CONFIG = {
	base_url = "http://127.0.0.1:8767"
};

local prompt_text = "";
local last_status = "Run /remote on in Pi Speak first.";
local last_reply = "Text-turn replies will appear here.";

local function trim(value)
	if not value then
		return "";
	end

	value = tostring(value);
	value = value:gsub("^%s+", "");
	value = value:gsub("%s+$", "");
	return value;
end

local function update_view()
	server.update(
		{ id = "status", text = last_status },
		{ id = "reply", text = last_reply }
	);
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

local function request_json(path)
	local ok, resp = pcall(function ()
		return http.get(CONFIG.base_url .. path);
	end);

	if not ok then
		return nil, tostring(resp);
	end

	local body = get_body(resp);
	if body == "" then
		return nil, "Empty response";
	end

	local parsed_ok, payload = pcall(function ()
		return data.fromjson(body);
	end);
	if not parsed_ok or type(payload) ~= "table" then
		return nil, "Invalid JSON response";
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

local function call_endpoint(path, on_success)
	local payload, err = request_json(path);
	if not payload then
		set_status("Pi Speak API offline. Run /remote on in Pi Speak. (" .. err .. ")");
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

actions.refresh = function ()
	local payload = call_endpoint("/v1/status", function (resp)
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

	call_endpoint("/v1/turn/text?audio=0&text=" .. http.urlencode(prompt), function (resp)
		if type(resp.replyText) == "string" and trim(resp.replyText) ~= "" then
			set_reply(resp.replyText);
			set_status("Turn complete.");
		else
			set_status("Turn completed but no reply text was returned.");
		end
	end);
end

actions.mono_on = function ()
	call_endpoint("/v1/mono/on");
end

actions.mono_off = function ()
	call_endpoint("/v1/mono/off");
end

actions.speak_on = function ()
	call_endpoint("/v1/speak/on");
end

actions.speak_off = function ()
	call_endpoint("/v1/speak/off");
end

actions.speak_stop = function ()
	call_endpoint("/v1/speak/stop");
end

actions.speak_test = function ()
	call_endpoint("/v1/speak/test");
end

actions.provider_auto = function ()
	call_endpoint("/v1/speak/provider/auto");
end

actions.provider_edge = function ()
	call_endpoint("/v1/speak/provider/edge");
end

actions.provider_openai = function ()
	call_endpoint("/v1/speak/provider/openai");
end

actions.provider_elevenlabs = function ()
	call_endpoint("/v1/speak/provider/elevenlabs");
end

actions.phone_on = function ()
	call_endpoint("/v1/phone/on");
end

actions.phone_off = function ()
	call_endpoint("/v1/phone/off");
end

actions.phone_status = function ()
	call_endpoint("/v1/phone/status");
end

actions.phone_code = function ()
	call_endpoint("/v1/phone/code");
end
