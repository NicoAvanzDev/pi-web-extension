import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const websearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "The search query to run",
	}),
});

const webfetchSchema = Type.Object({
	url: Type.String({
		minLength: 1,
		description: "The URL to fetch",
	}),
	prompt: Type.String({
		minLength: 1,
		description: "The question to answer about the page",
	}),
});

type WebsearchParams = Static<typeof websearchSchema>;
type WebfetchParams = Static<typeof webfetchSchema>;

type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	source: "brave" | "duckduckgo";
};

const MAX_SEARCH_RESULTS = 5;
const MAX_MARKDOWN_CHARS = 12_000;

export default function piWeb(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const prompt = event.prompt;
		const hasUrl = looksLikeUrlPrompt(prompt);
		const likelyNeedsWeb = looksLikeWebSearchPrompt(prompt);

		if (!hasUrl && !likelyNeedsWeb) return;

		const instructions: string[] = [];

		if (hasUrl) {
			instructions.push(
				"The user included a URL.",
				"Use the webfetch tool before answering questions about that page.",
				"Do not guess page contents from the URL alone.",
			);
		}

		if (likelyNeedsWeb) {
			instructions.push(
				"The user likely needs current or external web information.",
				"Prefer using websearch instead of relying only on model memory.",
				"If a search result looks promising and the user needs details, use webfetch on that URL.",
			);
		}

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n## pi-web steering\n" +
				instructions.map((line) => `- ${line}`).join("\n"),
		};
	});

	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description: "Search the web using keyless public search endpoints and return a compact list of results",
		promptSnippet: "Search the web for relevant external pages when local files are insufficient",
		promptGuidelines: [
			"Use websearch for docs, articles, references, and general web lookup.",
			"Use websearch whenever the user asks for recent, current, or external information.",
			"Use webfetch on promising results if the user needs details from a page.",
		],
		parameters: websearchSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return runWebsearch(params as WebsearchParams, ctx);
		},
	});

	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a webpage, convert it to markdown, trim large pages, and answer a question using the active pi model",
		promptSnippet: "Fetch a webpage and answer a specific question about it without dumping raw HTML",
		promptGuidelines: [
			"Use webfetch whenever the user includes a URL or asks about a specific page.",
			"Do not answer questions about a provided URL from memory alone; fetch it first.",
			"Answer the user's question directly instead of returning raw page content.",
		],
		parameters: webfetchSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runWebfetch(params as WebfetchParams, ctx, signal);
		},
	});
}

async function runWebsearch(params: WebsearchParams, _ctx: ExtensionContext) {
	const results = await searchKeyless(params.query);

	const text =
		results.length > 0
			? results
					.map(
						(result, index) =>
							`${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ""}`,
					)
					.join("\n\n")
			: `No results found for: ${params.query}`;

	return {
		content: [{ type: "text", text } as const],
		details: {
			query: params.query,
			results,
		},
	};
}

async function runWebfetch(params: WebfetchParams, ctx: ExtensionContext, signal?: AbortSignal) {
	const html = await fetchHtml(params.url, signal);
	const { title, markdown } = htmlToMarkdown(html, params.url);
	const trimmedMarkdown = trimLargeDocument(markdown, MAX_MARKDOWN_CHARS);

	const answer = await summarizeWithPiModel(
		{
			url: params.url,
			title,
			prompt: params.prompt,
			markdown: trimmedMarkdown,
		},
		ctx,
		signal,
	);

	return {
		content: [{ type: "text", text: answer } as const],
		details: {
			url: params.url,
			title,
			prompt: params.prompt,
			originalMarkdownLength: markdown.length,
			trimmedMarkdownLength: trimmedMarkdown.length,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		},
	};
}

async function searchKeyless(query: string): Promise<SearchResult[]> {
	try {
		const brave = await braveSearchHtml(query);
		if (brave.length > 0) return brave;
	} catch {
		// ignore and fall back
	}

	try {
		const ddg = await duckDuckGoHtmlSearch(query);
		if (ddg.length > 0) return ddg;
	} catch {
		// ignore
	}

	return [];
}

async function braveSearchHtml(query: string): Promise<SearchResult[]> {
	const url = new URL("https://search.brave.com/search");
	url.searchParams.set("q", query);
	url.searchParams.set("source", "web");

	const response = await fetch(url.toString(), {
		redirect: "follow",
		headers: browserHeaders(),
	});

	if (!response.ok) {
		throw new Error(`Brave search failed with status ${response.status}`);
	}

	const html = await response.text();
	const dom = new JSDOM(html, { url: url.toString() });
	const document = dom.window.document;

	const anchors = Array.from(
		document.querySelectorAll<HTMLAnchorElement>(
			[
				"a[data-testid='result-title-a']",
				".snippet.fdb a",
				".result h2 a",
				"a.heading-serpresult",
			].join(", "),
		),
	);

	const results: SearchResult[] = [];
	const seen = new Set<string>();

	for (const anchor of anchors) {
		const href = anchor.href?.trim();
		const title = anchor.textContent?.replace(/\s+/g, " ").trim() ?? "";

		if (!href || !title) continue;
		if (!/^https?:\/\//i.test(href)) continue;
		if (href.includes("search.brave.com")) continue;
		if (seen.has(href)) continue;

		const container =
			anchor.closest("[data-type='web']") ??
			anchor.closest(".snippet") ??
			anchor.closest(".fdb") ??
			anchor.parentElement;

		const snippet = extractSnippet(container?.textContent ?? "", title);

		seen.add(href);
		results.push({
			title,
			url: href,
			snippet,
			source: "brave",
		});

		if (results.length >= MAX_SEARCH_RESULTS) break;
	}

	return results;
}

async function duckDuckGoHtmlSearch(query: string): Promise<SearchResult[]> {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);

	const response = await fetch(url.toString(), {
		method: "GET",
		redirect: "follow",
		headers: browserHeaders(),
	});

	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed with status ${response.status}`);
	}

	const html = await response.text();
	const dom = new JSDOM(html, { url: url.toString() });
	const document = dom.window.document;

	const results: SearchResult[] = [];
	const seen = new Set<string>();

	const items = Array.from(document.querySelectorAll<Element>(".result"));

	for (const item of items) {
		const titleAnchor = item.querySelector(".result__title a, a.result__a") as HTMLAnchorElement | null;
		if (!titleAnchor) continue;

		const href = titleAnchor.href?.trim();
		const title = titleAnchor.textContent?.replace(/\s+/g, " ").trim() ?? "";

		if (!href || !title) continue;
		if (!/^https?:\/\//i.test(href)) continue;
		if (seen.has(href)) continue;

		const snippetNode =
			item.querySelector(".result__snippet") ??
			item.querySelector(".result__body") ??
			item.querySelector(".result__extras");

		const snippet = extractSnippet(snippetNode?.textContent ?? "", title);

		seen.add(href);
		results.push({
			title,
			url: href,
			snippet,
			source: "duckduckgo",
		});

		if (results.length >= MAX_SEARCH_RESULTS) break;
	}

	return results;
}

function extractSnippet(raw: string, title: string): string {
	const text = raw.replace(/\s+/g, " ").trim();
	if (!text || text === title) return "";
	return text.slice(0, 240);
}

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		redirect: "follow",
		signal,
		headers: browserHeaders(),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Failed to fetch URL (${response.status}): ${body.slice(0, 500)}`);
	}

	return response.text();
}

function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
	const dom = new JSDOM(html, { url: baseUrl });
	const document = dom.window.document;

	for (const selector of [
		"script",
		"style",
		"noscript",
		"iframe",
		"svg",
		"canvas",
		"form",
		"nav",
		"aside",
		"footer",
		"header",
	] as const) {
		document.querySelectorAll(selector).forEach((el: Element) => el.remove());
	}

	const main =
		document.querySelector("main") ??
		document.querySelector("article") ??
		document.querySelector("[role='main']") ??
		document.body;

	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});

	turndown.remove(["script", "style", "noscript", "iframe", "canvas"]);

	const title = (document.title || "").trim();
	const markdown = turndown.turndown(main?.innerHTML || "");

	return {
		title,
		markdown: markdown.replace(/\n{3,}/g, "\n\n").trim(),
	};
}

function trimLargeDocument(markdown: string, maxChars: number): string {
	if (markdown.length <= maxChars) return markdown;

	const headSize = Math.floor(maxChars * 0.7);
	const tailSize = Math.floor(maxChars * 0.3);

	const head = markdown.slice(0, headSize).trimEnd();
	const tail = markdown.slice(-tailSize).trimStart();

	return `${head}\n\n[...content trimmed for brevity...]\n\n${tail}`;
}

async function summarizeWithPiModel(
	input: {
		url: string;
		title: string;
		prompt: string;
		markdown: string;
	},
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	if (!ctx.model) {
		throw new Error("No active pi model available. Use /login or configure a model first.");
	}

	const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
	if (!apiKey) {
		throw new Error(
			`No credentials available for active model ${ctx.model.provider}/${ctx.model.id}. Use /login or configure that provider.`,
		);
	}

	const response = await complete(
		ctx.model,
		{
			systemPrompt:
				"You answer questions about webpages using only the provided markdown excerpt. Be concise, accurate, and directly answer the user's question. Never return raw HTML or dump the full page.",
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								`URL: ${input.url}`,
								`Title: ${input.title || "(untitled)"}`,
								`Question: ${input.prompt}`,
								"",
								"Page content (markdown excerpt):",
								input.markdown,
							].join("\n"),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			signal,
			maxTokens: 900,
			reasoningEffort: "minimal",
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (!text) {
		throw new Error("The model returned an empty response");
	}

	return text;
}

function looksLikeUrlPrompt(prompt: string): boolean {
	return /(https?:\/\/\S+|www\.\S+)/i.test(prompt);
}

function looksLikeWebSearchPrompt(prompt: string): boolean {
	const text = prompt.toLowerCase();

	const patterns = [
		/\b(latest|recent|current|today|yesterday|this week|news)\b/,
		/\b(search the web|look online|find online|search online|web search)\b/,
		/\b(documentation|docs|release notes|changelog|blog post|article)\b/,
		/\bwhat changed\b/,
		/\bup to date\b/,
		/\bon the web\b/,
	];

	return patterns.some((re) => re.test(text));
}

function browserHeaders(): HeadersInit {
	return {
		"User-Agent":
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
	};
}
