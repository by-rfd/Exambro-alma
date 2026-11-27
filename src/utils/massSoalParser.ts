import { Soal } from "../types";

export type OpsiKey = "A" | "B" | "C" | "D" | "E";

export interface ParsedSoalItem {
  numberHint?: number;
  teks: string;
  gambarUrl?: string;
  opsi: {
    A: string;
    B: string;
    C: string;
    D: string;
    E: string;
  };
  opsiGambar?: Partial<Record<OpsiKey, string>>;
  kunci: OpsiKey;
}

export interface SkippedSoalDiagnostic {
  index: number;
  preview: string;
  reason: string;
}

export interface MassSoalParseResult {
  questions: ParsedSoalItem[];
  skipped: SkippedSoalDiagnostic[];
  totalBlocks: number;
}

const ARABIC_DIGIT_MAP: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

const ARABIC_OPT_TO_LATIN: Record<string, OpsiKey> = {
  أ: "A",
  ا: "A",
  إ: "A",
  آ: "A",
  ب: "B",
  ج: "C",
  د: "D",
  هـ: "E",
  ه: "E",
  و: "E",
};

// Strip Unicode directional controls & zero-width spaces ONLY for structural prefix inspection
function stripBidiControls(str: string): string {
  return str.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u061C]/g, "");
}

// Preserve balanced <u>...</u> if a prefix ("1." or "A.") was inside an underlined Word run
function restoreUnderlineAcrossPrefix(hadLeadingOpenU: boolean, restText: string): string {
  let res = (restText || "").trim();
  // Remove leading orphan closing tag left when only the prefix was underlined (e.g. "<u>A.</u> teks")
  if (hadLeadingOpenU && /^<\/u>/i.test(res)) {
    res = res.replace(/^<\/u>\s*/i, "").trim();
    return res;
  }
  if (hadLeadingOpenU && res) {
    // Re-open <u> on the rest if a closing </u> exists before any new <u>
    const firstOpen = res.indexOf("<u>");
    const firstClose = res.indexOf("</u>");
    if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
      res = `<u>${res}`;
    }
  }
  return res;
}

function normalizeDigits(str: string): string {
  return str.replace(/[٠-٩۰-۹]/g, (ch) => ARABIC_DIGIT_MAP[ch] ?? ch);
}

export function extractImageTokens(text: string): { cleanText: string; images: string[] } {
  const images: string[] = [];
  const cleanText = text
    .replace(/\[\[IMG_TOKEN:(data:image\/[^\]]+|https?:\/\/[^\]]+)\]\]/g, (_m, url) => {
      images.push(url.trim());
      return "";
    })
    .replace(/[ \t]+$/gm, "")
    .trim();
  return { cleanText, images };
}

function mapKeyTokenToLatin(raw: string): OpsiKey | null {
  const cleaned = stripBidiControls(raw).replace(/<\/?u>/gi, "").trim();
  if (!cleaned) return null;
  if (ARABIC_OPT_TO_LATIN[cleaned]) return ARABIC_OPT_TO_LATIN[cleaned];
  const upper = cleaned.toUpperCase();
  if (upper === "A" || upper === "B" || upper === "C" || upper === "D" || upper === "E") {
    return upper;
  }
  return null;
}

// Match an option line prefix strictly (so English sentences like "A dog barked" are NEVER treated as Option A!)
interface OptionLineMatch {
  key: OpsiKey;
  rest: string;
  isStarred: boolean;
}

function matchSingleOptionPrefix(rawLine: string): OptionLineMatch | null {
  const rawTrimmed = stripBidiControls(rawLine).trimStart();
  if (!rawTrimmed) return null;

  const hadLeadingOpenU = /^<u>/i.test(rawTrimmed);
  const line = hadLeadingOpenU ? rawTrimmed.replace(/^<u>\s*/i, "") : rawTrimmed;
  if (!line) return null;

  // Star/asterisk marking answer key: "*A. ...", "**A.** ...", "A*. ..."
  const starLatin = line.match(
    /^\*{1,2}\s*\[?\(?([A-E])\)?\]?\s*[\.\)\-:]?\s*(.*)$/i
  ) || line.match(/^\(?([A-E])\)?\*\s*[\.\)\-:]\s*(.*)$/i);
  if (starLatin) {
    const rest = restoreUnderlineAcrossPrefix(hadLeadingOpenU, starLatin[2].replace(/^\*{1,2}\s*/, ""));
    return { key: starLatin[1].toUpperCase() as OpsiKey, rest, isStarred: true };
  }

  // Bracketed or parenthesized Latin options: "(A) ...", "[A] ...", "A. ...", "a) ...", "A: ..."
  // Also allow "A\t..." (tab separated from Word tables)
  const latinMatch =
    line.match(/^[\(\[]([A-E])[\)\]]\s*[\.\-:]?\s*(.*)$/i) ||
    line.match(/^([A-E])\s*[\.\)\:]\s*(.*)$/i) ||
    line.match(/^([A-E])\t+(.*)$/i) ||
    line.match(/^([A-E])\s+\-\s+(.*)$/);
  if (latinMatch) {
    return {
      key: latinMatch[1].toUpperCase() as OpsiKey,
      rest: restoreUnderlineAcrossPrefix(hadLeadingOpenU, latinMatch[2] || ""),
      isStarred: false,
    };
  }

  // Arabic option letters: أ. ب. ج. د. هـ. (or with ), -, :, brackets, or optional asterisk)
  const arabicStar = line.match(
    /^\*{1,2}\s*[\(\[]?(أ|ا|إ|آ|ب|ج|د|هـ|ه|و)[\)\]]?\s*[\.\)\-:]?\s*(.*)$/
  );
  if (arabicStar) {
    const mapped = ARABIC_OPT_TO_LATIN[arabicStar[1]];
    if (mapped) {
      return {
        key: mapped,
        rest: restoreUnderlineAcrossPrefix(hadLeadingOpenU, arabicStar[2] || ""),
        isStarred: true,
      };
    }
  }

  const arabicMatch = line.match(
    /^[\(\[]?(أ|ا|إ|آ|ب|ج|د|هـ|ه|و)[\)\]]?\s*(?:[\.\)\-:\t]|(?<=[\)\]أابجدهو])\s*[\.\)\-:])\s*(.*)$/
  ) || line.match(/^(أ|ب|ج|د|هـ)\s*[\.\)\-:]\s*(.*)$/);
  if (arabicMatch) {
    const mapped = ARABIC_OPT_TO_LATIN[arabicMatch[1]];
    if (mapped) {
      return {
        key: mapped,
        rest: restoreUnderlineAcrossPrefix(hadLeadingOpenU, arabicMatch[2] || ""),
        isStarred: false,
      };
    }
  }

  return null;
}

// Split a line that packs multiple options horizontally (e.g., "A. 10 cm   B. 20 cm   C. 30 cm" or Word table tabs)
function splitInlineMultiOptions(line: string): string[] {
  // Never split serialized HTML tables from Word
  if (/<table\b/i.test(line)) {
    return [line];
  }

  const check = stripBidiControls(line);
  // Look for 2+ option markers separated by whitespace/tabs where at least B follows A, or D follows C, etc.
  const hasTabOptions = /\t\s*(?:\*?\s*)?(?:[\(\[]?[B-E][\)\]]?[\.\)\-:\t]|(?:أ|ب|ج|د|هـ)[\.\)\-:])/i.test(check);
  const hasSpacedOptions = /\s{2,}(?:\*?\s*)?(?:[\(\[]?[B-E][\)\]]?[\.\)\-:]|(?:ب|ج|د|هـ)[\.\)\-:])/i.test(check);
  const hasDirectSeq = /(?:^|\s)\(?A\)?[\.\)]\s+.+\s+\(?B\)?[\.\)]\s+/i.test(check);

  if (!hasTabOptions && !hasSpacedOptions && !hasDirectSeq) {
    return [line];
  }

  // Tokenize at boundaries preceding an option marker separated by tab or 2+ spaces, or single space before uppercase B./C./D./E. or (b)-(e)
  const parts: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const normalized = line;

  const boundaryRe =
    /(?:\t+|\s{2,}|\s+(?=\*?(?:\([B-Eb-e]\)|\[[B-Eb-e]\]|[B-E][\.\)])\s))(?=\*?(?:[\(\[]?[A-Ea-e][\)\]]?[\.\)\-:\t\s]|(?:أ|ب|ج|د|هـ)[\.\)\-:]))/g;

  while ((match = boundaryRe.exec(normalized)) !== null) {
    const piece = normalized.slice(lastIdx, match.index).trim();
    if (piece) parts.push(piece);
    lastIdx = match.index + match[0].length;
  }
  const tail = normalized.slice(lastIdx).trim();
  if (tail) parts.push(tail);

  // Only accept multi-split if at least 2 resulting pieces look like valid option prefixes
  if (parts.length >= 2 && parts.filter((p) => matchSingleOptionPrefix(p) !== null).length >= 2) {
    return parts;
  }
  return [line];
}

// Match question start ONLY at line beginning
function matchQuestionStart(rawLine: string): { num: number | null; rest: string; isExplicitSeparator: boolean } | null {
  const rawClean = stripBidiControls(rawLine).trimStart();
  if (!rawClean) return null;

  const hadLeadingOpenU = /^<u>/i.test(rawClean);
  const clean = hadLeadingOpenU ? rawClean.replace(/^<u>\s*/i, "") : rawClean;
  if (!clean) return null;

  // Explicit separators: === or --- or [Soal] or [Soal 1]
  if (/^={3,}/.test(clean) || /^-{4,}/.test(clean) || /^\[Soal(?:\s*\d+)?\]/i.test(clean)) {
    const rest = clean.replace(/^={3,}|^-{4,}|^\[Soal(?:\s*\d+)?\]\s*/i, "").trim();
    return { num: null, rest, isExplicitSeparator: true };
  }

  const digitNorm = normalizeDigits(clean);

  // Decimal numbers like 3.14 or years like "1945 merupakan..." MUST NOT start a question unless followed by "." or ")" + space
  // Patterns:
  // "1. Text", "1) Text", "01. Text", "No. 1. Text", "No 1: Text", "Soal 1. Text", "Soal No. 1) Text", "1.- Text"
  const qMatch = digitNorm.match(
    /^(?:(?:Soal\s*(?:No\.?)?\s*|No\.?\s*|س\s*)?)(\d{1,3})\s*(?:[\.\)\:]|\.\-)\s*(.*)$/i
  );
  if (qMatch) {
    const num = parseInt(qMatch[1], 10);
    // Avoid mistaking standalone percentages or years like "2024:" unless small question number (1..300)
    if (num >= 1 && num <= 300) {
      // Recover rest preserving original characters (not digit-normalized body if Arabic numbers inside body!)
      const origPrefixMatch = clean.match(
        /^(?:(?:Soal\s*(?:No\.?)?\s*|No\.?\s*|س\s*)?)[0-9٠-٩۰-۹]{1,3}\s*(?:[\.\)\:]|\.\-)\s*(.*)$/i
      );
      const rawRest = origPrefixMatch ? origPrefixMatch[1].trim() : qMatch[2].trim();
      return {
        num,
        rest: restoreUnderlineAcrossPrefix(hadLeadingOpenU, rawRest),
        isExplicitSeparator: false,
      };
    }
  }

  return null;
}

// Parse trailing/standalone answer-key block at bottom of document (e.g., "Kunci Jawaban:\n1. A 2. B 3. C...")
function extractGlobalAnswerKeySection(lines: string[]): {
  contentLines: string[];
  keyMap: Map<number, OpsiKey>;
} {
  const keyMap = new Map<number, OpsiKey>();
  let keyHeaderIdx = -1;

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 120); i--) {
    const clean = stripBidiControls(lines[i]).trim();
    if (
      /^(?:KUNCI\s*JAWABAN|KUNCI\s*SOAL|DAFTAR\s*KUNCI|ANSWER\s*KEY|KEY\s*ANSWERS|مفتاح\s*الإجابة|الإجابات)\s*[:\-]?\s*$/i.test(
        clean
      )
    ) {
      keyHeaderIdx = i;
      break;
    }
  }

  if (keyHeaderIdx === -1) {
    return { contentLines: lines, keyMap };
  }

  const tailLines = lines.slice(keyHeaderIdx + 1).join("\n");
  const normTail = normalizeDigits(stripBidiControls(tailLines));
  const pairRegex = /(\d{1,3})\s*[\.\)\-:]?\s*([A-E]|أ|ا|إ|آ|ب|ج|د|هـ|ه|و)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(normTail)) !== null) {
    const num = parseInt(m[1], 10);
    const key = mapKeyTokenToLatin(m[2]);
    if (num >= 1 && num <= 500 && key) {
      keyMap.set(num, key);
    }
  }

  if (keyMap.size > 0) {
    return { contentLines: lines.slice(0, keyHeaderIdx), keyMap };
  }
  return { contentLines: lines, keyMap };
}

export function parseMassSoalText(rawInput: string): MassSoalParseResult {
  const normalizedInput = (rawInput || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalizedInput.split("\n");
  const { contentLines, keyMap: globalKeyMap } = extractGlobalAnswerKeySection(rawLines);

  interface RawBlock {
    numberHint?: number;
    subListNextNum: number | null;
    lines: string[];
  }

  const blocks: RawBlock[] = [];
  let currentBlock: RawBlock | null = null;

  const blockHasOptions = (blk: RawBlock | null): boolean => {
    if (!blk) return false;
    let foundOpts = 0;
    for (const l of blk.lines) {
      if (/^\[?(?:Gambar|Image|Pic|Foto)\s*(?:Opsi)?\s*[A-E]\s*[:=]/i.test(stripBidiControls(l).trim())) {
        foundOpts++;
        continue;
      }
      const expanded = splitInlineMultiOptions(l);
      for (const part of expanded) {
        if (matchSingleOptionPrefix(part)) foundOpts++;
      }
    }
    return foundOpts >= 2;
  };

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentBlock && currentBlock.lines.length > 0) {
        currentBlock.lines.push(""); // preserve paragraph break inside block
      }
      continue;
    }

    const qStart = matchQuestionStart(trimmed);

    if (qStart) {
      if (qStart.isExplicitSeparator) {
        if (currentBlock && currentBlock.lines.some((l) => l.trim().length > 0)) {
          blocks.push(currentBlock);
        }
        currentBlock = qStart.rest
          ? { subListNextNum: null, lines: [qStart.rest] }
          : { subListNextNum: null, lines: [] };
        continue;
      }

      const curNum = currentBlock?.numberHint;
      const curHasOpts = blockHasOptions(currentBlock);
      const hasStemContent = Boolean(currentBlock?.lines.some((l) => l.trim().length > 0));

      // Sub-point protection: e.g., inside Question 1 ("Perhatikan langkah berikut:\n1. ...\n2. ...\n3. ...")
      // While the current block has NO options yet, numbered sub-items starting at 1..N (1, 2, 3...) belong inside the stem.
      let isLikelySubPointInStem = false;
      if (currentBlock !== null && !curHasOpts && hasStemContent && qStart.num !== null) {
        if (currentBlock.subListNextNum !== null && qStart.num === currentBlock.subListNextNum) {
          isLikelySubPointInStem = true;
          currentBlock.subListNextNum = qStart.num + 1;
        } else if (curNum !== undefined && qStart.num === 1) {
          isLikelySubPointInStem = true;
          currentBlock.subListNextNum = 2;
        } else if (curNum !== undefined && qStart.num <= curNum && qStart.num !== curNum + 1) {
          isLikelySubPointInStem = true;
          currentBlock.subListNextNum = qStart.num + 1;
        }
      }

      if (!isLikelySubPointInStem) {
        if (currentBlock && hasStemContent) {
          blocks.push(currentBlock);
        }
        currentBlock = {
          numberHint: qStart.num ?? undefined,
          subListNextNum: null,
          lines: qStart.rest ? [qStart.rest] : [],
        };
        continue;
      }
    }

    if (!currentBlock) {
      currentBlock = { subListNextNum: null, lines: [trimmed] };
    } else {
      currentBlock.lines.push(trimmed);
    }
  }

  if (currentBlock && currentBlock.lines.some((l) => l.trim().length > 0)) {
    blocks.push(currentBlock);
  }

  const parsedQuestions: ParsedSoalItem[] = [];
  const skipped: SkippedSoalDiagnostic[] = [];

  blocks.forEach((blk, bIdx) => {
    const expandedLines: string[] = [];
    blk.lines.forEach((l) => {
      if (!l.trim()) {
        expandedLines.push("");
      } else {
        splitInlineMultiOptions(l).forEach((part) => expandedLines.push(part));
      }
    });

    let teks = "";
    const opsiObj: Record<OpsiKey, string> = { A: "", B: "", C: "", D: "", E: "" };
    const opsiGambar: Partial<Record<OpsiKey, string>> = {};
    let kunci: OpsiKey | null = null;
    let gambarUrl = "";
    let currentTarget: "teks" | OpsiKey | "kunci" = "teks";

    for (const rawLine of expandedLines) {
      const textLine = rawLine.trim();
      if (!textLine) {
        if (currentTarget === "teks" && teks) {
          teks += "\n";
        }
        continue;
      }

      const cleanCheck = stripBidiControls(textLine);

      // 1. Option image tag: GambarA: ..., GambarOpsiA: ..., [GambarA: ...]
      const matchOptGambar = cleanCheck.match(
        /^\[?(?:Gambar|Image|Pic|Foto)\s*(?:Opsi)?\s*([A-E])\s*[:=]\s*([^\]]+)\]?$/i
      );
      if (matchOptGambar) {
        const optKey = matchOptGambar[1].toUpperCase() as OpsiKey;
        const url = matchOptGambar[2].trim();
        if (url) opsiGambar[optKey] = url;
        continue;
      }

      // 2. Question image tag: Gambar: ..., [Gambar: ...], Image: ...
      const matchSoalGambar = cleanCheck.match(
        /^\[?(?:Gambar|Image|Pic|Foto|Media)\s*[:=]\s*([^\]]+)\]?$/i
      );
      if (matchSoalGambar) {
        const url = matchSoalGambar[1].trim();
        if (url) gambarUrl = url;
        continue;
      }

      // 3. Answer key line (Indonesian, English, Arabic)
      const matchKunci = cleanCheck.match(
        /^(?:\[)?(?:Kunci\s*Jawaban|Kunci|Jawaban|Jawab|Key|Answer|Ans|الإجابة\s*الصحيحة|الإجابة|الاجابة|الجواب|المفتاح|صحيح)\s*[:\-=]?\s*[\(\[]?([A-E]|أ|ا|إ|آ|ب|ج|د|هـ|ه|و)[\)\]]?\s*\.?\]?$/i
      );
      if (matchKunci) {
        const mapped = mapKeyTokenToLatin(matchKunci[1]);
        if (mapped) {
          kunci = mapped;
          currentTarget = "kunci";
          continue;
        }
      }

      // Inline [Kunci: A] at end of a line
      const inlineKunciMatch = textLine.match(
        /\s*[\[\(](?:Kunci|Jawaban|Key|Ans)\s*[:\-]?\s*([A-E]|أ|ب|ج|د|هـ)[\]\)]\s*$/i
      );
      let workingLine = textLine;
      if (inlineKunciMatch) {
        const mapped = mapKeyTokenToLatin(inlineKunciMatch[1]);
        if (mapped) kunci = mapped;
        workingLine = textLine.slice(0, inlineKunciMatch.index).trim();
        if (!workingLine) continue;
      }

      // 4. Option line match (A-E or Arabic أ ب ج د هـ)
      const optMatch = matchSingleOptionPrefix(workingLine);
      if (optMatch) {
        const { cleanText, images } = extractImageTokens(optMatch.rest);
        opsiObj[optMatch.key] = cleanText;
        if (images.length > 0 && !opsiGambar[optMatch.key]) {
          opsiGambar[optMatch.key] = images[0];
        }
        if (optMatch.isStarred && !kunci) {
          kunci = optMatch.key;
        }
        currentTarget = optMatch.key;
        continue;
      }

      // 5. Append continuation text or inline [[IMG_TOKEN:...]] to current section
      const { cleanText, images } = extractImageTokens(workingLine);
      if (currentTarget === "teks") {
        if (images.length > 0 && !gambarUrl) {
          gambarUrl = images[0];
        }
        if (cleanText) {
          teks = teks ? `${teks}\n${cleanText}` : cleanText;
        }
      } else if (currentTarget !== "kunci") {
        if (images.length > 0 && !opsiGambar[currentTarget]) {
          opsiGambar[currentTarget] = images[0];
        }
        if (cleanText) {
          opsiObj[currentTarget] = opsiObj[currentTarget]
            ? `${opsiObj[currentTarget]}\n${cleanText}`
            : cleanText;
        }
      }
    }

    // Extract any lingering IMG_TOKEN inside teks
    const teksExtracted = extractImageTokens(teks);
    teks = teksExtracted.cleanText.replace(/\n{3,}/g, "\n\n").trim();
    if (!gambarUrl && teksExtracted.images.length > 0) {
      gambarUrl = teksExtracted.images[0];
    }

    // Resolve global answer key if question-level key was not specified
    if (!kunci && blk.numberHint && globalKeyMap.has(blk.numberHint)) {
      kunci = globalKeyMap.get(blk.numberHint)!;
    } else if (!kunci && globalKeyMap.has(bIdx + 1)) {
      kunci = globalKeyMap.get(bIdx + 1)!;
    }

    const hasA = Boolean(opsiObj.A.trim() || opsiGambar.A);
    const hasB = Boolean(opsiObj.B.trim() || opsiGambar.B);
    const hasStem = Boolean(teks || gambarUrl);

    if (hasStem && hasA && hasB) {
      const candidate: ParsedSoalItem = {
        numberHint: blk.numberHint ?? bIdx + 1,
        teks: teks || "(Lihat gambar soal di atas)",
        opsi: {
          A: opsiObj.A.trim(),
          B: opsiObj.B.trim(),
          C: opsiObj.C.trim(),
          D: opsiObj.D.trim(),
          E: opsiObj.E.trim(),
        },
        kunci: kunci || "A",
      };
      if (gambarUrl) candidate.gambarUrl = gambarUrl;
      if (Object.keys(opsiGambar).length > 0) candidate.opsiGambar = opsiGambar;
      parsedQuestions.push(candidate);
    } else {
      const reasons: string[] = [];
      if (!hasStem) reasons.push("teks/gambar pertanyaan kosong");
      if (!hasA) reasons.push("opsi A tidak ditemukan");
      if (!hasB) reasons.push("opsi B tidak ditemukan");
      skipped.push({
        index: blk.numberHint ?? bIdx + 1,
        preview: blk.lines.filter((l) => l.trim()).slice(0, 2).join(" | ").slice(0, 120),
        reason: reasons.join(", "),
      });
    }
  });

  return {
    questions: parsedQuestions,
    skipped,
    totalBlocks: blocks.length,
  };
}

export function buildSoalObjectsFromParsed(
  items: ParsedSoalItem[],
  params: {
    mapelId: string;
    guruId?: string;
    kelasIds?: string[];
    idPrefix?: string;
  }
): Soal[] {
  const prefix = params.idPrefix || "soal_mass_";
  const now = Date.now();
  return items.map((item, idx) => {
    const soal: Soal = {
      id: `${prefix}${now}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
      mapelId: params.mapelId,
      teks: item.teks,
      opsi: { ...item.opsi },
      kunci: item.kunci,
      kelasIds: [...(params.kelasIds || [])],
      createdAt: now,
      urutan: idx,
    };
    if (params.guruId) soal.guruId = params.guruId;
    if (item.gambarUrl) soal.gambarUrl = item.gambarUrl;
    if (item.opsiGambar && Object.keys(item.opsiGambar).length > 0) {
      soal.opsiGambar = { ...item.opsiGambar };
    }
    return soal;
  });
}

// Convert Word / Google Docs HTML clipboard data into soal text preserving <table>...</table> and <u>...</u>
export function convertWordClipboardHtmlToSoalText(html: string): string | null {
  if (!html || typeof window === "undefined" || typeof DOMParser === "undefined") return null;
  if (!/<(?:table|u|ins)\b|(?:text-decoration(?:-line)?|text-underline|mso-text-underline)\s*:/i.test(html)) {
    return null;
  }

  const cleanedHtml = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|xml|head|title|meta|link)\b[\s\S]*?<\/\1>/gi, "");

  const doc = new DOMParser().parseFromString(cleanedHtml, "text/html");
  if (!doc.body) return null;

  const isUnderlinedElement = (el: Element): boolean => {
    if (el.tagName === "U" || el.tagName === "INS") return true;
    const styleAttr = (el.getAttribute("style") || "").toLowerCase();
    if (/text-decoration(?:-line)?\s*:\s*[^;]*underline/.test(styleAttr)) return true;
    if (/(?:mso-text-underline|text-underline)\s*:\s*[^;]*(?:single|double|thick|dotted|dash|wave)/.test(styleAttr)) return true;
    return false;
  };

  const extractInline = (node: Node, inheritedUnderline = false): string => {
    if (node.nodeType === 3) {
      const txt = (node.nodeValue || "").replace(/[\r\n]+/g, " ");
      if (!txt) return "";
      if (inheritedUnderline) {
        if (txt.trim().length > 0) return `<u>${txt}</u>`;
        if (txt.length >= 2) return `<u>${"\u00A0".repeat(Math.min(12, txt.length))}</u>`;
      }
      return txt;
    }
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "XML" || tag === "DEL") return "";
    if (tag === "BR") return "\n";
    if (tag === "SUP") {
      const inner = Array.from(el.childNodes).map((c) => extractInline(c, false)).join("").trim();
      return inner ? `$^{${inner}}$` : "";
    }
    if (tag === "SUB") {
      const inner = Array.from(el.childNodes).map((c) => extractInline(c, false)).join("").trim();
      return inner ? `$_{${inner}}$` : "";
    }
    if (tag === "IMG") {
      const src = (el.getAttribute("src") || "").trim();
      if (/^(data:image\/|https?:\/\/)/i.test(src)) {
        return ` [[IMG_TOKEN:${src}]] `;
      }
      return "";
    }
    const nextUnderline = inheritedUnderline || isUnderlinedElement(el);
    return Array.from(el.childNodes).map((c) => extractInline(c, nextUnderline)).join("");
  };

  const normalizeInlineU = (raw: string): string =>
    raw
      .replace(/[ ]{2,}/g, " ")
      .replace(/<\/u><u>/g, "")
      .replace(/<u>([\s\S]*?)<\/u>/g, (_m, inner: string) => {
        const lead = inner.match(/^([ \t\r\n]*)/)?.[1] || "";
        const trail = inner.match(/([ \t\r\n]*)$/)?.[1] || "";
        const core = inner.slice(lead.length, inner.length - trail.length);
        if (!core) {
          if (/\t/.test(inner) || inner.length >= 2) {
            return `<u>${"\u00A0".repeat(Math.min(12, Math.max(4, inner.replace(/\t/g, "    ").length)))}</u>`;
          }
          return inner;
        }
        return `${lead}<u>${core}</u>${trail}`;
      })
      .trim();

  const serializeClipboardTable = (tblEl: Element): string[] => {
    const trEls = Array.from(tblEl.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr"));
    const rows: Array<Array<{ text: string; tag: "th" | "td"; colSpan: number; rowSpan: number; align: string }>> = [];

    trEls.forEach((tr, rIdx) => {
      const cells = Array.from(tr.children).filter((c) => c.tagName === "TH" || c.tagName === "TD");
      if (cells.length === 0) return;
      const rowData = cells.map((cell) => {
        const pEls = Array.from(cell.children).filter((ch) => ch.tagName === "P" || ch.tagName === "DIV");
        const rawText =
          pEls.length > 0
            ? pEls.map((p) => normalizeInlineU(extractInline(p, false))).filter(Boolean).join("\n")
            : normalizeInlineU(extractInline(cell, false));
        const colSpan = Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10) || 1);
        const rowSpan = Math.max(1, parseInt(cell.getAttribute("rowspan") || "1", 10) || 1);
        const align = (cell.getAttribute("align") || "").toLowerCase();
        const isBoldHeader = rIdx === 0 && (cell.tagName === "TH" || cell.closest("thead") !== null);
        return {
          text: rawText,
          tag: (isBoldHeader ? "th" : "td") as "th" | "td",
          colSpan,
          rowSpan,
          align: align === "center" || align === "right" ? align : "left",
        };
      });
      if (rowData.some((c) => c.text.length > 0)) {
        rows.push(rowData);
      }
    });

    if (rows.length === 0) return [];

    // Unwrap if clipboard table is an exam layout table (option grid or [No | Soal+Opsi])
    const flatCells = rows.flatMap((r) => r.map((c) => c.text.trim()).filter(Boolean));
    const strictOptCount = flatCells.filter((t) => /^\*{0,2}[\(\[]?[A-E][\)\]]?[\.\)]/i.test(t.replace(/<\/?u>/gi, ""))).length;
    const allJoined = flatCells.join("\n").replace(/<\/?u>/gi, "");
    const hasExamOpts = strictOptCount >= 2 || /(?:^|\n|\s)\(?A\)?[\.\)]\s+[\s\S]+?\(?B\)?[\.\)]\s+/i.test(allJoined);
    const hasNumericCol0 = rows.some((r) => /^\d{1,3}[\.\)]?$/.test((r[0]?.text || "").replace(/<\/?u>/gi, "").trim()));

    if (hasExamOpts && (strictOptCount >= Math.ceil(flatCells.length * 0.4) || hasNumericCol0)) {
      const unwrapped: string[] = [];
      for (const row of rows) {
        const filled = row.map((c) => c.text.trim()).filter(Boolean);
        if (filled.length >= 2 && /^\d{1,3}[\.\)]?$/.test(filled[0].replace(/<\/?u>/gi, "").trim())) {
          const num = filled[0].replace(/<\/?u>/gi, "").trim().replace(/[\.\)]$/, "");
          const rest = filled[1];
          unwrapped.push(/^\d{1,3}[\.\)]/.test(rest.replace(/<\/?u>/gi, "")) ? rest : `${num}. ${rest}`);
          for (let i = 2; i < filled.length; i++) unwrapped.push(filled[i]);
        } else {
          unwrapped.push(...filled);
        }
      }
      return unwrapped;
    }

    const trHtml = rows
      .map((r) =>
        `<tr>${r
          .map((c) => {
            const attrs: string[] = [];
            if (c.colSpan > 1) attrs.push(`colspan="${c.colSpan}"`);
            if (c.rowSpan > 1) attrs.push(`rowspan="${c.rowSpan}"`);
            if (c.align !== "left") attrs.push(`data-align="${c.align}"`);
            const body = c.text
              .replace(/\[\[IMG_TOKEN:(data:image\/[^\]]+|https?:\/\/[^\]]+)\]\]/g, (_m, u: string) => `<img src="${u.trim()}" />`)
              .replace(/\n/g, "<br/>");
            return `<${c.tag}${attrs.length ? " " + attrs.join(" ") : ""}>${body}</${c.tag}>`;
          })
          .join("")}</tr>`
      )
      .join("");
    return [`<table>${trHtml}</table>`];
  };

  const outLines: string[] = [];
  const walkBlock = (container: Element) => {
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === 3) {
        const t = normalizeInlineU(child.nodeValue || "");
        if (t) outLines.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName;
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "XML" || tag === "DEL") continue;
      if (tag === "TABLE") {
        outLines.push(...serializeClipboardTable(el));
      } else if (tag === "OL" || tag === "UL") {
        const listType = (el.getAttribute("type") || "").trim();
        const lis = Array.from(el.children).filter((c) => c.tagName === "LI");
        lis.forEach((li, idx) => {
          const txt = normalizeInlineU(extractInline(li, false));
          if (!txt) return;
          if (tag === "OL") {
            const prefix = listType === "A" ? `${String.fromCharCode(65 + idx)}. ` : listType === "a" ? `${String.fromCharCode(97 + idx)}. ` : `${idx + 1}. `;
            outLines.push(`${prefix}${txt}`);
          } else {
            outLines.push(txt);
          }
        });
      } else if (/^(P|DIV|H[1-6]|BLOCKQUOTE|SECTION|ARTICLE)$/i.test(tag)) {
        const hasBlockChildren = Array.from(el.children).some((c) =>
          /^(TABLE|OL|UL|P|DIV|BLOCKQUOTE)$/i.test(c.tagName)
        );
        if (hasBlockChildren) {
          walkBlock(el);
        } else {
          const txt = normalizeInlineU(extractInline(el, false));
          if (txt) outLines.push(txt);
        }
      } else {
        const txt = normalizeInlineU(extractInline(el, false));
        if (txt) outLines.push(txt);
      }
    }
  };

  walkBlock(doc.body);
  const result = outLines.join("\n").trim();
  return result || null;
}

export function applyWordPasteToInput(
  e: { clipboardData: DataTransfer; preventDefault: () => void; currentTarget: HTMLTextAreaElement | HTMLInputElement },
  setValue: (next: string) => void
): boolean {
  const html = e.clipboardData?.getData("text/html") || "";
  if (!html) return false;
  const converted = convertWordClipboardHtmlToSoalText(html);
  if (!converted) return false;

  e.preventDefault();
  const el = e.currentTarget;
  const val = el.value || "";
  const start = el.selectionStart ?? val.length;
  const end = el.selectionEnd ?? val.length;
  const next = val.slice(0, start) + converted + val.slice(end);
  setValue(next);
  return true;
}
