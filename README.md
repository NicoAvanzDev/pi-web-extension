# pi web extension

[![npm version](https://img.shields.io/npm/v/pi-web-extension)](https://www.npmjs.com/package/pi-web-extension)
[![license](https://img.shields.io/npm/l/pi-web-extension)](./LICENSE)

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that adds **web search and web fetch** tools to the coding agent.

- Keyless web search via Brave and DuckDuckGo HTML fallback
- Webpage fetching with HTML-to-Markdown conversion, saved to a temp file
- Agent reads fetched content in chunks via the read tool — no context bloat
- Automatic prompt steering for URL and web-search style prompts
- Token-aware: keeps search results compact, trims oversized pages

## Install

```bash
pi install npm:pi-web-extension
```

<details>
<summary>Alternative install methods</summary>

From the public git repo:

```bash
pi install git:github.com/NicoAvanzDev/pi-web-extension
```

From a local clone:

```bash
pi install .
```

Load without installing:

```bash
pi --no-extensions -e ./index.ts
```

</details>

## How it works

### `websearch`

Runs a keyless web search by scraping public search engines. Tries Brave first, falls back to DuckDuckGo HTML. Returns a compact list of results (title, URL, snippet).

### `webfetch`

Fetches a URL, strips non-content elements, converts the HTML to Markdown via Turndown, and saves the result to a temp file in the pi session directory. Returns metadata (file path, title, content length, preview) so the agent can read the file in chunks as needed.

### Prompt steering

Before each agent turn, the extension checks the user prompt for URLs and web-search intent patterns. When detected, it activates the web tools and injects steering instructions into the system prompt.

## Tools

The extension exposes LLM-callable tools:

- `websearch`
- `webfetch`

### `websearch`

Parameters:

- `query: string` -- the search query

### `webfetch`

Parameters:

- `url: string` -- the URL to fetch
- `format?: "markdown" | "text" | "html"` -- output format (default: `"markdown"`)
