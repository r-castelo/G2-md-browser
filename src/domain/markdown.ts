const FRONTMATTER_DELIMITER = /^---\s*$/;
const FENCE_PATTERN = /^```/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)\s*$/;
const LIST_PATTERN = /^(\s*)([-*+]|\d+\.)\s+/;
const LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;
const ITALIC_PATTERN = /(?<!\*)\*([^*]+)\*(?!\*)/g;
const UNDERLINE_BOLD_PATTERN = /__([^_]+)__/g;
const UNDERLINE_ITALIC_PATTERN = /(?<!_)_([^_]+)_(?!_)/g;

function stripYamlFrontmatter(raw: string): string {
  const lines = raw.split("\n");
  if (!FRONTMATTER_DELIMITER.test(lines[0] ?? "")) {
    return raw;
  }

  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIMITER.test(lines[i] ?? "")) {
      return lines.slice(i + 1).join("\n");
    }
  }

  return raw;
}

function stripInlineFormatting(line: string): string {
  return line
    .replace(LINK_PATTERN, "$1")
    .replace(BOLD_PATTERN, "$1")
    .replace(UNDERLINE_BOLD_PATTERN, "$1")
    .replace(ITALIC_PATTERN, "$1")
    .replace(UNDERLINE_ITALIC_PATTERN, "$1");
}

/** Replace non-ASCII characters that the G2 monochrome display can't render. */
function stripNonAscii(line: string): string {
  // Keep printable ASCII (0x20-0x7E) and tab
  // eslint-disable-next-line no-control-regex
  return line.replace(/[^\x09\x20-\x7E]/g, "");
}

function normalizeHeading(line: string): string {
  const match = HEADING_PATTERN.exec(line);
  if (!match) {
    return line;
  }

  const level = Math.min((match[1] ?? "#").length, 3);
  const text = (match[2] ?? "").trim().toUpperCase();
  const marker = "#".repeat(level);
  return `${marker} ${text}`;
}

function normalizeListItem(line: string): string {
  return line.replace(LIST_PATTERN, "$1- ");
}

function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let prevBlank = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const isBlank = trimmed.trim().length === 0;

    if (isBlank) {
      if (!prevBlank) {
        result.push("");
      }
      prevBlank = true;
      continue;
    }

    prevBlank = false;
    result.push(trimmed);
  }

  // Trim leading/trailing blanks
  while (result[0] === "") {
    result.shift();
  }
  while (result[result.length - 1] === "") {
    result.pop();
  }

  return result;
}

/**
 * Normalize raw markdown into an array of plain text lines suitable for the
 * G2 monochrome display. Strips formatting, normalizes structure, and
 * produces lines ready for word-wrapping and pagination.
 */
export function normalizeMarkdown(raw: string): string[] {
  const noFrontmatter = stripYamlFrontmatter(raw);
  const sourceLines = noFrontmatter.replace(/\r\n?/g, "\n").split("\n");

  const output: string[] = [];
  let inCodeFence = false;

  for (const originalLine of sourceLines) {
    const line = originalLine.replace(/\t/g, "  ");

    if (FENCE_PATTERN.test(line.trim())) {
      inCodeFence = !inCodeFence;
      if (inCodeFence && output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }

    if (inCodeFence) {
      output.push(`    ${line}`);
      continue;
    }

    let processed = stripInlineFormatting(line);
    processed = normalizeHeading(processed);
    processed = normalizeListItem(processed);
    processed = stripNonAscii(processed);

    output.push(processed);
  }

  const compacted = collapseBlankLines(output);
  return compacted.length > 0 ? compacted : [""];
}
