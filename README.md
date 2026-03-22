# pi web extension

[![npm version](https://img.shields.io/npm/v/pi-web-extension)](https://www.npmjs.com/package/pi-web-extension)
[![license](https://img.shields.io/npm/l/pi-web-extension)](./LICENSE)

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that adds **web search and web fetch** tools to the coding agent.

- Keyless web search via Brave and DuckDuckGo HTML fallback
- Webpage fetching with HTML-to-Markdown conversion
- Concise, model-generated answers grounded in fetched page content
- Automatic prompt steering for URL and web-search style prompts
- Token-aware: keeps search results compact, trims fetched pages to relevant sections

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

Fetches a URL, strips non-content elements, converts the HTML to Markdown via Turndown, selects the most relevant sections using keyword scoring, then asks the active pi model to answer the user's question based on the excerpt.

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
- `prompt: string` -- the question to answer about the page content
