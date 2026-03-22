import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
      description: "Output format (default: markdown)",
    }),
  ),
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
const MAX_MARKDOWN_CHARS = 200_000;
const PREVIEW_CHARS = 500;

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
      "Fetch a webpage, convert to markdown, save to a temp file, and return metadata with a preview. Use the read tool to access the full content.",
    promptSnippet: "Fetch a webpage and save its content to a local file for reading",
    promptGuidelines: [
      "Use webfetch to download a URL. Content is saved to a temp file — use the read tool to access it in chunks.",
      "The tool returns the file path, title, content length, and a short preview of the content.",
      "Do NOT ask webfetch a question. Fetch first, then read the file to find what you need.",
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
  const format = params.format ?? "markdown";
  const html = await fetchHtml(params.url, signal);

  let content: string;
  let title: string;
  let ext: string;

  if (format === "html") {
    content = html;
    title = extractTitle(html, params.url);
    ext = ".html";
  } else if (format === "text") {
    const result = htmlToMarkdown(html, params.url);
    title = result.title;
    content = stripMarkdownFormatting(result.markdown);
    ext = ".txt";
  } else {
    const result = htmlToMarkdown(html, params.url);
    title = result.title;
    content = result.markdown;
    ext = ".md";
  }

  // Trim to a reasonable max to avoid writing huge files
  if (content.length > MAX_MARKDOWN_CHARS) {
    content = trimLargeDocument(content, MAX_MARKDOWN_CHARS);
  }

  const sessionDir = ctx.sessionManager.getSessionDir();
  const filePath = await writeTempFile(sessionDir, params.url, content, ext);
  const preview = content.slice(0, PREVIEW_CHARS).trim();

  const text = [
    `File: ${filePath}`,
    title ? `Title: ${title}` : undefined,
    `Content length: ${content.length} chars`,
    "",
    "Preview:",
    preview,
  ]
    .filter((line) => line != null)
    .join("\n");

  const truncated = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  }).content;

  return {
    content: [{ type: "text" as const, text: truncated }],
    details: {
      url: params.url,
      title,
      filePath,
      contentLength: content.length,
      format,
    },
  };
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

function extractTitle(html: string, _baseUrl: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

export function stripMarkdownFormatting(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/^[-*+]\s+/gm, "") // list markers
    .replace(/^>\s+/gm, "") // blockquotes
    .replace(/^---+$/gm, "") // horizontal rules
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function urlToHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

async function writeTempFile(
  sessionDir: string,
  url: string,
  content: string,
  ext: string,
): Promise<string> {
  const dir = join(sessionDir, "tmp");
  await mkdir(dir, { recursive: true });
  const hash = urlToHash(url);
  const filePath = join(dir, `fetch-${hash}${ext}`);
  await writeFile(filePath, content, "utf-8");
  return filePath;
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
