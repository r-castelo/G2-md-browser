import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMarkdown } from "../src/domain/markdown.js";

describe("normalizeMarkdown", () => {
  it("returns empty line for empty input", () => {
    assert.deepStrictEqual(normalizeMarkdown(""), [""]);
  });

  it("strips YAML frontmatter", () => {
    const input = "---\ntitle: Hello\n---\nContent here";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, ["Content here"]);
  });

  it("keeps content when no frontmatter", () => {
    const result = normalizeMarkdown("Just text");
    assert.deepStrictEqual(result, ["Just text"]);
  });

  it("normalizes headings to uppercase and caps at ###", () => {
    const input = "# Hello World\n## Sub Title\n#### Deep Heading";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, [
      "# HELLO WORLD",
      "## SUB TITLE",
      "### DEEP HEADING",
    ]);
  });

  it("normalizes list markers to - ", () => {
    const input = "* item one\n+ item two\n1. item three\n  - nested";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, [
      "- item one",
      "- item two",
      "- item three",
      "  - nested",
    ]);
  });

  it("strips inline links", () => {
    const input = "See [the docs](https://example.com) for details";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, ["See the docs for details"]);
  });

  it("strips bold and italic markers", () => {
    const input = "This is **bold** and *italic* and __also bold__ and _also italic_";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, [
      "This is bold and italic and also bold and also italic",
    ]);
  });

  it("indents code fence content and removes fences", () => {
    const input = "Before\n```\ncode line 1\ncode line 2\n```\nAfter";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, [
      "Before",
      "",
      "    code line 1",
      "    code line 2",
      "After",
    ]);
  });

  it("collapses consecutive blank lines", () => {
    const input = "Line 1\n\n\n\nLine 2\n\nLine 3";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, ["Line 1", "", "Line 2", "", "Line 3"]);
  });

  it("trims leading and trailing blank lines", () => {
    const input = "\n\nContent\n\n";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, ["Content"]);
  });

  it("handles tabs as double spaces", () => {
    const input = "\tindented line";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, ["  indented line"]);
  });

  it("normalizes CRLF line endings", () => {
    const input = "Line 1\r\nLine 2\rLine 3";
    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, ["Line 1", "Line 2", "Line 3"]);
  });

  it("handles a realistic markdown document", () => {
    const input = [
      "---",
      "title: Test",
      "---",
      "# My Document",
      "",
      "This has **bold** text and a [link](http://x.com).",
      "",
      "## Section Two",
      "",
      "- Item A",
      "* Item B",
      "",
      "```",
      "const x = 1;",
      "```",
    ].join("\n");

    const result = normalizeMarkdown(input);
    assert.deepStrictEqual(result, [
      "# MY DOCUMENT",
      "",
      "This has bold text and a link.",
      "",
      "## SECTION TWO",
      "",
      "- Item A",
      "- Item B",
      "",
      "    const x = 1;",
    ]);
  });
});
