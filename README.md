# pi-web

A pi extension that adds two web-aware tools:

- `websearch`: searches the web using public search endpoints
- `webfetch`: fetches a webpage, converts it to markdown, and answers a question about it

It also nudges pi to use these tools when the user includes a URL or asks for current / external information.

## Features

- Keyless web search fallback flow (Brave, then DuckDuckGo HTML)
- Webpage fetching with HTML-to-Markdown conversion
- Concise, model-generated answers grounded in fetched page content
- Automatic prompt steering for URL and web-search style prompts

## Install

```bash
npm install
```

## Check

```bash
npm run check
```

## Use in pi

This project is configured as a pi extension via:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Files

- `index.ts` — extension implementation
- `jsdom.d.ts` — TypeScript declaration shim
- `package.json` — package metadata and pi extension config
