import JSZip from "jszip";
import { compressImageBlobToDataUrl } from "./imageUtils";
import { parseMassSoalText, MassSoalParseResult } from "./massSoalParser";

// Convert Word OMML (<m:oMath> / <m:oMathPara>) into clean LaTeX for KaTeX rendering
const OMML_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function getChildrenByLocalName(el: Element, localName: string): Element[] {
  const res: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === 1 && (node as Element).localName === localName) {
      res.push(node as Element);
    }
  }
  return res;
}

function getFirstChildByLocalName(el: Element, localName: string): Element | null {
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === 1 && (node as Element).localName === localName) {
      return node as Element;
    }
  }
  return null;
}

function getAttr(el: Element, attrName: string): string {
  const direct =
    el.getAttribute(`m:${attrName}`) ||
    el.getAttribute(`w:${attrName}`) ||
    el.getAttributeNS(OMML_NS, attrName) ||
    el.getAttributeNS(W_NS, attrName) ||
    el.getAttribute(attrName);
  if (direct) return direct;
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    if (attr.localName === attrName) return attr.value;
  }
  return "";
}

const UNICODE_MATH_TO_LATEX: Record<string, string> = {
  "×": "\\times ",
  "÷": "\\div ",
  "±": "\\pm ",
  "∓": "\\mp ",
  "≤": "\\leq ",
  "≥": "\\geq ",
  "≠": "\\neq ",
  "≈": "\\approx ",
  "≡": "\\equiv ",
  "∞": "\\infty ",
  "∑": "\\sum ",
  "∏": "\\prod ",
  "∫": "\\int ",
  "∬": "\\iint ",
  "∮": "\\oint ",
  "√": "\\sqrt",
  "∂": "\\partial ",
  "∇": "\\nabla ",
  "∈": "\\in ",
  "∉": "\\notin ",
  "⊂": "\\subset ",
  "⊆": "\\subseteq ",
  "∪": "\\cup ",
  "∩": "\\cap ",
  "∅": "\\emptyset ",
  "∀": "\\forall ",
  "∃": "\\exists ",
  "→": "\\rightarrow ",
  "←": "\\leftarrow ",
  "↔": "\\leftrightarrow ",
  "⇒": "\\Rightarrow ",
  "⇔": "\\Leftrightarrow ",
  "°": "^\\circ ",
  "π": "\\pi ",
  "α": "\\alpha ",
  "β": "\\beta ",
  "γ": "\\gamma ",
  "δ": "\\delta ",
  "θ": "\\theta ",
  "λ": "\\lambda ",
  "μ": "\\mu ",
  "σ": "\\sigma ",
  "φ": "\\phi ",
  "ω": "\\omega ",
  "Δ": "\\Delta ",
  "Σ": "\\Sigma ",
  "Ω": "\\Omega ",
  "·": "\\cdot ",
  "⋅": "\\cdot ",
};

function sanitizeMathText(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += UNICODE_MATH_TO_LATEX[ch] ?? ch;
  }
  return out;
}

function ommlNodeToLatex(node: Element): string {
  const name = node.localName;

  if (name === "oMathPara") {
    return getChildrenByLocalName(node, "oMath").map(ommlNodeToLatex).join(" ");
  }

  if (name === "oMath" || name === "e" || name === "num" || name === "den" || name === "sup" || name === "sub" || name === "deg" || name === "lim") {
    let acc = "";
    for (let i = 0; i < node.childNodes.length; i++) {
      const ch = node.childNodes[i];
      if (ch.nodeType === 1) acc += ommlNodeToLatex(ch as Element);
    }
    return acc;
  }

  if (name === "r") {
    const tList = getChildrenByLocalName(node, "t");
    if (tList.length > 0) {
      return sanitizeMathText(tList.map((t) => t.textContent || "").join(""));
    }
    return sanitizeMathText(node.textContent || "");
  }

  if (name === "f") {
    const numEl = getFirstChildByLocalName(node, "num");
    const denEl = getFirstChildByLocalName(node, "den");
    const num = numEl ? ommlNodeToLatex(numEl).trim() : "";
    const den = denEl ? ommlNodeToLatex(denEl).trim() : "";
    return `\\frac{${num}}{${den}}`;
  }

  if (name === "sSup") {
    const eEl = getFirstChildByLocalName(node, "e");
    const supEl = getFirstChildByLocalName(node, "sup");
    const base = eEl ? ommlNodeToLatex(eEl).trim() : "";
    const sup = supEl ? ommlNodeToLatex(supEl).trim() : "";
    return `${base}^{${sup}}`;
  }

  if (name === "sSub") {
    const eEl = getFirstChildByLocalName(node, "e");
    const subEl = getFirstChildByLocalName(node, "sub");
    const base = eEl ? ommlNodeToLatex(eEl).trim() : "";
    const sub = subEl ? ommlNodeToLatex(subEl).trim() : "";
    return `${base}_{${sub}}`;
  }

  if (name === "sSubSup") {
    const eEl = getFirstChildByLocalName(node, "e");
    const subEl = getFirstChildByLocalName(node, "sub");
    const supEl = getFirstChildByLocalName(node, "sup");
    const base = eEl ? ommlNodeToLatex(eEl).trim() : "";
    const sub = subEl ? ommlNodeToLatex(subEl).trim() : "";
    const sup = supEl ? ommlNodeToLatex(supEl).trim() : "";
    return `${base}_{${sub}}^{${sup}}`;
  }

  if (name === "rad") {
    const degEl = getFirstChildByLocalName(node, "deg");
    const eEl = getFirstChildByLocalName(node, "e");
    const deg = degEl ? ommlNodeToLatex(degEl).trim() : "";
    const inner = eEl ? ommlNodeToLatex(eEl).trim() : "";
    return deg ? `\\sqrt[${deg}]{${inner}}` : `\\sqrt{${inner}}`;
  }

  if (name === "nary") {
    const pr = getFirstChildByLocalName(node, "naryPr");
    const chrEl = pr ? getFirstChildByLocalName(pr, "chr") : null;
    const chr = chrEl ? getAttr(chrEl, "val") : "∫";
    let op = "\\int";
    if (chr === "∑") op = "\\sum";
    else if (chr === "∏") op = "\\prod";
    else if (chr === "∮") op = "\\oint";
    else if (chr === "∬") op = "\\iint";

    const subEl = getFirstChildByLocalName(node, "sub");
    const supEl = getFirstChildByLocalName(node, "sup");
    const eEl = getFirstChildByLocalName(node, "e");
    const sub = subEl ? ommlNodeToLatex(subEl).trim() : "";
    const sup = supEl ? ommlNodeToLatex(supEl).trim() : "";
    const body = eEl ? ommlNodeToLatex(eEl).trim() : "";
    return `${op}${sub ? `_{${sub}}` : ""}${sup ? `^{${sup}}` : ""} ${body}`;
  }

  if (name === "d") {
    const pr = getFirstChildByLocalName(node, "dPr");
    const begChr = pr ? getFirstChildByLocalName(pr, "begChr") : null;
    const endChr = pr ? getFirstChildByLocalName(pr, "endChr") : null;
    const open = (begChr ? getAttr(begChr, "val") : "(") || "(";
    const close = (endChr ? getAttr(endChr, "val") : ")") || ")";
    const innerList = getChildrenByLocalName(node, "e").map((e) => ommlNodeToLatex(e).trim());
    const safeOpen = open === "{" || open === "}" ? `\\${open}` : open === "|" ? "|" : open;
    const safeClose = close === "{" || close === "}" ? `\\${close}` : close === "|" ? "|" : close;
    return `\\left${safeOpen}${innerList.join(", ")}\\right${safeClose}`;
  }

  if (name === "m") {
    const rows = getChildrenByLocalName(node, "mr").map((mr) =>
      getChildrenByLocalName(mr, "e")
        .map((e) => ommlNodeToLatex(e).trim())
        .join(" & ")
    );
    return `\\begin{matrix} ${rows.join(" \\\\ ")} \\end{matrix}`;
  }

  if (name === "limLow" || name === "limUpp") {
    const eEl = getFirstChildByLocalName(node, "e");
    const limEl = getFirstChildByLocalName(node, "lim");
    const base = eEl ? ommlNodeToLatex(eEl).trim() : "";
    const lim = limEl ? ommlNodeToLatex(limEl).trim() : "";
    const latexBase = base === "lim" ? "\\lim" : base;
    return name === "limLow" ? `${latexBase}_{${lim}}` : `${latexBase}^{${lim}}`;
  }

  if (name === "bar" || name === "acc") {
    const eEl = getFirstChildByLocalName(node, "e");
    const inner = eEl ? ommlNodeToLatex(eEl).trim() : "";
    if (name === "bar") return `\\overline{${inner}}`;
    const pr = getFirstChildByLocalName(node, "accPr");
    const chrEl = pr ? getFirstChildByLocalName(pr, "chr") : null;
    const chr = chrEl ? getAttr(chrEl, "val") : "";
    if (chr.includes("⃗") || chr.includes("→")) return `\\vec{${inner}}`;
    if (chr.includes("^") || chr.includes("̂")) return `\\hat{${inner}}`;
    return `\\bar{${inner}}`;
  }

  if (name === "func") {
    const fNameEl = getFirstChildByLocalName(node, "fName");
    const eEl = getFirstChildByLocalName(node, "e");
    const fName = fNameEl ? ommlNodeToLatex(fNameEl).trim() : "";
    const arg = eEl ? ommlNodeToLatex(eEl).trim() : "";
    const known = ["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "lim"];
    const cleanF = known.includes(fName.toLowerCase()) ? `\\${fName.toLowerCase()}` : fName;
    return `${cleanF}\\left(${arg}\\right)`;
  }

  // Fallback: traverse children cleanly skipping Pr elements
  if (name.endsWith("Pr")) return "";
  let fallback = "";
  for (let i = 0; i < node.childNodes.length; i++) {
    const ch = node.childNodes[i];
    if (ch.nodeType === 1) fallback += ommlNodeToLatex(ch as Element);
  }
  return fallback;
}

function getMimeFromExt(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

interface NumberingLevelSpec {
  fmt: string; // decimal, upperLetter, lowerLetter, arabicAlpha, arabicAbjad, etc.
  start: number;
  lvlText: string;
}

async function parseDocxNumbering(zip: JSZip): Promise<{
  formatPrefix: (numId: string, ilvl: string) => string;
}> {
  const numberingFile = zip.file("word/numbering.xml");
  const counters = new Map<string, number>();

  if (!numberingFile) {
    return {
      formatPrefix: (numId, ilvl) => {
        const key = `${numId}::${ilvl}`;
        const next = (counters.get(key) || 0) + 1;
        counters.set(key, next);
        return ilvl === "0" ? `${next}. ` : `${String.fromCharCode(64 + ((next - 1) % 5) + 1)}. `;
      },
    };
  }

  const xmlStr = await numberingFile.async("string");
  const doc = new DOMParser().parseFromString(xmlStr, "application/xml");

  const abstractMap = new Map<string, Map<string, NumberingLevelSpec>>();
  const abstractNodes = doc.getElementsByTagNameNS("*", "abstractNum");
  for (let i = 0; i < abstractNodes.length; i++) {
    const absEl = abstractNodes[i];
    const absId = getAttr(absEl, "abstractNumId");
    const lvlMap = new Map<string, NumberingLevelSpec>();
    const lvls = getChildrenByLocalName(absEl, "lvl");
    for (const lvl of lvls) {
      const ilvl = getAttr(lvl, "ilvl") || "0";
      const numFmtEl = getFirstChildByLocalName(lvl, "numFmt");
      const startEl = getFirstChildByLocalName(lvl, "start");
      const lvlTextEl = getFirstChildByLocalName(lvl, "lvlText");
      lvlMap.set(ilvl, {
        fmt: numFmtEl ? getAttr(numFmtEl, "val") : "decimal",
        start: startEl ? parseInt(getAttr(startEl, "val") || "1", 10) || 1 : 1,
        lvlText: lvlTextEl ? getAttr(lvlTextEl, "val") : "%1.",
      });
    }
    if (absId) abstractMap.set(absId, lvlMap);
  }

  const numToAbstract = new Map<string, string>();
  const numNodes = doc.getElementsByTagNameNS("*", "num");
  for (let i = 0; i < numNodes.length; i++) {
    const numEl = numNodes[i];
    const numId = getAttr(numEl, "numId");
    const absIdEl = getFirstChildByLocalName(numEl, "abstractNumId");
    const absId = absIdEl ? getAttr(absIdEl, "val") : "";
    if (numId && absId) numToAbstract.set(numId, absId);
  }

  return {
    formatPrefix: (numId: string, ilvl: string) => {
      const absId = numToAbstract.get(numId);
      const spec = absId ? abstractMap.get(absId)?.get(ilvl) : undefined;
      // Reset deeper sub-level counters when parent ilvl increments
      if (ilvl === "0") {
        counters.forEach((_v, k) => {
          if (k.startsWith(`${numId}::`) && k !== `${numId}::0`) {
            counters.delete(k);
          }
        });
      }
      const key = `${numId}::${ilvl}`;
      const curCount = counters.get(key);
      const val = curCount !== undefined ? curCount + 1 : spec?.start ?? 1;
      counters.set(key, val);

      const fmt = spec?.fmt || (ilvl === "0" ? "decimal" : "upperLetter");
      if (fmt === "bullet") return "";
      if (fmt === "upperLetter") {
        const ch = String.fromCharCode(65 + ((val - 1) % 26));
        return `${ch}. `;
      }
      if (fmt === "lowerLetter") {
        const ch = String.fromCharCode(97 + ((val - 1) % 26));
        return `${ch}. `;
      }
      if (fmt === "arabicAlpha" || fmt === "arabicAbjad") {
        const arab = ["أ", "ب", "ج", "د", "هـ"];
        return `${arab[(val - 1) % arab.length]}. `;
      }
      return `${val}. `;
    },
  };
}

async function parseUnderlinedStyleIds(zip: JSZip): Promise<{
  underlinedStyles: Set<string>;
  defaultUnderlined: boolean;
}> {
  const underlinedStyles = new Set<string>();
  let defaultUnderlined = false;
  const stylesFile = zip.file("word/styles.xml");
  if (!stylesFile) return { underlinedStyles, defaultUnderlined };

  try {
    const xmlStr = await stylesFile.async("string");
    const doc = new DOMParser().parseFromString(xmlStr, "application/xml");

    // Check docDefaults -> rPrDefault -> rPr -> u
    const docDefaults = doc.getElementsByTagNameNS("*", "docDefaults")[0];
    if (docDefaults) {
      const rPrDefault = getFirstChildByLocalName(docDefaults, "rPrDefault");
      const defRPr = rPrDefault ? getFirstChildByLocalName(rPrDefault, "rPr") : null;
      const uEl = defRPr ? getFirstChildByLocalName(defRPr, "u") : null;
      if (uEl) {
        const uVal = (getAttr(uEl, "val") || "single").toLowerCase();
        defaultUnderlined = uVal !== "none" && uVal !== "false" && uVal !== "0";
      }
    }

    const styleExplicitU = new Map<string, boolean | null>();
    const styleBasedOn = new Map<string, string>();
    const styles = doc.getElementsByTagNameNS("*", "style");
    for (let i = 0; i < styles.length; i++) {
      const st = styles[i];
      const styleId = getAttr(st, "styleId");
      if (!styleId) continue;
      const basedOnEl = getFirstChildByLocalName(st, "basedOn");
      const basedOnId = basedOnEl ? getAttr(basedOnEl, "val") : "";
      if (basedOnId) styleBasedOn.set(styleId, basedOnId);

      const rPr = getFirstChildByLocalName(st, "rPr");
      const uEl = rPr ? getFirstChildByLocalName(rPr, "u") : null;
      if (uEl) {
        const uVal = (getAttr(uEl, "val") || "single").toLowerCase();
        styleExplicitU.set(styleId, uVal !== "none" && uVal !== "false" && uVal !== "0");
      } else {
        styleExplicitU.set(styleId, null);
      }
    }

    const resolveStyle = (styleId: string, visited = new Set<string>()): boolean => {
      if (!styleId || visited.has(styleId)) return defaultUnderlined;
      visited.add(styleId);
      const explicit = styleExplicitU.get(styleId);
      if (explicit === true) return true;
      if (explicit === false) return false;
      const parent = styleBasedOn.get(styleId);
      if (parent) return resolveStyle(parent, visited);
      return defaultUnderlined;
    };

    styleExplicitU.forEach((_val, styleId) => {
      if (resolveStyle(styleId)) {
        underlinedStyles.add(styleId);
      }
    });
  } catch {
    // Ignore styles parse failures gracefully
  }
  return { underlinedStyles, defaultUnderlined };
}

function normalizeUnderlineTags(raw: string): string {
  if (!raw.includes("<u>")) return raw;
  // Merge immediately adjacent </u><u> runs (split across Word runs) into a single underline span
  let res = raw.replace(/<\/u><u>/g, "");
  // Move leading/trailing ASCII whitespace [ \t\r\n] out of <u>...</u>, while keeping \u00A0 (underlined fill-in-the-blank)
  res = res.replace(/<u>([\s\S]*?)<\/u>/g, (_m, inner: string) => {
    const leadMatch = inner.match(/^([ \t\r\n]*)/);
    const trailMatch = inner.match(/([ \t\r\n]*)$/);
    const lead = leadMatch ? leadMatch[1] : "";
    const trail = trailMatch ? trailMatch[1] : "";
    const core = inner.slice(lead.length, inner.length - trail.length);
    if (!core) {
      if (/\t/.test(inner) || inner.length >= 2) {
        return `<u>${"\u00A0".repeat(Math.min(12, Math.max(4, inner.replace(/\t/g, "    ").length)))}</u>`;
      }
      return inner;
    }
    return `${lead}<u>${core}</u>${trail}`;
  });
  return res;
}

function stripUnderlineTags(text: string): string {
  return text.replace(/<\/?u>/gi, "");
}

function isOptionCellStart(cellText: string, allowColonOnly = true): boolean {
  const firstLine = stripUnderlineTags(cellText).trim().split(/\r?\n/)[0]?.trim() || "";
  if (!firstLine) return false;
  if (allowColonOnly) {
    return (
      /^\*{0,2}\s*[\(\[]?[A-E][\)\]]\s*[\.\-:]?/i.test(firstLine) ||
      /^\*{0,2}\s*[A-E]\s*[\.\)\:]/i.test(firstLine) ||
      /^\*{0,2}\s*[\(\[]?(?:أ|ب|ج|د|هـ)[\)\]]?\s*[\.\)\-:]/i.test(firstLine)
    );
  }
  return (
    /^\*{0,2}\s*[\(\[][A-E][\)\]]\s*[\.\-:]?/i.test(firstLine) ||
    /^\*{0,2}\s*[A-E]\s*[\.\)]/i.test(firstLine) ||
    /^\*{0,2}\s*[\(\[]?(?:أ|ب|ج|د|هـ)[\)\]]?\s*[\.\)\-]/i.test(firstLine)
  );
}

function hasInlineOptionPair(text: string): boolean {
  const clean = stripUnderlineTags(text);
  const lines = clean.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const t = line.trim();
    if (
      /^\*{0,2}\s*[\(\[]?[A-E][\)\]]?\s*[\.\)\:]\s*/i.test(t) ||
      /^\*{0,2}\s*[\(\[]?(?:أ|ب|ج|د|هـ)[\)\]]?\s*[\.\)\-:]\s*/.test(t)
    ) {
      count++;
    }
    if (/(?:^|\s)\(?A\)?[\.\)]\s+.+\s+\(?B\)?[\.\)]\s+/i.test(t)) {
      return true;
    }
  }
  return count >= 2;
}

interface ParsedWordCell {
  text: string;
  colSpan: number;
  rowSpan: number;
  align: "left" | "center" | "right";
  isHeaderStyle: boolean;
}

interface ParsedWordRow {
  isTblHeader: boolean;
  cells: ParsedWordCell[];
}

export interface DocxParseOutput {
  rawExtractedText: string;
  parsed: MassSoalParseResult;
  extractedImageCount: number;
}

export async function parseDocxSoalFile(file: File): Promise<DocxParseOutput> {
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) {
    throw new Error("Berkas Word (.docx) tidak valid: word/document.xml tidak ditemukan.");
  }

  // 1. Load relationships -> image data URLs
  const rIdToDataUrl = new Map<string, string>();
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (relsFile) {
    const relsXml = await relsFile.async("string");
    const relsDoc = new DOMParser().parseFromString(relsXml, "application/xml");
    const relEls = relsDoc.getElementsByTagName("Relationship");
    for (let i = 0; i < relEls.length; i++) {
      const rel = relEls[i];
      const id = rel.getAttribute("Id") || "";
      const type = rel.getAttribute("Type") || "";
      const target = rel.getAttribute("Target") || "";
      if (!id || !target || !type.includes("/image")) continue;

      const normalizedPath = target.startsWith("/")
        ? target.slice(1)
        : target.startsWith("word/")
        ? target
        : `word/${target.replace(/^\.\//, "")}`;

      // Skip WMF/EMF vector blobs which browsers cannot render natively in <img>
      if (normalizedPath.toLowerCase().endsWith(".wmf") || normalizedPath.toLowerCase().endsWith(".emf")) {
        continue;
      }

      const mediaFile = zip.file(normalizedPath);
      if (mediaFile) {
        const uint8 = await mediaFile.async("uint8array");
        const mime = getMimeFromExt(normalizedPath);
        const blob = new Blob([uint8], { type: mime });
        const compressed = await compressImageBlobToDataUrl(blob, 720, 0.72);
        rIdToDataUrl.set(id, compressed);
      }
    }
  }

  // 2. Prepare numbering & underline style helpers
  const numbering = await parseDocxNumbering(zip);
  const { underlinedStyles: underlinedStyleIds, defaultUnderlined } = await parseUnderlinedStyleIds(zip);

  // 3. Parse word/document.xml
  const docXml = await docXmlFile.async("string");
  const xmlDoc = new DOMParser().parseFromString(docXml, "application/xml");
  const body = xmlDoc.getElementsByTagNameNS("*", "body")[0];
  if (!body) {
    throw new Error("Struktur isi dokumen Word tidak ditemukan.");
  }

  const getParagraphAlignment = (pEl: Element): "left" | "center" | "right" => {
    const pPr = getFirstChildByLocalName(pEl, "pPr");
    if (!pPr) return "left";
    const jcEl = getFirstChildByLocalName(pPr, "jc");
    const jcVal = jcEl ? getAttr(jcEl, "val").toLowerCase() : "";
    if (jcVal === "center") return "center";
    if (jcVal === "right" || jcVal === "end") return "right";
    const bidiEl = getFirstChildByLocalName(pPr, "bidi");
    if (bidiEl && getAttr(bidiEl, "val") !== "0") return "right";
    return "left";
  };

  const extractParagraphText = (pEl: Element, includeNumPrefix = true): string => {
    let prefix = "";
    const pPr = getFirstChildByLocalName(pEl, "pPr");
    const pStyleEl = pPr ? getFirstChildByLocalName(pPr, "pStyle") : null;
    const pStyleId = pStyleEl ? getAttr(pStyleEl, "val") : "";
    const pStyleUnderlined = pStyleId ? underlinedStyleIds.has(pStyleId) : defaultUnderlined;

    if (includeNumPrefix && pPr) {
      const numPr = getFirstChildByLocalName(pPr, "numPr");
      if (numPr) {
        const numIdEl = getFirstChildByLocalName(numPr, "numId");
        const ilvlEl = getFirstChildByLocalName(numPr, "ilvl");
        const numId = numIdEl ? getAttr(numIdEl, "val") : "";
        const ilvl = ilvlEl ? getAttr(ilvlEl, "val") : "0";
        if (numId && numId !== "0") {
          prefix = numbering.formatPrefix(numId, ilvl);
        }
      }
    }

    let lineAcc = "";

    const walkInline = (el: Element) => {
      const lname = el.localName;

      // Skip tracked deletions and AlternateContent fallback
      if (lname === "Fallback" || lname === "del") return;

      if (lname === "oMathPara" || lname === "oMath") {
        const latex = ommlNodeToLatex(el).trim();
        if (latex) {
          lineAcc += ` $${latex}$ `;
        }
        return;
      }

      if (lname === "txbxContent") {
        const tbLines: string[] = [];
        walkBlockContainer(el, tbLines);
        if (tbLines.length > 0) {
          lineAcc += `\n${tbLines.join("\n")}\n`;
        }
        return;
      }

      if (lname === "r") {
        const rPr = getFirstChildByLocalName(el, "rPr");
        const vertAlignEl = rPr ? getFirstChildByLocalName(rPr, "vertAlign") : null;
        const vertAlign = vertAlignEl ? getAttr(vertAlignEl, "val") : "";

        // Detect underline on <w:u>, <w:rStyle>, or inherited <w:pStyle>
        const uEl = rPr ? getFirstChildByLocalName(rPr, "u") : null;
        const rStyleEl = rPr ? getFirstChildByLocalName(rPr, "rStyle") : null;
        const rStyleId = rStyleEl ? getAttr(rStyleEl, "val") : "";
        let isUnderlined = false;
        if (uEl) {
          const uVal = (getAttr(uEl, "val") || "single").toLowerCase();
          isUnderlined = uVal !== "none" && uVal !== "false" && uVal !== "0";
        } else if (rStyleId) {
          isUnderlined = underlinedStyleIds.has(rStyleId);
        } else if (pStyleUnderlined) {
          isUnderlined = true;
        }

        let runText = "";
        const flushRunSegment = () => {
          if (!runText) return;
          let formatted = runText;
          if (vertAlign === "superscript") {
            formatted = `$^{${runText}}$`;
          } else if (vertAlign === "subscript") {
            formatted = `$_{${runText}}$`;
          }

          if (isUnderlined) {
            if (formatted.trim().length > 0) {
              lineAcc += `<u>${formatted}</u>`;
            } else if (/[\t]/.test(formatted) || formatted.length >= 2) {
              // Underlined fill-in-the-blank spaces/tabs in English questions (e.g. "She _____ goes")
              const blankCount = Math.min(
                12,
                Math.max(4, formatted.replace(/\t/g, "    ").length)
              );
              lineAcc += `<u>${"\u00A0".repeat(blankCount)}</u>`;
            } else {
              // Single space inside an underlined phrase joins adjacent <u> runs cleanly
              lineAcc += `<u>${formatted}</u>`;
            }
          } else {
            lineAcc += formatted;
          }
          runText = "";
        };

        for (let i = 0; i < el.childNodes.length; i++) {
          const ch = el.childNodes[i];
          if (ch.nodeType !== 1) continue;
          const chEl = ch as Element;
          if (chEl.localName === "t") {
            runText += chEl.textContent || "";
          } else if (chEl.localName === "noBreakHyphen") {
            runText += "-";
          } else if (chEl.localName === "tab") {
            runText += "\t";
          } else if (chEl.localName === "br" || chEl.localName === "cr") {
            flushRunSegment();
            lineAcc += "\n";
          } else if (chEl.localName === "drawing" || chEl.localName === "pict" || chEl.localName === "object") {
            flushRunSegment();
            walkInline(chEl);
          }
        }
        flushRunSegment();
        return;
      }

      if (lname === "blip") {
        const embedId =
          el.getAttribute("r:embed") ||
          el.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ||
          "";
        const imgUrl = embedId ? rIdToDataUrl.get(embedId) : undefined;
        if (imgUrl) {
          lineAcc += ` [[IMG_TOKEN:${imgUrl}]] `;
        }
        return;
      }

      if (lname === "imagedata") {
        const rId =
          el.getAttribute("r:id") ||
          el.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ||
          "";
        const imgUrl = rId ? rIdToDataUrl.get(rId) : undefined;
        if (imgUrl) {
          lineAcc += ` [[IMG_TOKEN:${imgUrl}]] `;
        }
        return;
      }

      if (lname === "hyperlink" || lname === "sdt" || lname === "sdtContent" || lname === "smartTag" || lname === "ins") {
        for (let i = 0; i < el.childNodes.length; i++) {
          if (el.childNodes[i].nodeType === 1) walkInline(el.childNodes[i] as Element);
        }
        return;
      }

      // Skip hidden AlternateContent fallback to prevent duplicate image/math extraction
      if (lname === "Fallback") return;

      for (let i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 1) walkInline(el.childNodes[i] as Element);
      }
    };

    for (let i = 0; i < pEl.childNodes.length; i++) {
      const ch = pEl.childNodes[i];
      if (ch.nodeType === 1) {
        const chEl = ch as Element;
        if (chEl.localName === "pPr") continue;
        walkInline(chEl);
      }
    }

    const cleaned = normalizeUnderlineTags(lineAcc.replace(/[ ]{2,}/g, " ").trim());
    if (!cleaned) return "";
    // Avoid doubling prefix if teacher already typed "1." or "A." manually alongside Word numbering
    const cleanedNoU = stripUnderlineTags(cleaned);
    if (prefix && /^(?:\d+[\.\)]|[A-E][\.\)]|[أبجدهـ][\.\)])/i.test(cleanedNoU)) {
      return cleaned;
    }
    return `${prefix}${cleaned}`.trim();
  };

  const serializeDataTable = (rows: ParsedWordRow[]): string => {
    const hasHeader = rows.length > 1 && (rows[0].isTblHeader || rows[0].cells.some((c) => c.isHeaderStyle));
    const trHtml = rows
      .map((row, rIdx) => {
        const tag = hasHeader && rIdx === 0 ? "th" : "td";
        const cellHtml = row.cells
          .map((cell) => {
            const attrs: string[] = [];
            if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`);
            if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
            if (cell.align !== "left") attrs.push(`data-align="${cell.align}"`);

            // Preserve math & underline inside table cell; convert inline IMG_TOKEN to <img> and newlines to <br/>
            const safeBody = cell.text
              .replace(
                /\[\[IMG_TOKEN:(data:image\/[^\]]+|https?:\/\/[^\]]+)\]\]/g,
                (_m, url: string) => `<img src="${url.trim()}" />`
              )
              .replace(/\r?\n/g, "<br/>");
            const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
            return `<${tag}${attrStr}>${safeBody}</${tag}>`;
          })
          .join("");
        return `<tr>${cellHtml}</tr>`;
      })
      .join("");
    return `<table>${trHtml}</table>`;
  };

  const processTableElement = (tblEl: Element): string[] => {
    const trEls = getChildrenByLocalName(tblEl, "tr");
    if (trEls.length === 0) return [];

    // 1. Parse full table grid with colspan (gridSpan) & rowspan (vMerge)
    const parsedRows: ParsedWordRow[] = [];
    const activeVerticalMerges = new Map<number, { rowIdx: number; cellIdxInRow: number }>();

    for (let rIdx = 0; rIdx < trEls.length; rIdx++) {
      const tr = trEls[rIdx];
      const trPr = getFirstChildByLocalName(tr, "trPr");
      const isTblHeader = Boolean(trPr && getFirstChildByLocalName(trPr, "tblHeader"));
      const tcEls = getChildrenByLocalName(tr, "tc");

      const rowCells: ParsedWordCell[] = [];
      let colCursor = 0;

      for (const tc of tcEls) {
        const tcPr = getFirstChildByLocalName(tc, "tcPr");
        const gridSpanEl = tcPr ? getFirstChildByLocalName(tcPr, "gridSpan") : null;
        const colSpan = Math.max(1, parseInt((gridSpanEl && getAttr(gridSpanEl, "val")) || "1", 10) || 1);

        const vMergeEl = tcPr ? getFirstChildByLocalName(tcPr, "vMerge") : null;
        const vMergeVal = vMergeEl ? (getAttr(vMergeEl, "val") || "continue").toLowerCase() : "";

        if (vMergeEl && vMergeVal === "continue" && activeVerticalMerges.has(colCursor)) {
          const master = activeVerticalMerges.get(colCursor)!;
          if (parsedRows[master.rowIdx]?.cells[master.cellIdxInRow]) {
            parsedRows[master.rowIdx].cells[master.cellIdxInRow].rowSpan += 1;
          }
          colCursor += colSpan;
          continue;
        }

        // Check header styling (shading or bold runs)
        const shdEl = tcPr ? getFirstChildByLocalName(tcPr, "shd") : null;
        const fillVal = shdEl ? (getAttr(shdEl, "fill") || "").toUpperCase() : "";
        const hasShading = Boolean(fillVal && fillVal !== "AUTO" && fillVal !== "FFFFFF");

        const pLines: string[] = [];
        let align: "left" | "center" | "right" = "left";
        let boldRuns = 0;
        let totalRuns = 0;

        for (let c = 0; c < tc.childNodes.length; c++) {
          const ch = tc.childNodes[c];
          if (ch.nodeType !== 1) continue;
          const chEl = ch as Element;
          if (chEl.localName === "p") {
            if (pLines.length === 0) {
              align = getParagraphAlignment(chEl);
            }
            const rNodes = getChildrenByLocalName(chEl, "r");
            for (const rn of rNodes) {
              totalRuns++;
              const rPr = getFirstChildByLocalName(rn, "rPr");
              const bEl = rPr ? getFirstChildByLocalName(rPr, "b") : null;
              if (bEl && getAttr(bEl, "val") !== "0") boldRuns++;
            }
            const t = extractParagraphText(chEl, true);
            if (t) pLines.push(t);
          } else if (chEl.localName === "tbl") {
            const nestedLines = processTableElement(chEl);
            pLines.push(...nestedLines);
          }
        }

        const cellIdxInRow = rowCells.length;
        rowCells.push({
          text: pLines.join("\n"),
          colSpan,
          rowSpan: 1,
          align,
          isHeaderStyle: hasShading || (totalRuns > 0 && boldRuns === totalRuns),
        });

        if (vMergeEl && vMergeVal === "restart") {
          activeVerticalMerges.set(colCursor, { rowIdx: parsedRows.length, cellIdxInRow });
        } else {
          for (let c = colCursor; c < colCursor + colSpan; c++) {
            activeVerticalMerges.delete(c);
          }
        }

        colCursor += colSpan;
      }

      parsedRows.push({ isTblHeader, cells: rowCells });
    }

    // Remove completely empty rows
    const nonEmptyRows = parsedRows.filter((row) =>
      row.cells.some((cell) => cell.text.trim().length > 0)
    );
    if (nonEmptyRows.length === 0) return [];

    // 2. Classify Table: Exam Columnar Table vs Option Grid Layout vs Question Layout vs Data Table
    // Case A: Columnar Exam Table with explicit header row (No | Soal | Opsi A | Opsi B | ... | Kunci)
    if (nonEmptyRows.length >= 2 && nonEmptyRows[0].cells.length >= 3) {
      const headerTexts = nonEmptyRows[0].cells.map((c) => stripUnderlineTags(c.text).trim().toLowerCase());
      const soalCol = headerTexts.findIndex((h) => /\b(soal|pertanyaan|butir)\b/.test(h));
      const noCol = headerTexts.findIndex((h) => /^(no\.?|nomor)$/.test(h));
      const optACol = headerTexts.findIndex((h) => /^(?:opsi\s*|pilihan\s*)?a$/.test(h));
      const optBCol = headerTexts.findIndex((h) => /^(?:opsi\s*|pilihan\s*)?b$/.test(h));
      const optCCol = headerTexts.findIndex((h) => /^(?:opsi\s*|pilihan\s*)?c$/.test(h));
      const optDCol = headerTexts.findIndex((h) => /^(?:opsi\s*|pilihan\s*)?d$/.test(h));
      const optECol = headerTexts.findIndex((h) => /^(?:opsi\s*|pilihan\s*)?e$/.test(h));
      const kunciCol = headerTexts.findIndex((h) => /^(kunci|jawaban|key|answer)$/.test(h));

      if (soalCol !== -1 && optACol !== -1 && optBCol !== -1) {
        const resultLines: string[] = [];
        for (let r = 1; r < nonEmptyRows.length; r++) {
          const cells = nonEmptyRows[r].cells;
          const numRaw = noCol !== -1 ? stripUnderlineTags(cells[noCol]?.text || "").trim().replace(/[\.\)]$/, "") : String(r);
          const qText = (cells[soalCol]?.text || "").trim();
          if (!qText) continue;
          const qLine = /^\d{1,3}[\.\)]/.test(stripUnderlineTags(qText)) ? qText : `${numRaw || r}. ${qText}`;
          resultLines.push(qLine);
          const pushOpt = (label: string, colIdx: number) => {
            if (colIdx === -1) return;
            const val = (cells[colIdx]?.text || "").trim();
            if (!val) return;
            resultLines.push(isOptionCellStart(val) ? val : `${label}. ${val}`);
          };
          pushOpt("A", optACol);
          pushOpt("B", optBCol);
          pushOpt("C", optCCol);
          pushOpt("D", optDCol);
          pushOpt("E", optECol);
          if (kunciCol !== -1 && cells[kunciCol]?.text.trim()) {
            resultLines.push(`Kunci: ${stripUnderlineTags(cells[kunciCol].text).trim()}`);
          }
        }
        return resultLines;
      }
    }

    // Gather structural clues across cells
    const nonEmptyCells = nonEmptyRows.flatMap((r) => r.cells.filter((c) => c.text.trim().length > 0));
    const optionCellCount = nonEmptyCells.filter((c) => isOptionCellStart(c.text, true)).length;
    const strictOptionCellCount = nonEmptyCells.filter((c) => isOptionCellStart(c.text, false)).length;
    const allCellsText = nonEmptyCells.map((c) => c.text).join("\n");
    const hasOptionsInTable = hasInlineOptionPair(allCellsText) || strictOptionCellCount >= 2 || optionCellCount >= 3;
    const sequentialNumericCol0 = nonEmptyRows.filter((r) =>
      /^\d{1,3}[\.\)]?$/.test(stripUnderlineTags(r.cells[0]?.text || "").trim())
    ).length;

    // Case B: Option Grid Layout Table (e.g., | A. ... | C. ... | / | B. ... | D. ... | or | A. | Text |)
    // Guard: avoid mistaking 2-speaker English dialogue tables ("| A: | ... |" / "| B: | ... |") for option grids
    const row0LooksLikeDataHeader =
      nonEmptyRows.length >= 2 &&
      !isOptionCellStart(nonEmptyRows[0].cells[0]?.text || "", true) &&
      nonEmptyRows[0].cells.some((c) => c.isHeaderStyle || nonEmptyRows[0].isTblHeader);

    const isOptionGridLayout =
      !row0LooksLikeDataHeader &&
      (strictOptionCellCount >= 2 || optionCellCount >= 3) &&
      (optionCellCount >= Math.ceil(nonEmptyCells.length * 0.4) ||
        nonEmptyRows.every(
          (r) =>
            r.cells.some((c) => isOptionCellStart(c.text, true)) ||
            r.cells.every((c) => !c.text.trim())
        ));

    if (isOptionGridLayout) {
      const lines: string[] = [];
      for (const row of nonEmptyRows) {
        const filled = row.cells.map((c) => c.text.trim()).filter(Boolean);
        if (filled.length === 0) continue;
        // Handle | A. | Text | two-cell pair
        if (
          filled.length === 2 &&
          /^\*{0,2}[\(\[]?(?:[A-E]|أ|ب|ج|د|هـ)[\)\]]?[\.\)\:]?$/i.test(stripUnderlineTags(filled[0]))
        ) {
          const keyToken = stripUnderlineTags(filled[0]);
          const normalizedKey = /[\.\)\:]$/.test(keyToken) ? keyToken : `${keyToken}.`;
          lines.push(`${normalizedKey} ${filled[1]}`);
        } else {
          for (const cellText of filled) {
            lines.push(cellText);
          }
        }
      }
      return lines;
    }

    // Case C: Master Question-Wrapper Layout Table (e.g., | 1. | Question + Options A-E |)
    const isQuestionWrapperTable =
      hasOptionsInTable &&
      (sequentialNumericCol0 >= 1 ||
        nonEmptyRows.some((r) => r.cells.length <= 2 && hasInlineOptionPair(r.cells.map((c) => c.text).join("\n"))));

    if (isQuestionWrapperTable) {
      const lines: string[] = [];
      for (const row of nonEmptyRows) {
        const filled = row.cells.map((c) => c.text.trim()).filter(Boolean);
        if (filled.length === 0) continue;
        const firstClean = stripUnderlineTags(filled[0]).trim();
        if (filled.length >= 2 && /^\d{1,3}[\.\)]?$/.test(firstClean)) {
          const qNum = firstClean.replace(/[\.\)]$/, "");
          const restFirst = filled[1];
          const startsWithNum = /^\d{1,3}[\.\)]/.test(stripUnderlineTags(restFirst));
          lines.push(startsWithNum ? restFirst : `${qNum}. ${restFirst}`);
          for (let ci = 2; ci < filled.length; ci++) {
            lines.push(filled[ci]);
          }
        } else {
          for (const cellText of filled) {
            lines.push(cellText);
          }
        }
      }
      return lines;
    }

    // Case D: Real Content / Data Table inside a question or option!
    return [serializeDataTable(nonEmptyRows)];
  };

  function walkBlockContainer(containerEl: Element, out: string[]) {
    for (let i = 0; i < containerEl.childNodes.length; i++) {
      const node = containerEl.childNodes[i];
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const lname = el.localName;

      if (lname === "p") {
        const txt = extractParagraphText(el, true);
        if (txt) {
          out.push(txt);
        }
      } else if (lname === "tbl") {
        const tblLines = processTableElement(el);
        out.push(...tblLines);
      } else if (
        lname === "sdt" ||
        lname === "sdtContent" ||
        lname === "ins" ||
        lname === "smartTag" ||
        lname === "customXml"
      ) {
        walkBlockContainer(el, out);
      }
    }
  }

  const outLines: string[] = [];
  walkBlockContainer(body, outLines);

  const rawExtractedText = outLines.join("\n");
  const parsed = parseMassSoalText(rawExtractedText);

  return {
    rawExtractedText,
    parsed,
    extractedImageCount: rIdToDataUrl.size,
  };
}
