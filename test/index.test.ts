import { describe, it, expect } from "vitest";
import {
  extractSnippet,
  trimLargeDocument,
  stripMarkdownFormatting,
  urlToHash,
  looksLikeUrlPrompt,
  looksLikeWebSearchPrompt,
  htmlToMarkdown,
} from "../index.ts";

describe("extractSnippet", () => {
  it("returns trimmed text up to max length", () => {
    const raw = "  Some long text that goes on and on  ";
    expect(extractSnippet(raw, "Other")).toBe("Some long text that goes on and on");
  });

  it("returns empty string when text matches title", () => {
    expect(extractSnippet("My Title", "My Title")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(extractSnippet("", "title")).toBe("");
  });

  it("truncates to 160 characters", () => {
    const long = "a".repeat(300);
    expect(extractSnippet(long, "title").length).toBe(160);
  });
});

describe("trimLargeDocument", () => {
  it("returns original if within budget", () => {
    expect(trimLargeDocument("short", 1000)).toBe("short");
  });

  it("trims and adds marker for oversized documents", () => {
    const doc = "x".repeat(2000);
    const trimmed = trimLargeDocument(doc, 500);
    expect(trimmed).toContain("[...content trimmed...]");
    expect(trimmed.length).toBeLessThanOrEqual(500);
  });

  it("preserves head and tail", () => {
    const doc = "HEAD" + "x".repeat(2000) + "TAIL";
    const trimmed = trimLargeDocument(doc, 500);
    expect(trimmed.startsWith("HEAD")).toBe(true);
    expect(trimmed.endsWith("TAIL")).toBe(true);
  });

  it("respects budget exactly for various sizes", () => {
    for (const budget of [100, 250, 500, 1000, 5000]) {
      const doc = "a".repeat(budget * 3);
      const trimmed = trimLargeDocument(doc, budget);
      expect(trimmed.length).toBeLessThanOrEqual(budget);
    }
  });
});

describe("stripMarkdownFormatting", () => {
  it("removes heading markers", () => {
    expect(stripMarkdownFormatting("# Hello\n## World")).toBe("Hello\nWorld");
  });

  it("removes bold and italic markers", () => {
    expect(stripMarkdownFormatting("**bold** and *italic*")).toBe("bold and italic");
  });

  it("removes inline code backticks", () => {
    expect(stripMarkdownFormatting("use `foo()` here")).toBe("use foo() here");
  });

  it("extracts link text", () => {
    expect(stripMarkdownFormatting("[click here](https://example.com)")).toBe("click here");
  });

  it("removes list markers", () => {
    expect(stripMarkdownFormatting("- item one\n* item two\n+ item three")).toBe(
      "item one\nitem two\nitem three",
    );
  });

  it("removes blockquote markers", () => {
    expect(stripMarkdownFormatting("> quoted text")).toBe("quoted text");
  });

  it("collapses excessive newlines", () => {
    expect(stripMarkdownFormatting("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("urlToHash", () => {
  it("returns a 12-char hex string", () => {
    const hash = urlToHash("https://example.com");
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("returns the same hash for the same URL", () => {
    expect(urlToHash("https://example.com")).toBe(urlToHash("https://example.com"));
  });

  it("returns different hashes for different URLs", () => {
    expect(urlToHash("https://example.com")).not.toBe(urlToHash("https://other.com"));
  });
});

describe("looksLikeUrlPrompt", () => {
  it("detects http URLs", () => {
    expect(looksLikeUrlPrompt("Check http://example.com")).toBe(true);
  });

  it("detects https URLs", () => {
    expect(looksLikeUrlPrompt("See https://docs.rs/foo")).toBe(true);
  });

  it("detects www URLs", () => {
    expect(looksLikeUrlPrompt("Go to www.example.com")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(looksLikeUrlPrompt("Just a regular question")).toBe(false);
  });
});

describe("looksLikeWebSearchPrompt", () => {
  it("detects 'latest' keyword", () => {
    expect(looksLikeWebSearchPrompt("What is the latest version of Node?")).toBe(true);
  });

  it("detects 'search the web'", () => {
    expect(looksLikeWebSearchPrompt("search the web for React hooks")).toBe(true);
  });

  it("detects 'documentation'", () => {
    expect(looksLikeWebSearchPrompt("Find the documentation for Vite")).toBe(true);
  });

  it("returns false for unrelated prompts", () => {
    expect(looksLikeWebSearchPrompt("Refactor this function")).toBe(false);
  });
});

describe("htmlToMarkdown", () => {
  it("extracts title and converts body to markdown", () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body><h1>Hello</h1><p>World</p></body>
      </html>
    `;
    const result = htmlToMarkdown(html, "https://example.com");
    expect(result.title).toBe("Test Page");
    expect(result.markdown).toContain("Hello");
    expect(result.markdown).toContain("World");
  });

  it("strips script and style tags", () => {
    const html = `
      <html>
        <head><title>T</title></head>
        <body>
          <script>alert('x')</script>
          <style>.foo{}</style>
          <p>Content</p>
        </body>
      </html>
    `;
    const result = htmlToMarkdown(html, "https://example.com");
    expect(result.markdown).not.toContain("alert");
    expect(result.markdown).not.toContain(".foo");
    expect(result.markdown).toContain("Content");
  });

  it("prefers main/article content", () => {
    const html = `
      <html>
        <head><title>T</title></head>
        <body>
          <nav>Navigation</nav>
          <main><p>Main content here</p></main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    const result = htmlToMarkdown(html, "https://example.com");
    expect(result.markdown).toContain("Main content here");
  });
});
