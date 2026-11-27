import React from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

interface RichMathTextProps {
  text: string;
  className?: string;
}

const ARABIC_CHAR_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_BASE_LETTERS_REGEX =
  /[\u0621-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_LETTERS_REGEX = /[A-Za-zÀ-ÖØ-öø-ÿ]/g;

// Contiguous Arabic phrase run (letters + harakat + Arabic digits/punctuation + joining spaces/dashes between Arabic words)
const ARABIC_RUN_REGEX =
  /([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+(?:[\s\u200C\u200D\u060C\u061B\u061F\u0640\-–—'«»]+[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+)*)/g;

// Contiguous Latin/numeric run embedded inside an Arabic RTL line
const LATIN_RUN_IN_RTL_REGEX =
  /([A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:[._/\-'][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[._/\-'][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*)*)/g;

export function hasArabicText(text: string): boolean {
  return ARABIC_CHAR_REGEX.test(text || "");
}

export function detectLineDirection(line: string): "rtl" | "ltr" {
  const withoutMarkupAndMath = (line || "")
    .replace(/<\/?(?:u|br|img|table|tr|th|td)\b[^>]*>/gi, " ")
    .replace(/\$\$[\s\S]+?\$\$/g, " ")
    .replace(/\\\[[\s\S]+?\\\]/g, " ")
    .replace(/\\\([\s\S]+?\\\)/g, " ")
    .replace(/\$[^\s$][^$\n]*?[^\s$]\$/g, " ");

  const arabicCount = (withoutMarkupAndMath.match(ARABIC_BASE_LETTERS_REGEX) || []).length;
  if (arabicCount === 0) return "ltr";

  const latinCount = (withoutMarkupAndMath.match(LATIN_LETTERS_REGEX) || []).length;
  if (latinCount === 0) return "rtl";

  // Ignore leading list markers/quotes like "1.", "(a)", "-", "*" when checking opening language
  const trimmedBody = withoutMarkupAndMath.replace(/^[\s0-9()[\].\-–—*•"“'«»]+/, "").trim();
  const latinWords = trimmedBody.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/g) || [];
  if (/^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/.test(trimmedBody) && latinWords.length >= 2) {
    return "ltr";
  }
  if (arabicCount === latinCount && /^[A-Za-zÀ-ÖØ-öø-ÿ]/.test(trimmedBody)) {
    return "ltr";
  }

  return arabicCount >= latinCount ? "rtl" : "ltr";
}

export function isDominantlyArabic(text: string): boolean {
  if (!text) return false;
  const cleanText = text.replace(/<table\b[\s\S]*?<\/table>/gi, " ");
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const rtlLines = lines.filter((l) => detectLineDirection(l) === "rtl").length;
  return rtlLines > lines.length / 2;
}

// Segment string into plain text vs display math ($$...$$, \[...\]) vs inline math ($...$, \(...\))
interface Segment {
  type: "text" | "inline-math" | "display-math";
  content: string;
}

function tokenizeMathSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  // Regex matches $$...$$, \[...\], \(...\), or $...$ (avoiding $100 currency false-positives)
  const mathRe =
    /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^\s$][^$\n]*?[^\s$]|[^\s$0-9])\$/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mathRe.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        content: input.slice(lastIndex, match.index),
      });
    }
    if (match[1] !== undefined) {
      segments.push({ type: "display-math", content: match[1] });
    } else if (match[2] !== undefined) {
      segments.push({ type: "display-math", content: match[2] });
    } else if (match[3] !== undefined) {
      segments.push({ type: "inline-math", content: match[3] });
    } else if (match[4] !== undefined) {
      segments.push({ type: "inline-math", content: match[4] });
    }
    lastIndex = mathRe.lastIndex;
  }

  if (lastIndex < input.length) {
    segments.push({ type: "text", content: input.slice(lastIndex) });
  }

  return segments;
}

type LineToken = { type: "text" | "inline-math"; content: string };

type BlockNode =
  | { kind: "display-math"; content: string }
  | { kind: "table"; html: string }
  | { kind: "line"; tokens: LineToken[] };

function buildTextAndMathBlocks(segments: Segment[]): BlockNode[] {
  const blocks: BlockNode[] = [];
  let currentLine: LineToken[] = [];

  const flushLine = () => {
    blocks.push({ kind: "line", tokens: currentLine });
    currentLine = [];
  };

  for (const seg of segments) {
    if (seg.type === "display-math") {
      if (currentLine.length > 0) {
        flushLine();
      }
      blocks.push({ kind: "display-math", content: seg.content });
      continue;
    }

    if (seg.type === "inline-math") {
      currentLine.push({ type: "inline-math", content: seg.content });
      continue;
    }

    const parts = seg.content.split(/\r?\n/);
    parts.forEach((part, idx) => {
      if (part.length > 0) {
        currentLine.push({ type: "text", content: part });
      }
      if (idx < parts.length - 1) {
        flushLine();
      }
    });
  }

  if (currentLine.length > 0) {
    flushLine();
  }

  return blocks;
}

// Extract balanced <table>...</table> blocks first so tables are rendered intact without math/newline splitting
function buildBlocks(input: string): BlockNode[] {
  if (!/<table\b/i.test(input)) {
    return buildTextAndMathBlocks(tokenizeMathSegments(input));
  }

  const blocks: BlockNode[] = [];
  const tagRe = /<\/?table\b[^>]*>/gi;
  let cursor = 0;
  let depth = 0;
  let tableStart = -1;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(input)) !== null) {
    const isClose = m[0].startsWith("</");
    if (!isClose) {
      if (depth === 0) {
        const before = input.slice(cursor, m.index).replace(/^\n+|\n+$/g, "");
        if (before) {
          blocks.push(...buildTextAndMathBlocks(tokenizeMathSegments(before)));
        }
        tableStart = m.index;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && tableStart !== -1) {
        const tableEnd = m.index + m[0].length;
        blocks.push({ kind: "table", html: input.slice(tableStart, tableEnd) });
        cursor = tableEnd;
        tableStart = -1;
      }
    }
  }

  const tail = input.slice(cursor).replace(/^\n+/, "");
  if (tail) {
    blocks.push(...buildTextAndMathBlocks(tokenizeMathSegments(tail)));
  }

  return blocks;
}

function renderBidiText(content: string, lineDir: "rtl" | "ltr", keyPrefix: string): React.ReactNode {
  if (!content) return null;

  if (lineDir === "ltr") {
    if (!ARABIC_CHAR_REGEX.test(content)) {
      return <React.Fragment key={keyPrefix}>{content}</React.Fragment>;
    }
    const parts = content.split(ARABIC_RUN_REGEX);
    return parts.map((part, idx) => {
      if (!part) return null;
      if (ARABIC_CHAR_REGEX.test(part)) {
        return (
          <bdi
            key={`${keyPrefix}-ar-${idx}`}
            dir="rtl"
            className="font-arabic inline leading-normal mx-0.5"
            style={{ unicodeBidi: "isolate" }}
          >
            {part}
          </bdi>
        );
      }
      return <React.Fragment key={`${keyPrefix}-id-${idx}`}>{part}</React.Fragment>;
    });
  }

  // Inside an Arabic RTL line, isolate embedded Indonesian/Latin words & Western numbers as LTR
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/.test(content)) {
    return <React.Fragment key={keyPrefix}>{content}</React.Fragment>;
  }
  const parts = content.split(LATIN_RUN_IN_RTL_REGEX);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (/^[A-Za-zÀ-ÖØ-öø-ÿ0-9]/.test(part)) {
      return (
        <bdi
          key={`${keyPrefix}-lt-${idx}`}
          dir="ltr"
          className="font-sans inline mx-0.5"
          style={{ unicodeBidi: "isolate" }}
        >
          {part}
        </bdi>
      );
    }
    return <React.Fragment key={`${keyPrefix}-ar-${idx}`}>{part}</React.Fragment>;
  });
}

function renderInlineKatex(latex: string, key: string): React.ReactNode {
  try {
    const html = katex.renderToString(latex, {
      displayMode: false,
      throwOnError: false,
      strict: false,
    });
    return (
      <span
        key={key}
        dir="ltr"
        className="inline-block align-middle mx-0.5"
        style={{ unicodeBidi: "isolate" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return <React.Fragment key={key}>{latex}</React.Fragment>;
  }
}

function renderLineTokensWithUnderline(
  tokens: LineToken[],
  lineDir: "rtl" | "ltr",
  keyPrefix: string
): React.ReactNode {
  type FlatNode =
    | { kind: "u-open" }
    | { kind: "u-close" }
    | { kind: "text"; content: string }
    | { kind: "inline-math"; content: string };

  const flat: FlatNode[] = [];
  for (const tok of tokens) {
    if (tok.type === "inline-math") {
      flat.push({ kind: "inline-math", content: tok.content });
      continue;
    }
    if (!/<\/?u>/i.test(tok.content)) {
      flat.push({ kind: "text", content: tok.content });
      continue;
    }
    const parts = tok.content.split(/(<u>|<\/u>)/gi);
    for (const part of parts) {
      if (!part) continue;
      if (/^<u>$/i.test(part)) {
        flat.push({ kind: "u-open" });
      } else if (/^<\/u>$/i.test(part)) {
        flat.push({ kind: "u-close" });
      } else {
        flat.push({ kind: "text", content: part });
      }
    }
  }

  const out: React.ReactNode[] = [];
  let uBuffer: React.ReactNode[] | null = null;
  let itemIdx = 0;

  const flushUBuffer = () => {
    if (uBuffer && uBuffer.length > 0) {
      out.push(
        <u
          key={`${keyPrefix}-u-${itemIdx++}`}
          className="underline decoration-2 underline-offset-2"
        >
          {uBuffer}
        </u>
      );
    }
    uBuffer = null;
  };

  for (const node of flat) {
    if (node.kind === "u-open") {
      if (!uBuffer) uBuffer = [];
      continue;
    }
    if (node.kind === "u-close") {
      flushUBuffer();
      continue;
    }

    const rendered =
      node.kind === "text"
        ? renderBidiText(node.content, lineDir, `${keyPrefix}-t-${itemIdx++}`)
        : renderInlineKatex(node.content, `${keyPrefix}-m-${itemIdx++}`);

    if (uBuffer) {
      uBuffer.push(rendered);
    } else {
      out.push(rendered);
    }
  }

  flushUBuffer();
  return out;
}

interface ParsedCellNode {
  tag: "th" | "td";
  colSpan: number;
  rowSpan: number;
  align: "left" | "center" | "right";
  children: Array<
    | { kind: "line"; text: string }
    | { kind: "img"; src: string }
    | { kind: "nested-table"; html: string }
  >;
}

function sanitizeAndParseTableHtml(rawHtml: string): ParsedCellNode[][] | null {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") return null;

  // Escape any '<' that is NOT one of our whitelisted structural/inline tags so math like "$x<5$" stays intact
  const safeHtml = rawHtml.replace(
    /<(?!\/?(?:table|tr|th|td|u|br|img)\b)/gi,
    "&lt;"
  );

  const doc = new DOMParser().parseFromString(safeHtml, "text/html");
  const tableEl = doc.body.querySelector("table");
  if (!tableEl) return null;

  const rows: ParsedCellNode[][] = [];
  const directRows = Array.from(tableEl.children).filter(
    (el) => el.tagName === "TR" || el.tagName === "THEAD" || el.tagName === "TBODY"
  );

  const trElements: Element[] = [];
  for (const el of directRows) {
    if (el.tagName === "TR") {
      trElements.push(el);
    } else {
      Array.from(el.children).forEach((child) => {
        if (child.tagName === "TR") trElements.push(child);
      });
    }
  }

  for (const tr of trElements) {
    const cellEls = Array.from(tr.children).filter(
      (el) => el.tagName === "TH" || el.tagName === "TD"
    );
    const parsedRow: ParsedCellNode[] = [];

    for (const cellEl of cellEls) {
      const tag = cellEl.tagName === "TH" ? "th" : "td";
      const colSpan = Math.max(1, parseInt(cellEl.getAttribute("colspan") || "1", 10) || 1);
      const rowSpan = Math.max(1, parseInt(cellEl.getAttribute("rowspan") || "1", 10) || 1);
      const alignRaw = (cellEl.getAttribute("data-align") || cellEl.getAttribute("align") || "left").toLowerCase();
      const align: "left" | "center" | "right" =
        alignRaw === "center" ? "center" : alignRaw === "right" ? "right" : "left";

      const items: ParsedCellNode["children"] = [];
      let curText = "";

      const flushText = () => {
        if (curText.trim()) {
          items.push({ kind: "line", text: curText.trim() });
        }
        curText = "";
      };

      const walkCellNode = (node: Node) => {
        if (node.nodeType === 3) {
          curText += node.nodeValue || "";
          return;
        }
        if (node.nodeType !== 1) return;
        const el = node as Element;
        const t = el.tagName;
        if (t === "BR") {
          flushText();
        } else if (t === "U") {
          curText += "<u>";
          Array.from(el.childNodes).forEach(walkCellNode);
          curText += "</u>";
        } else if (t === "IMG") {
          const src = (el.getAttribute("src") || "").trim();
          if (/^(data:image\/|https?:\/\/)/i.test(src)) {
            flushText();
            items.push({ kind: "img", src });
          }
        } else if (t === "TABLE") {
          flushText();
          items.push({ kind: "nested-table", html: el.outerHTML });
        } else {
          Array.from(el.childNodes).forEach(walkCellNode);
        }
      };

      Array.from(cellEl.childNodes).forEach(walkCellNode);
      flushText();

      parsedRow.push({ tag, colSpan, rowSpan, align, children: items });
    }

    if (parsedRow.length > 0) {
      rows.push(parsedRow);
    }
  }

  return rows.length > 0 ? rows : null;
}

function renderTableBlock(html: string, key: string): React.ReactNode {
  const rows = sanitizeAndParseTableHtml(html);
  if (!rows) {
    return (
      <span key={key} className="block my-1.5 text-slate-600">
        {html.replace(/<[^>]+>/g, " ").trim()}
      </span>
    );
  }

  const allText = rows
    .flat()
    .flatMap((c) => c.children.filter((ch) => ch.kind === "line").map((ch) => (ch as { kind: "line"; text: string }).text))
    .join(" ");
  const tableIsRtl = isDominantlyArabic(allText);

  return (
    <span
      key={key}
      className="block my-2 overflow-x-auto max-w-full rounded-xl border border-slate-300 bg-white shadow-2xs"
    >
      <table
        dir={tableIsRtl ? "rtl" : "ltr"}
        className="w-full border-collapse text-xs font-sans text-slate-800"
      >
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={`${key}-r-${rIdx}`} className={rIdx % 2 === 1 ? "bg-slate-50/40" : "bg-white"}>
              {row.map((cell, cIdx) => {
                const alignClass =
                  cell.align === "center"
                    ? "text-center"
                    : cell.align === "right"
                    ? "text-right"
                    : "";
                const baseClass =
                  cell.tag === "th"
                    ? `bg-slate-100 font-extrabold text-slate-800 border border-slate-300 px-2.5 py-1.5 align-middle ${alignClass}`
                    : `border border-slate-300 px-2.5 py-1.5 align-top font-medium ${alignClass}`;

                const cellContent =
                  cell.children.length === 0 ? (
                    <span>&nbsp;</span>
                  ) : (
                    cell.children.map((ch, chIdx) => {
                      if (ch.kind === "img") {
                        return (
                          <img
                            key={`${key}-c-${rIdx}-${cIdx}-img-${chIdx}`}
                            src={ch.src}
                            alt="Gambar tabel"
                            referrerPolicy="no-referrer"
                            className="max-h-28 max-w-full rounded object-contain inline-block my-0.5"
                          />
                        );
                      }
                      if (ch.kind === "nested-table") {
                        return renderTableBlock(ch.html, `${key}-c-${rIdx}-${cIdx}-nt-${chIdx}`);
                      }
                      const lineDir = detectLineDirection(ch.text);
                      const tokens: LineToken[] = tokenizeMathSegments(ch.text).map((seg) =>
                        seg.type === "display-math"
                          ? { type: "inline-math", content: seg.content }
                          : { type: seg.type, content: seg.content }
                      );
                      const effectiveAlign =
                        cell.align === "center"
                          ? "text-center"
                          : cell.align === "right" || lineDir === "rtl"
                          ? "text-right"
                          : "text-left";
                      return (
                        <span
                          key={`${key}-c-${rIdx}-${cIdx}-ln-${chIdx}`}
                          dir={lineDir}
                          className={`block ${
                            lineDir === "rtl" ? "font-arabic leading-loose" : "leading-snug"
                          } ${effectiveAlign}`}
                        >
                          {renderLineTokensWithUnderline(
                            tokens,
                            lineDir,
                            `${key}-c-${rIdx}-${cIdx}-ln-${chIdx}`
                          )}
                        </span>
                      );
                    })
                  );

                if (cell.tag === "th") {
                  return (
                    <th
                      key={`${key}-c-${rIdx}-${cIdx}`}
                      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                      className={baseClass}
                    >
                      {cellContent}
                    </th>
                  );
                }
                return (
                  <td
                    key={`${key}-c-${rIdx}-${cIdx}`}
                    colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                    rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                    className={baseClass}
                  >
                    {cellContent}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </span>
  );
}

export default function RichMathText({ text, className = "" }: RichMathTextProps) {
  const blocks = React.useMemo(() => {
    if (!text) return [];
    return buildBlocks(text);
  }, [text]);

  if (!text) return null;

  return (
    <span className={`block w-full min-w-0 ${className}`}>
      {blocks.map((block, bIdx) => {
        if (block.kind === "table") {
          return renderTableBlock(block.html, `tbl-${bIdx}`);
        }

        if (block.kind === "display-math") {
          try {
            const html = katex.renderToString(block.content, {
              displayMode: true,
              throwOnError: false,
              strict: false,
            });
            return (
              <span
                key={`dm-${bIdx}`}
                dir="ltr"
                className="block my-1.5 overflow-x-auto"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          } catch {
            return (
              <span key={`dm-${bIdx}`} dir="ltr" className="block my-1.5">
                {block.content}
              </span>
            );
          }
        }

        const plainLineText = block.tokens
          .filter((t) => t.type === "text")
          .map((t) => t.content)
          .join("");

        if (
          block.tokens.length === 0 ||
          (!plainLineText.trim() && !block.tokens.some((t) => t.type === "inline-math"))
        ) {
          return <span key={`ln-${bIdx}`} className="block h-2" aria-hidden="true" />;
        }

        const lineDir = detectLineDirection(plainLineText);

        return (
          <span
            key={`ln-${bIdx}`}
            dir={lineDir}
            className={`block ${
              lineDir === "rtl" ? "font-arabic leading-loose text-right" : "text-left"
            }`}
          >
            {renderLineTokensWithUnderline(block.tokens, lineDir, `ln-${bIdx}`)}
          </span>
        );
      })}
    </span>
  );
}
