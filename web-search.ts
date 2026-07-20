/**
 * Server-side web search for realtime voice tools.
 * Key stays on the gateway (SERPER_API_KEY / PI_SPEAK_SERPER_API_KEY) — never
 * shipped to the browser. Mirrors HF realtime's /api/search proxy pattern.
 */

export type WebSearchResult = {
	title: string;
	link: string;
	snippet: string;
};

export type WebSearchResponse = {
	ok: true;
	query: string;
	answer?: string;
	results: WebSearchResult[];
} | {
	ok: false;
	error: string;
};

const SERPER_URL = "https://google.serper.dev/search";
const DEFAULT_MAX_RESULTS = 5;

export function getSerperApiKey(env: NodeJS.ProcessEnv = process.env): string {
	return (env.PI_SPEAK_SERPER_API_KEY || env.SERPER_API_KEY || "").trim();
}

export function isWebSearchConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return getSerperApiKey(env).length > 0;
}

type SerperOrganic = {
	title?: unknown;
	link?: unknown;
	snippet?: unknown;
};

type SerperBody = {
	answerBox?: { answer?: unknown; snippet?: unknown };
	organic?: SerperOrganic[];
};

function asTrimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Run a Google search via Serper.dev. Pure enough to unit-test with a custom fetch.
 */
export async function runWebSearch(
	query: string,
	options: {
		apiKey?: string;
		maxResults?: number;
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
	} = {},
): Promise<WebSearchResponse> {
	const trimmed = query.trim();
	if (!trimmed) return { ok: false, error: "Query is empty." };

	const apiKey = (options.apiKey ?? getSerperApiKey()).trim();
	if (!apiKey) return { ok: false, error: "Web search is not configured (set SERPER_API_KEY)." };

	const maxResults = Math.min(Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1), 10);
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 12_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetchImpl(SERPER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-KEY": apiKey,
			},
			body: JSON.stringify({ q: trimmed, num: maxResults }),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return {
				ok: false,
				error: `Search provider returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
			};
		}
		const payload = (await response.json()) as SerperBody;
		const organic = Array.isArray(payload.organic) ? payload.organic : [];
		const results: WebSearchResult[] = [];
		for (const item of organic) {
			if (results.length >= maxResults) break;
			const title = asTrimmedString(item?.title);
			const link = asTrimmedString(item?.link);
			const snippet = asTrimmedString(item?.snippet);
			if (!title && !link) continue;
			results.push({ title: title || link, link, snippet });
		}
		const answer =
			asTrimmedString(payload.answerBox?.answer) ||
			asTrimmedString(payload.answerBox?.snippet) ||
			undefined;
		return { ok: true, query: trimmed, answer, results };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.toLowerCase().includes("abort")) {
			return { ok: false, error: "Search timed out." };
		}
		return { ok: false, error: `Search failed: ${message}` };
	} finally {
		clearTimeout(timer);
	}
}

/** Compact text the voice model can speak about. */
export function formatWebSearchForSpeech(result: Extract<WebSearchResponse, { ok: true }>): string {
	const lines: string[] = [];
	if (result.answer) lines.push(`Answer box: ${result.answer}`);
	result.results.forEach((item, index) => {
		lines.push(`${index + 1}. ${item.title}${item.snippet ? ` — ${item.snippet}` : ""}${item.link ? ` (${item.link})` : ""}`);
	});
	if (lines.length === 0) return `No results for "${result.query}".`;
	return `Search results for "${result.query}":\n${lines.join("\n")}`;
}
