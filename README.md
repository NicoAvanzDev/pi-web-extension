# pi-web-extension

A [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that adds two web-aware tools:

- **`websearch`** -- searches the web using public search endpoints (keyless)
- **`webfetch`** -- fetches a webpage, extracts the most relevant content, and answers a question about it

It also nudges pi to use these tools when the user includes a URL or asks for current / external information.

## Features

- Keyless web search fallback flow (Brave, then DuckDuckGo HTML)
- Webpage fetching with HTML-to-Markdown conversion
- Concise, model-generated answers grounded in fetched page content
- Automatic prompt steering for URL and web-search style prompts
- Token-aware behavior:
  - enables `websearch` / `webfetch` only when a prompt likely needs them
  - keeps search results compact
  - trims fetched pages to relevant sections before sending them to the model
  - reduces fetch-answer output budgets for lower token use

## Install

```bash
pi install pi-web-extension
```

<details>
<summary>Alternative install methods</summary>

Install from local checkout:

```bash
pi install .
```

Load without installing:

```bash
pi --no-extensions -e ./index.ts
```

</details>

## Development

```bash
npm install
```

Run the full check suite (tests + lint + format check):

```bash
npm run check
```

Run individually:

```bash
npm test            # vitest
npm run lint        # oxlint
npm run fmt:check   # oxfmt --check
npm run fmt         # oxfmt (auto-format)
```

## How it works

The extension registers two tools with pi:

### `websearch`

Runs a keyless web search by scraping public search engines. Tries Brave first, falls back to DuckDuckGo HTML. Returns a compact list of results (title, URL, snippet).

### `webfetch`

Fetches a URL, strips non-content elements, converts the HTML to Markdown via Turndown, selects the most relevant sections using keyword scoring, then asks the active pi model to answer the user's question based on the excerpt.

### Prompt steering

Before each agent turn, the extension checks the user prompt for URLs and web-search intent patterns. When detected, it activates the web tools and injects steering instructions into the system prompt.

## Files

- `index.ts` -- extension implementation
- `vitest.config.ts` -- test configuration
- `test/` -- test suite
