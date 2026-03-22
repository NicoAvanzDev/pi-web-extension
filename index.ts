import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
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

const WEB_TOOLS = ["websearch", "webfetch"] as const;
const MAX_SEARCH_RESULTS = 4;
const MAX_SEARCH_SNIPPET_CHARS = 160;
const MAX_MARKDOWN_CHARS = 6_000;
const LOW_CONTEXT_MARKDOWN_CHARS = 3_500;
const FETCH_ANSWER_MAX_TOKENS = 450;
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

export default function piWeb(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    setWebToolsActive(pi, false);
  });

  pi.on("before_agent_start", async (event) => {
    const prompt = event.prompt;
    const hasUrl = looksLikeUrlPrompt(prompt);
    const likelyNeedsWeb = looksLikeWebSearchPrompt(prompt);
    const needsWebTools = hasUrl || likelyNeedsWeb;

    setWebToolsActive(pi, needsWebTools);
    if (!needsWebTools) return;

    const instructions: string[] = [];

    if (hasUrl) {
      instructions.push(
        "The prompt includes a URL. Use webfetch before answering about that page.",
      );
    }

    if (likelyNeedsWeb) {
      instructions.push(
        "The prompt likely needs external or current info. Prefer websearch over memory.",
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
    description:
      "Search the web using keyless public search endpoints and return a compact list of results",
    promptSnippet: "Search the web for relevant external pages when local files are insufficient",
    promptGuidelines: [
      "Use websearch for docs, articles, references, and current external info.",
      "Use webfetch on a promising result when the user needs details from a page.",
    ],
    parameters: websearchSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runWebsearch(params as WebsearchParams, ctx, signal);
    },
  });

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch a webpage, extract the most relevant markdown, and answer a question without dumping raw HTML",
    promptSnippet:
      "Fetch a webpage and answer a specific question about it without dumping the page",
    promptGuidelines: [
      "Use webfetch whenever the user includes a URL or asks about a specific page.",
      "Answer directly from the fetched content instead of guessing or quoting the whole page.",
    ],
    parameters: webfetchSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runWebfetch(params as WebfetchParams, ctx, signal);
    },
  });
}

function setWebToolsActive(pi: ExtensionAPI, enabled: boolean) {
  const active = new Set(pi.getActiveTools());

  for (const tool of WEB_TOOLS) {
    if (enabled) active.add(tool);
    else active.delete(tool);
  }

  pi.setActiveTools([...active]);
}

async function runWebsearch(params: WebsearchParams, _ctx: ExtensionContext, signal?: AbortSignal) {
  const results = await searchKeyless(params.query, signal);

  let text =
    results.length > 0
      ? results
          .map((result, index) => {
            const snippet = result.snippet ? `\n   ${result.snippet}` : "";
            return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
          })
          .join("\n\n")
      : `No results found for: ${params.query}`;

  text = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content;

  return {
    content: [{ type: "text" as const, text }],
    details: {
      query: params.query,
      results,
    },
  };
}

async function runWebfetch(params: WebfetchParams, ctx: ExtensionContext, signal?: AbortSignal) {
  const html = await fetchHtml(params.url, signal);
  const { title, markdown } = htmlToMarkdown(html, params.url);
  const markdownBudget = getMarkdownBudget(ctx);
  const focusedMarkdown = selectRelevantMarkdown(markdown, params.prompt, markdownBudget);

  const rawAnswer = await summarizeWithPiModel(
    {
      url: params.url,
      title,
      prompt: params.prompt,
      markdown: focusedMarkdown,
    },
    ctx,
    signal,
  );

  const answer = truncateHead(rawAnswer, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  }).content;

  return {
    content: [{ type: "text" as const, text: answer }],
    details: {
      url: params.url,
      title,
      prompt: params.prompt,
      originalMarkdownLength: markdown.length,
      selectedMarkdownLength: focusedMarkdown.length,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    },
  };
}

function getMarkdownBudget(ctx: ExtensionContext): number {
  const usage = ctx.getContextUsage();
  if (usage?.tokens != null && usage.tokens > 100_000) return LOW_CONTEXT_MARKDOWN_CHARS;
  return MAX_MARKDOWN_CHARS;
}

async function searchKeyless(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const errors: string[] = [];

  try {
    const brave = await braveSearchHtml(query, signal);
    if (brave.length > 0) return brave;
  } catch (err) {
    errors.push(`Brave: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const ddg = await duckDuckGoHtmlSearch(query, signal);
    if (ddg.length > 0) return ddg;
  } catch (err) {
    errors.push(`DuckDuckGo: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (errors.length > 0) {
    console.warn(`[pi-web] searchKeyless failed:\n${errors.join("\n")}`);
  }

  return [];
}

async function braveSearchHtml(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL("https://search.brave.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("source", "web");

  const response = await fetch(url.toString(), {
    redirect: "follow",
    signal,
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

async function duckDuckGoHtmlSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "follow",
    signal,
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
    const titleAnchor = item.querySelector(
      ".result__title a, a.result__a",
    ) as HTMLAnchorElement | null;
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

export function extractSnippet(raw: string, title: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text === title) return "";
  return text.slice(0, MAX_SEARCH_SNIPPET_CHARS);
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

export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
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
  ]) {
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

export function selectRelevantMarkdown(markdown: string, prompt: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;

  const normalized = markdown.replace(/\n{3,}/g, "\n\n").trim();
  const sections = splitMarkdownSections(normalized);
  const keywords = extractKeywords(prompt);

  if (sections.length === 0) {
    return trimLargeDocument(normalized, maxChars);
  }

  const scored = sections
    .map((section, index) => ({
      section,
      index,
      score: scoreSection(section, keywords, index),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen: string[] = [];
  let used = 0;
  const added = new Set<number>();

  for (const entry of scored) {
    if (entry.score <= 0 && used > 0) break;
    const compact = compactWhitespace(entry.section).slice(0, 1_500).trim();
    if (!compact || added.has(entry.index)) continue;
    if (used + compact.length + 2 > maxChars) continue;
    chosen.push(compact);
    used += compact.length + 2;
    added.add(entry.index);
    if (used >= Math.floor(maxChars * 0.85)) break;
  }

  if (chosen.length === 0) {
    return trimLargeDocument(normalized, maxChars);
  }

  const introBudget = Math.max(0, maxChars - used - 40);
  const intro = introBudget > 400 ? normalized.slice(0, Math.min(introBudget, 800)).trim() : "";

  return [intro, ...chosen].filter(Boolean).join("\n\n---\n\n").slice(0, maxChars).trim();
}

export function splitMarkdownSections(markdown: string): string[] {
  const sections = markdown
    .split(/\n(?=# )|\n(?=## )|\n(?=### )|\n(?=#### )/)
    .map((section) => section.trim())
    .filter(Boolean);

  if (sections.length > 1) return sections;

  return markdown
    .split(/\n\n+/)
    .map((section) => section.trim())
    .filter((section) => section.length >= 80);
}

export function extractKeywords(prompt: string): string[] {
  const words = prompt.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const unique = new Set<string>();

  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    unique.add(word);
  }

  return [...unique].slice(0, 12);
}

export function scoreSection(section: string, keywords: string[], index: number): number {
  const haystack = section.toLowerCase();
  let score = index === 0 ? 2 : 0;

  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 5;
    if (haystack.includes(`# ${keyword}`) || haystack.includes(`## ${keyword}`)) score += 3;
  }

  if (section.startsWith("# ")) score += 1;
  if (section.length < 2_000) score += 1;

  return score;
}

export function compactWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function trimLargeDocument(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;

  const marker = "\n\n[...content trimmed...]\n\n";
  const budget = maxChars - marker.length;
  const headSize = Math.floor(budget * 0.75);
  const tailSize = budget - headSize;

  const head = markdown.slice(0, headSize).trimEnd();
  const tail = markdown.slice(-tailSize).trimStart();

  return `${head}${marker}${tail}`.slice(0, maxChars);
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
        "Answer the question using only the provided page excerpt. Be concise, direct, and mention uncertainty if the excerpt is insufficient.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Question: ${input.prompt}`,
                `URL: ${input.url}`,
                input.title ? `Title: ${input.title}` : undefined,
                "",
                "Excerpt:",
                input.markdown,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      signal,
      maxTokens: FETCH_ANSWER_MAX_TOKENS,
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

export function looksLikeUrlPrompt(prompt: string): boolean {
  return /(https?:\/\/\S+|www\.\S+)/i.test(prompt);
}

export function looksLikeWebSearchPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();

  const patterns = [
    /\b(latest|recent|current|today|yesterday|this week|news)\b/,
    /\b(search the web|look online|find online|search online|web search|google)\b/,
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
