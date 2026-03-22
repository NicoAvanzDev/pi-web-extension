# AGENTS.md

Guidance for agents working in this repository.

## Project overview

This repo is a **pi extension** that adds web search and web fetch tools to the coding agent.

Main behavior:

- registers `websearch` and `webfetch` tools with pi
- keyless web search via Brave and DuckDuckGo HTML fallback
- webpage fetching with HTML-to-Markdown conversion (Turndown)
- model-generated answers grounded in fetched page content
- prompt steering: detects URLs and web-search intent to auto-activate tools
- token-aware: keeps results compact, trims pages to relevant sections

## Important files

- `index.ts` — main extension entrypoint and pi runtime wiring
- `vitest.config.ts` — Vitest test runner configuration
- `README.md` — user-facing usage docs
- `test/index.test.ts` — unit tests (Vitest)
- `package.json` — package metadata and scripts

## Tools

LLM-callable tools:

- `websearch` — runs a keyless web search by scraping public search engines
- `webfetch` — fetches a URL, extracts content, answers a question about it

## Development conventions

- Keep `index.ts` as the single extension file.
- When adding behavior that can be tested without pi runtime, extract it and add tests.
- Prefer pure functions for testable logic.

## Testing

Run tests with:

```bash
npm test
```

Test stack:

- [Vitest](https://vitest.dev/) test runner
- `.test.ts` files in `test/`
- `describe`/`it`/`expect` API

When adding logic:

- add/extend unit tests for pure helpers
- avoid introducing untestable logic when a pure function extraction is easy

## Linting

Lint with [oxlint](https://oxc.rs/docs/guide/usage/linter.html) (zero-config):

```bash
npm run lint
```

## Formatting

Format with [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) (Prettier-compatible, zero-config):

```bash
npm run fmt          # format in place
npm run fmt:check    # check only (CI)
```

## Full check

Run tests, linting, and formatting check together:

```bash
npm run check
```

## Editing guidance

- Read files before editing.
- Make focused changes.
- Update `README.md` when user-facing commands or behavior change.

## Notes about runtime

This package is intended to run inside pi, so local validation is mostly:

- unit tests
- careful review of TypeScript changes
- keeping side effects localized in `index.ts`

If runtime-specific behavior is changed, document it in `README.md`.
