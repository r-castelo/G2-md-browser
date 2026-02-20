import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wrapLine, wrapLines, paginate, getPageText } from "../src/domain/paginate.js";

describe("wrapLine", () => {
  it("returns short lines unchanged", () => {
    assert.deepStrictEqual(wrapLine("hello", 10), ["hello"]);
  });

  it("wraps at word boundaries", () => {
    assert.deepStrictEqual(wrapLine("hello world foo", 11), [
      "hello world",
      "foo",
    ]);
  });

  it("preserves leading whitespace", () => {
    assert.deepStrictEqual(wrapLine("    code that is long", 15), [
      "    code that",
      "    is long",
    ]);
  });

  it("breaks words longer than effective width", () => {
    const result = wrapLine("abcdefghij", 5);
    assert.deepStrictEqual(result, ["abcde", "fghij"]);
  });

  it("handles empty lines", () => {
    assert.deepStrictEqual(wrapLine("", 10), [""]);
  });

  it("handles maxChars <= 0", () => {
    assert.deepStrictEqual(wrapLine("hello", 0), ["hello"]);
  });
});

describe("wrapLines", () => {
  it("wraps multiple lines", () => {
    const result = wrapLines(["short", "this is a longer line"], 10);
    assert.deepStrictEqual(result, [
      "short",
      "this is a",
      "longer",
      "line",
    ]);
  });

  it("returns empty line for empty input", () => {
    assert.deepStrictEqual(wrapLines([], 10), [""]);
  });
});

describe("paginate", () => {
  it("splits lines into pages", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const result = paginate(lines, 2);
    assert.deepStrictEqual(result, [["a", "b"], ["c", "d"], ["e"]]);
  });

  it("handles lines that fit in one page", () => {
    const lines = ["a", "b"];
    const result = paginate(lines, 5);
    assert.deepStrictEqual(result, [["a", "b"]]);
  });

  it("handles empty input", () => {
    const result = paginate([], 5);
    assert.deepStrictEqual(result, [[]]);
  });
});

describe("getPageText", () => {
  it("joins page lines with newlines", () => {
    const pages = [["line 1", "line 2"], ["line 3"]];
    assert.strictEqual(getPageText(pages, 0, 3), "line 1\nline 2\n");
  });

  it("pads short pages with empty lines", () => {
    const pages = [["line 1"]];
    const text = getPageText(pages, 0, 3);
    assert.strictEqual(text, "line 1\n\n");
  });

  it("clamps out-of-bounds index", () => {
    const pages = [["a"], ["b"]];
    assert.strictEqual(getPageText(pages, 5, 1), "b");
    assert.strictEqual(getPageText(pages, -1, 1), "a");
  });
});
