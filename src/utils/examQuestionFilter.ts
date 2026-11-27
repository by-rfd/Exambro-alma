import { JadwalUjian, KelasAkademik, Soal } from "../types";

export const SYSTEM_GURU_ID = "__SYSTEM__";

export function canonicalClassAlias(raw: string): string {
  if (!raw) return "";
  let s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  s = s.replace(/\s*-\s*/g, "-");
  s = s.replace(/^kelas\s+/, "");
  // Convert numeric Indonesian grade prefixes 10/11/12 to x/xi/xii at token start
  s = s.replace(/^12(?=$|[\s\-])/, "xii");
  s = s.replace(/^11(?=$|[\s\-])/, "xi");
  s = s.replace(/^10(?=$|[\s\-])/, "x");
  return s.trim();
}

export function getClassGradeLevel(nama: string): "X" | "XI" | "XII" | "Lainnya" {
  const upper = (nama || "").toUpperCase();
  if (/\bXII\b/.test(upper) || /\b12\b/.test(upper)) return "XII";
  if (/\bXI\b/.test(upper) || /\b11\b/.test(upper)) return "XI";
  if (/\bX\b/.test(upper) || /\b10\b/.test(upper)) return "X";
  return "Lainnya";
}

export function resolveKelasTokens(
  rawList: string[],
  kelasAkademik: KelasAkademik[]
): Set<string> {
  const tokens = new Set<string>();
  for (const raw of rawList) {
    if (!raw) continue;
    const lower = raw.trim().toLowerCase();
    const alias = canonicalClassAlias(raw);
    if (lower) tokens.add(lower);
    if (alias) tokens.add(alias);

    const matched = kelasAkademik.find(
      (ka) =>
        ka.id === raw ||
        ka.id.trim().toLowerCase() === lower ||
        ka.nama.trim().toLowerCase() === lower ||
        (alias && canonicalClassAlias(ka.nama) === alias)
    );
    if (matched) {
      tokens.add(matched.id.trim().toLowerCase());
      tokens.add(matched.nama.trim().toLowerCase());
      const kaAlias = canonicalClassAlias(matched.nama);
      if (kaAlias) tokens.add(kaAlias);
    }
  }
  return tokens;
}

export function normalizeSoalKelasIds(
  rawIds: string[] | undefined,
  kelasAkademik: KelasAkademik[]
): string[] {
  if (!rawIds || rawIds.length === 0) return [];
  const resolved = rawIds.map((raw) => {
    const lower = raw.trim().toLowerCase();
    const alias = canonicalClassAlias(raw);
    const found = kelasAkademik.find(
      (ka) =>
        ka.id === raw ||
        ka.id.trim().toLowerCase() === lower ||
        ka.nama.trim().toLowerCase() === lower ||
        (alias && canonicalClassAlias(ka.nama) === alias)
    );
    return found ? found.id : raw;
  });
  return Array.from(new Set(resolved));
}

export function isQuestionClassMatchForSchedule(
  soal: Soal,
  jad: JadwalUjian,
  kelasAkademik: KelasAkademik[]
): boolean {
  if (!jad.kelasIds || jad.kelasIds.length === 0) return true;
  if (!soal.kelasIds || soal.kelasIds.length === 0) return true;

  const qTokens = resolveKelasTokens(soal.kelasIds, kelasAkademik);
  const schedTokens = resolveKelasTokens(jad.kelasIds, kelasAkademik);

  for (const tok of qTokens) {
    if (schedTokens.has(tok)) return true;
  }
  return false;
}

export function filterQuestionsForJadwal(
  jad: JadwalUjian,
  allSoal: Soal[],
  kelasAkademik: KelasAkademik[],
  options?: {
    studentClassName?: string;
    studentClassId?: string;
    ignoreManualSoalIds?: boolean;
  }
): Soal[] {
  const mapelSoal = allSoal.filter((s) => s.mapelId === jad.mapelId);

  // Explicit manual selection override
  if (!options?.ignoreManualSoalIds && jad.soalIds && jad.soalIds.length > 0) {
    const manualSet = new Set(jad.soalIds);
    return mapelSoal.filter((s) => manualSet.has(s.id));
  }

  return mapelSoal.filter((s) => {
    // 1. Filter by selected guru(s) if configured on schedule
    if (jad.guruIds && jad.guruIds.length > 0) {
      const authorKey = s.guruId || SYSTEM_GURU_ID;
      if (!jad.guruIds.includes(authorKey)) return false;
    }

    // 2. General question (no class restrictions) applies to all
    if (!s.kelasIds || s.kelasIds.length === 0) return true;

    const qTokens = resolveKelasTokens(s.kelasIds, kelasAkademik);

    // 3a. Student-level matching
    if (options?.studentClassName || options?.studentClassId) {
      const studentInputs = [options.studentClassName || "", options.studentClassId || ""].filter(Boolean);
      const studentTokens = resolveKelasTokens(studentInputs, kelasAkademik);
      if (studentTokens.size > 0) {
        for (const tok of qTokens) {
          if (studentTokens.has(tok)) return true;
        }
        return false;
      }
    }

    // 3b. Schedule-level matching
    if (!jad.kelasIds || jad.kelasIds.length === 0) return true;
    const schedTokens = resolveKelasTokens(jad.kelasIds, kelasAkademik);
    for (const tok of qTokens) {
      if (schedTokens.has(tok)) return true;
    }
    return false;
  });
}

export function formatSoalKelasNames(
  rawIds: string[] | undefined,
  kelasAkademik: KelasAkademik[]
): string[] {
  if (!rawIds || rawIds.length === 0) return [];
  const names = rawIds.map((raw) => {
    const lower = raw.trim().toLowerCase();
    const alias = canonicalClassAlias(raw);
    const found = kelasAkademik.find(
      (ka) =>
        ka.id === raw ||
        ka.id.trim().toLowerCase() === lower ||
        ka.nama.trim().toLowerCase() === lower ||
        (alias && canonicalClassAlias(ka.nama) === alias)
    );
    return found ? found.nama : raw;
  });
  return Array.from(new Set(names));
}

function extractSoalUploadKey(soal: Pick<Soal, "id" | "createdAt" | "urutan">): [number, number] {
  if (typeof soal.createdAt === "number" && Number.isFinite(soal.createdAt)) {
    return [soal.createdAt, typeof soal.urutan === "number" && Number.isFinite(soal.urutan) ? soal.urutan : 0];
  }
  const id = String(soal.id || "");
  let m = id.match(/^soal_(?:guru|mass|admin|xl|import)_?(\d+)_(\d+)(?:_|$)/i);
  if (m) return [Number(m[1]), Number(m[2])];
  m = id.match(/^soal_(?:guru|mass|admin|manual|import)?_?(\d+)(?:_|$)/i);
  if (m) return [Number(m[1]), 0];
  m = id.match(/^q(\d+)_(\d+)$/i);
  if (m) return [Number(m[1]), Number(m[2])];
  return [Number.MAX_SAFE_INTEGER, 0];
}

export function compareSoalUploadOrder(a: Soal, b: Soal): number {
  const [tsA, idxA] = extractSoalUploadKey(a);
  const [tsB, idxB] = extractSoalUploadKey(b);
  if (tsA !== tsB) return tsA - tsB;
  if (idxA !== idxB) return idxA - idxB;
  return String(a.id || "").localeCompare(String(b.id || ""), undefined, { numeric: true });
}

export function sortSoalByUploadOrder<T extends Soal>(list: T[]): T[] {
  if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? [...list] : [];
  return [...list].sort(compareSoalUploadOrder);
}
