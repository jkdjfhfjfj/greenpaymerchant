import { createElement, type ReactNode } from "react";

export type LegalInline =
  | { type: "text"; value: string }
  | { type: "strong" | "emphasis"; children: LegalInline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: LegalInline[] };

export type LegalBlock =
  | { type: "paragraph"; children: LegalInline[] }
  | { type: "heading"; level: number; children: LegalInline[] }
  | { type: "unordered-list"; items: LegalInline[][] }
  | { type: "ordered-list"; start: number; items: LegalInline[][] }
  | { type: "table"; headers: LegalInline[][]; rows: LegalInline[][][] }
  | { type: "blockquote"; children: LegalBlock[] }
  | { type: "code-block"; value: string }
  | { type: "rule" };

const inlinePattern = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|\*[^*\n]+?\*|_[^_\n]+?_|(?:\[[^\]\n]+\]\([^) \t]+\)))/g;

function isSafeHref(href: string): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function parseLegalInline(value: string): LegalInline[] {
  const parts: LegalInline[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(inlinePattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push({ type: "text", value: value.slice(lastIndex, index) });

    if (token.startsWith("**") || token.startsWith("__")) {
      parts.push({ type: "strong", children: parseLegalInline(token.slice(2, -2)) });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      parts.push({ type: "emphasis", children: parseLegalInline(token.slice(1, -1)) });
    } else if (token.startsWith("`")) {
      parts.push({ type: "code", value: token.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link && isSafeHref(link[2])) {
        parts.push({ type: "link", href: link[2], children: parseLegalInline(link[1]) });
      } else {
        parts.push({ type: "text", value: token });
      }
    }
    lastIndex = index + token.length;
  }
  if (lastIndex < value.length) parts.push({ type: "text", value: value.slice(lastIndex) });
  return parts;
}

function listMarker(line: string):
  | { kind: "unordered"; content: string }
  | { kind: "ordered"; content: string; number: number }
  | undefined {
  const unordered = /^ {0,3}[-+*]\s+(.+)$/.exec(line);
  if (unordered) return { kind: "unordered", content: unordered[1] };
  const ordered = /^ {0,3}(\d+)[.)]\s+(.+)$/.exec(line);
  if (ordered) return { kind: "ordered", number: Number(ordered[1]), content: ordered[2] };
  return undefined;
}

function isRule(line: string): boolean {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function tableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const divider = lines[index + 1];
  if (!header?.includes("|") || !divider?.includes("|")) return false;
  const headerCells = tableCells(header);
  const dividerCells = tableCells(divider);
  return headerCells.length === dividerCells.length &&
    dividerCells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^ {0,3}#{1,6}\s+/.test(line) ||
    isRule(line) ||
    isTableStart(lines, index) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}```/.test(line) ||
    Boolean(listMarker(line));
}

export function parseLegalMarkdown(markdown: string): LegalBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: LegalBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: parseLegalInline(heading[2]) });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headerCells = tableCells(lines[index]);
      const columnCount = headerCells.length;
      const headers = headerCells.map(parseLegalInline);
      index += 2;
      const rows: LegalInline[][][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        const cells = tableCells(lines[index]).slice(0, columnCount);
        while (cells.length < columnCount) cells.push("");
        rows.push(cells.map(parseLegalInline));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^ {0,3}```/.test(line)) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^ {0,3}```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code-block", value: codeLines.join("\n") });
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", children: parseLegalMarkdown(quoteLines.join("\n")) });
      continue;
    }

    const marker = listMarker(line);
    if (marker) {
      const items: LegalInline[][] = [];
      let start = marker.kind === "ordered" ? marker.number : 1;
      const kind = marker.kind;
      while (index < lines.length) {
        const next = listMarker(lines[index]);
        if (!next || next.kind !== kind) break;
        if (kind === "ordered" && next.kind === "ordered" && items.length === 0) start = next.number;
        items.push(parseLegalInline(next.content));
        index += 1;
      }
      blocks.push(kind === "ordered"
        ? { type: "ordered-list", start, items }
        : { type: "unordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (!paragraphLines.length) {
      paragraphLines.push(line.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseLegalInline(paragraphLines.join(" ")) });
  }

  return blocks;
}

function renderInline(parts: LegalInline[]): ReactNode[] {
  return parts.map((part, index) => {
    if (part.type === "text") return part.value;
    if (part.type === "code") return createElement("code", { key: index }, part.value);
    if (part.type === "link") {
      return createElement("a", { key: index, href: part.href }, renderInline(part.children));
    }
    return createElement(part.type === "strong" ? "strong" : "em", { key: index }, renderInline(part.children));
  });
}

function renderBlocks(blocks: LegalBlock[]): ReactNode[] {
  return blocks.map((block, index) => {
    if (block.type === "rule") return createElement("hr", { key: index });
    if (block.type === "code-block") {
      return createElement("pre", { key: index }, createElement("code", null, block.value));
    }
    if (block.type === "paragraph") {
      return createElement("p", { key: index }, renderInline(block.children));
    }
    if (block.type === "heading") {
      const headingTag = `h${Math.min(block.level + 1, 6)}`;
      return createElement(headingTag, { key: index }, renderInline(block.children));
    }
    if (block.type === "table") {
      return createElement("div", { key: index, className: "public-policy-table-wrap" },
        createElement("table", null,
          createElement("thead", null,
            createElement("tr", null, block.headers.map((header, headerIndex) =>
              createElement("th", { key: headerIndex, scope: "col" }, renderInline(header)))),
          ),
          createElement("tbody", null, block.rows.map((row, rowIndex) =>
            createElement("tr", { key: rowIndex }, row.map((cell, cellIndex) =>
              createElement("td", { key: cellIndex }, renderInline(cell)))))),
        ),
      );
    }
    if (block.type === "blockquote") {
      return createElement("blockquote", { key: index }, renderBlocks(block.children));
    }
    const isOrdered = block.type === "ordered-list";
    const tag = isOrdered ? "ol" : "ul";
    const props = isOrdered ? { key: index, start: block.start } : { key: index };
    return createElement(tag, props, block.items.map((item, itemIndex) =>
      createElement("li", { key: itemIndex }, renderInline(item))));
  });
}

export function LegalPolicyMarkdown({ content }: { content: string }) {
  return <>{renderBlocks(parseLegalMarkdown(content))}</>;
}