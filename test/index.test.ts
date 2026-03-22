import { describe, it, expect } from "vitest";
import {
  extractSnippet,
  extractKeywords,
  scoreSection,
  compactWhitespace,
  trimLargeDocument,
  splitMarkdownSections,
  selectRelevantMarkdown,
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

describe("extractKeywords", () => {
  it("extracts non-stopword keywords", () => {
    const result = extractKeywords("How to install the package");
    expect(result).toContain("install");
    expect(result).toContain("package");
    expect(result).not.toContain("how");
    expect(result).not.toContain("the");
  });

  it("returns empty array for stopwords-only input", () => {
    expect(extractKeywords("the and or is")).toEqual([]);
  });

  it("deduplicates keywords", () => {
    const result = extractKeywords("install install install");
    expect(result).toEqual(["install"]);
  });

  it("limits to 12 keywords", () => {
    const words = Array.from({ length: 20 }, (_, i) => `keyword${i}`).join(" ");
    expect(extractKeywords(words).length).toBe(12);
  });
});

describe("scoreSection", () => {
  it("gives bonus for first section", () => {
    const score0 = scoreSection("some text", [], 0);
    const score1 = scoreSection("some text", [], 1);
    expect(score0).toBeGreaterThan(score1);
  });

  it("scores higher when keywords match", () => {
    const withKeyword = scoreSection("install the package", ["install"], 1);
    const withoutKeyword = scoreSection("hello world here", ["install"], 1);
    expect(withKeyword).toBeGreaterThan(withoutKeyword);
  });

  it("gives heading bonus", () => {
    const withHeading = scoreSection("# install guide", ["install"], 1);
    const noHeading = scoreSection("install guide text", ["install"], 1);
    expect(withHeading).toBeGreaterThan(noHeading);
  });
});

describe("compactWhitespace", () => {
  it("collapses multiple spaces to one", () => {
    expect(compactWhitespace("a   b    c")).toBe("a b c");
  });

  it("collapses 3+ newlines to 2", () => {
    expect(compactWhitespace("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(compactWhitespace("  hello  ")).toBe("hello");
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

describe("splitMarkdownSections", () => {
  it("splits on heading markers", () => {
    const md = "# Intro\nSome text\n# Next\nMore text";
    const sections = splitMarkdownSections(md);
    expect(sections.length).toBe(2);
    expect(sections[0]).toContain("Intro");
    expect(sections[1]).toContain("Next");
  });

  it("falls back to paragraph splitting for no headings", () => {
    const longPara = "a".repeat(100);
    const md = `${longPara}\n\n${longPara}\n\n${longPara}`;
    const sections = splitMarkdownSections(md);
    expect(sections.length).toBe(3);
  });

  it("filters short paragraphs in fallback mode", () => {
    const md = "short\n\nshort\n\n" + "a".repeat(100);
    const sections = splitMarkdownSections(md);
    expect(sections.length).toBe(1);
  });
});

describe("selectRelevantMarkdown", () => {
  it("returns original if within budget", () => {
    const md = "Some short markdown";
    expect(selectRelevantMarkdown(md, "query", 1000)).toBe(md);
  });

  it("selects relevant sections for long documents", () => {
    const sections = Array.from({ length: 20 }, (_, i) => `# Section ${i}\n${"x".repeat(200)}`);
    const md = sections.join("\n");
    const result = selectRelevantMarkdown(md, "Section 5", 500);
    expect(result.length).toBeLessThanOrEqual(500);
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
