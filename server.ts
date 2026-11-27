import "dotenv/config";
import crypto from "crypto";
import zlib from "zlib";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TABLE_MAP: Record<string, string> = {
  kelas: "kelas",
  kelasAkademik: "kelas_akademik",
  mapel: "mapel",
  siswa: "siswa",
  guru: "guru",
  pengawas: "pengawas",
  jadwalNgawas: "jadwal_ngawas",
  soal: "soal",
  jadwal: "jadwal_ujian",
  jadwalUjian: "jadwal_ujian",
  tokens: "token_ujian",
  tokenUjian: "token_ujian",
  sessions: "sessions",
  hasil: "hasil_ujian",
  hasilUjian: "hasil_ujian",
  konfig: "konfigurasi",
  konfigurasi: "konfigurasi",
};

const ALL_COLLECTION_KEYS = [
  "kelas",
  "kelasAkademik",
  "mapel",
  "siswa",
  "guru",
  "pengawas",
  "jadwalNgawas",
  "soal",
  "jadwal",
  "tokens",
  "sessions",
  "hasil",
  "konfig",
] as const;

const CACHE_TTL_MS: Record<string, number> = {
  kelas: 30000,
  kelas_akademik: 30000,
  mapel: 30000,
  siswa: 30000,
  guru: 30000,
  pengawas: 30000,
  soal: 30000,
  konfigurasi: 30000,
  jadwal_ngawas: 8000,
  jadwal_ujian: 5000,
  token_ujian: 3000,
  sessions: 3000,
  hasil_ujian: 5000,
};

const MAX_FULL_REVALIDATE_MS = 60 * 60 * 1000;

interface CacheEntry {
  rows: Array<{ id: string; payload: any }>;
  hash: string;
  metaSig: string | null;
  fetchedAt: number;
  fullFetchedAt: number;
  expiresAt: number;
}

const tableCache = new Map<string, CacheEntry>();
const tableHashes = new Map<string, string>();
const inFlightTableFetches = new Map<string, Promise<CacheEntry>>();

function toEpochMs(val: any): number {
  if (!val) return 0;
  const ms = Date.parse(String(val));
  return Number.isFinite(ms) ? ms : 0;
}

function formatMetaSig(count: number, latestTsMs: number): string {
  return `${count}:${latestTsMs}`;
}

function computeRowsHash(rows: Array<{ id: string; payload: any }>): string {
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash("sha1").update(JSON.stringify(sorted)).digest("hex").slice(0, 12);
}

function patchTableCache(
  table: string,
  upserts: Array<{ id: string; payload: any }>,
  deleteIds: string[],
  writeTsMs: number
) {
  const existing = tableCache.get(table);
  if (!existing) {
    tableHashes.delete(table);
    return;
  }

  const rowMap = new Map<string, { id: string; payload: any }>();
  for (const r of existing.rows) {
    rowMap.set(String(r.id), r);
  }
  for (const id of deleteIds) {
    rowMap.delete(String(id));
  }
  for (const u of upserts) {
    rowMap.set(String(u.id), { id: String(u.id), payload: u.payload });
  }

  const nextRows = Array.from(rowMap.values());
  const nextHash = computeRowsHash(nextRows);
  const now = Date.now();
  const ttl = CACHE_TTL_MS[table] ?? 5000;

  let nextMetaSig: string | null = null;
  if (deleteIds.length === 0 && existing.metaSig) {
    const prevTs = Number(existing.metaSig.split(":")[1] || 0);
    nextMetaSig = formatMetaSig(nextRows.length, Math.max(prevTs, writeTsMs));
  }

  const patched: CacheEntry = {
    rows: nextRows,
    hash: nextHash,
    metaSig: nextMetaSig,
    fetchedAt: now,
    fullFetchedAt: existing.fullFetchedAt,
    expiresAt: now + ttl,
  };
  tableCache.set(table, patched);
  lastKnownGoodCache.set(table, patched);
  tableHashes.set(table, nextHash);

  if (table === "sessions") {
    for (const id of deleteIds) {
      studentSessionCache.set(String(id), { item: null, updatedAtMs: 0, fetchedAt: now });
    }
    for (const u of upserts) {
      const id = String(u.id);
      const item = u.payload && typeof u.payload === "object" ? { id, ...u.payload } : { id };
      studentSessionCache.set(id, { item, updatedAtMs: writeTsMs, fetchedAt: now });
    }
  }
}

interface StudentSessionCacheEntry {
  item: any | null;
  updatedAtMs: number;
  fetchedAt: number;
}

const studentSessionCache = new Map<string, StudentSessionCacheEntry>();

async function fetchStudentSessionCached(
  client: SupabaseClient,
  nisn: string,
  forceRefresh = false
): Promise<any | null> {
  const now = Date.now();
  const cached = studentSessionCache.get(nisn);
  if (!forceRefresh && cached) {
    if (now - cached.fetchedAt < 5000) {
      return cached.item;
    }
    const probe = await client
      .from("sessions")
      .select("updated_at")
      .eq("id", nisn)
      .maybeSingle();
    if (!probe.error) {
      if (!probe.data && cached.item === null) {
        cached.fetchedAt = now;
        return null;
      }
      if (probe.data && cached.item !== null && toEpochMs(probe.data.updated_at) === cached.updatedAtMs && cached.updatedAtMs > 0) {
        cached.fetchedAt = now;
        return cached.item;
      }
    }
  }

  const { data, error } = await client
    .from("sessions")
    .select("id, payload, updated_at")
    .eq("id", nisn)
    .maybeSingle();

  if (error) {
    throw new Error(`sessions: ${error.message}`);
  }

  const item = data ? { id: data.id, ...(data.payload || {}) } : null;
  const updatedAtMs = data ? toEpochMs(data.updated_at) : 0;
  studentSessionCache.set(nisn, { item, updatedAtMs, fetchedAt: Date.now() });
  return item;
}

function normalizeSupabaseUrl(raw: string): { url: string; error?: string } {
  const cleaned = raw.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return { url: "" };
  if (cleaned.startsWith("eyJ") || cleaned.startsWith("sb_")) {
    return {
      url: "",
      error: "Nilai SUPABASE_URL berisi API Key, bukan URL Project. Tukar agar SUPABASE_URL diisi https://xxxx.supabase.co.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned.startsWith("http") ? cleaned : `https://${cleaned}`);
  } catch {
    return { url: "", error: "Format SUPABASE_URL tidak valid. Contoh benar: https://abcdefgh.supabase.co" };
  }

  // Handle dashboard URL like https://supabase.com/dashboard/project/<ref>
  if (parsed.hostname === "supabase.com" || parsed.hostname === "app.supabase.com") {
    const match = parsed.pathname.match(/\/project\/([a-z0-9_-]+)/i);
    if (match?.[1]) {
      return { url: `https://${match[1]}.supabase.co` };
    }
    return {
      url: "",
      error:
        "URL yang dimasukkan adalah halaman dashboard supabase.com, bukan Project URL API. Ambil Project URL (format https://xxxx.supabase.co) dari Project Settings -> Data API.",
    };
  }

  // Strip any accidental extra path like /rest/v1 or /project/default
  return { url: parsed.origin };
}

function detectSupabaseKeyKind(key: string): "service_role" | "anon" | "sb_secret" | "sb_publishable" | "unknown" {
  if (key.startsWith("sb_secret_")) return "sb_secret";
  if (key.startsWith("sb_publishable_")) return "sb_publishable";
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
      const parsed = JSON.parse(payloadJson);
      if (parsed?.role === "service_role") return "service_role";
      if (parsed?.role === "anon") return "anon";
    } catch {
      // ignore decode error
    }
  }
  return "unknown";
}

function getSupabaseConfig(): { client: SupabaseClient | null; configError?: string; host?: string; keyKind?: string } {
  const rawUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
  const rawKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  )
    .trim()
    .replace(/^["']|["']$/g, "");

  if (!rawUrl || !rawKey || rawUrl.includes("YOUR_PROJECT_ID") || rawKey.includes("YOUR_SUPABASE")) {
    return { client: null };
  }
  if (rawKey.startsWith("http://") || rawKey.startsWith("https://")) {
    return {
      client: null,
      configError: "Nilai SUPABASE_SERVICE_ROLE_KEY berisi URL, bukan secret key.",
    };
  }

  const keyKind = detectSupabaseKeyKind(rawKey);
  if (keyKind === "anon" || keyKind === "sb_publishable") {
    return {
      client: null,
      keyKind,
      configError:
        "Kunci yang dimasukkan adalah anon/publishable key (kunci publik), bukan service_role / secret key. Ambil service_role key dari tab Legacy anon, service_role API keys (atau Secret key sb_secret_...) di Supabase Project Settings -> API Keys.",
    };
  }

  const normalized = normalizeSupabaseUrl(rawUrl);
  if (normalized.error || !normalized.url) {
    return { client: null, keyKind, configError: normalized.error || "SUPABASE_URL tidak valid." };
  }

  const client = createClient(normalized.url, rawKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, host: new URL(normalized.url).hostname, keyKind };
}

let cachedClient: SupabaseClient | null = null;
let cachedError: string | undefined;
let cachedHost: string | undefined;
let cachedKeyKind: string | undefined;
let cachedEnvSignature = "";

function getSupabaseState(): { client: SupabaseClient | null; configError?: string; host?: string; keyKind?: string } {
  const sig = `${process.env.SUPABASE_URL || ""}|${process.env.SUPABASE_SERVICE_ROLE_KEY || ""}|${process.env.SUPABASE_ANON_KEY || ""}`;
  if (sig !== cachedEnvSignature) {
    cachedEnvSignature = sig;
    const res = getSupabaseConfig();
    cachedClient = res.client;
    cachedError = res.configError;
    cachedHost = res.host;
    cachedKeyKind = res.keyKind;
  }
  return { client: cachedClient, configError: cachedError, host: cachedHost, keyKind: cachedKeyKind };
}

function supabase(): SupabaseClient | null {
  return getSupabaseState().client;
}

async function queryAllTableRows(
  client: SupabaseClient,
  table: string
): Promise<{ rows: Array<{ id: string; payload: any }>; metaSig: string | null }> {
  const pageSize = 1000;
  let from = 0;
  const allRows: Array<{ id: string; payload: any }> = [];
  let maxUpdatedAtMs = 0;
  let hasUpdatedAt = true;

  while (true) {
    let data: Array<{ id: string; payload: any; updated_at?: string | null }> | null = null;
    let error: any = null;

    if (hasUpdatedAt) {
      const resWithTs = await client
        .from(table)
        .select("id, payload, updated_at")
        .range(from, from + pageSize - 1);
      if (resWithTs.error && /updated_at/i.test(resWithTs.error.message || "")) {
        hasUpdatedAt = false;
      } else {
        data = resWithTs.data as any;
        error = resWithTs.error;
      }
    }

    if (!hasUpdatedAt) {
      const retryRes = await client
        .from(table)
        .select("id, payload")
        .range(from, from + pageSize - 1);
      data = retryRes.data as any;
      error = retryRes.error;
    }

    if (error) {
      throw new Error(`${table}: ${error.message}`);
    }

    const batch = data || [];
    for (const row of batch) {
      allRows.push({ id: row.id, payload: row.payload });
      if (hasUpdatedAt && row.updated_at) {
        const ms = toEpochMs(row.updated_at);
        if (ms > maxUpdatedAtMs) maxUpdatedAtMs = ms;
      }
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return {
    rows: allRows,
    metaSig: hasUpdatedAt ? formatMetaSig(allRows.length, maxUpdatedAtMs) : null,
  };
}

async function probeTableMetaSig(client: SupabaseClient, table: string): Promise<string | null> {
  try {
    const { count, data, error } = await client
      .from(table)
      .select("updated_at", { count: "exact" })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1);

    if (error) return null;
    const latestMs = toEpochMs(data?.[0]?.updated_at);
    return formatMetaSig(count ?? 0, latestMs);
  } catch {
    return null;
  }
}

const lastKnownGoodCache = new Map<string, CacheEntry>();

async function fetchTableEntry(
  client: SupabaseClient,
  table: string,
  forceRefresh = false
): Promise<CacheEntry> {
  const now = Date.now();
  const cached = tableCache.get(table);
  if (cached && (!forceRefresh ? cached.expiresAt > now : now - cached.fetchedAt < 1000)) {
    return cached;
  }

  const existingFetch = inFlightTableFetches.get(table);
  if (existingFetch) {
    return existingFetch;
  }

  const fetchPromise = (async (): Promise<CacheEntry> => {
    try {
      const ttl = CACHE_TTL_MS[table] ?? 5000;

      // Fast metadata-first check: avoids re-downloading multi-MB tables (soal, konfig) when nothing changed
      if (!forceRefresh && cached && cached.metaSig && now - cached.fullFetchedAt < MAX_FULL_REVALIDATE_MS) {
        const remoteSig = await probeTableMetaSig(client, table);
        if (remoteSig !== null && remoteSig === cached.metaSig) {
          const refreshedAt = Date.now();
          const extended: CacheEntry = {
            ...cached,
            fetchedAt: refreshedAt,
            expiresAt: refreshedAt + ttl,
          };
          tableCache.set(table, extended);
          lastKnownGoodCache.set(table, extended);
          return extended;
        }
      }

      let result: { rows: Array<{ id: string; payload: any }>; metaSig: string | null };
      try {
        result = await queryAllTableRows(client, table);
      } catch (_firstErr) {
        await new Promise((r) => setTimeout(r, 350));
        try {
          result = await queryAllTableRows(client, table);
        } catch (secondErr) {
          const fallback = lastKnownGoodCache.get(table);
          if (fallback) {
            console.warn(`Supabase transient read error for ${table}, using last known good cache:`, secondErr);
            return fallback;
          }
          throw secondErr;
        }
      }

      const hash = computeRowsHash(result.rows);
      const fetchedAt = Date.now();
      const entry: CacheEntry = {
        rows: result.rows,
        hash,
        metaSig: result.metaSig,
        fetchedAt,
        fullFetchedAt: fetchedAt,
        expiresAt: fetchedAt + ttl,
      };
      tableCache.set(table, entry);
      lastKnownGoodCache.set(table, entry);
      tableHashes.set(table, hash);
      return entry;
    } finally {
      inFlightTableFetches.delete(table);
    }
  })();

  inFlightTableFetches.set(table, fetchPromise);
  return fetchPromise;
}

async function fetchAllRows(
  client: SupabaseClient,
  table: string,
  forceRefresh = false
): Promise<Array<{ id: string; payload: any }>> {
  const entry = await fetchTableEntry(client, table, forceRefresh);
  return entry.rows;
}

function extractItems(rows: Array<{ id: string; payload: any }>): any[] {
  return rows.map((r) => {
    const p = r.payload && typeof r.payload === "object" ? r.payload : {};
    return { id: r.id, ...p };
  });
}

function extractSoalSortKey(item: any): [number, number] {
  if (typeof item?.createdAt === "number" && Number.isFinite(item.createdAt)) {
    return [item.createdAt, typeof item?.urutan === "number" && Number.isFinite(item.urutan) ? item.urutan : 0];
  }
  const id = String(item?.id || "");
  let m = id.match(/^soal_(?:guru|mass|admin|xl|import)_?(\d+)_(\d+)(?:_|$)/i);
  if (m) return [Number(m[1]), Number(m[2])];
  m = id.match(/^soal_(?:guru|mass|admin|manual|import)?_?(\d+)(?:_|$)/i);
  if (m) return [Number(m[1]), 0];
  m = id.match(/^q(\d+)_(\d+)$/i);
  if (m) return [Number(m[1]), Number(m[2])];
  return [Number.MAX_SAFE_INTEGER, 0];
}

function sortSoalItems<T extends { id?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const [tsA, idxA] = extractSoalSortKey(a);
    const [tsB, idxB] = extractSoalSortKey(b);
    if (tsA !== tsB) return tsA - tsB;
    if (idxA !== idxB) return idxA - idxB;
    return String(a?.id || "").localeCompare(String(b?.id || ""), undefined, { numeric: true });
  });
}

async function upsertInChunks(
  client: SupabaseClient,
  table: string,
  items: Array<{ id: string; payload: any }>,
  updatedAtIso = new Date().toISOString()
): Promise<void> {
  const chunkSize = 200;
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize).map((item) => ({
      id: item.id,
      payload: item.payload,
      updated_at: updatedAtIso,
    }));
    const { error } = await client.from(table).upsert(slice, { onConflict: "id" });
    if (error) {
      throw new Error(`${table} upsert: ${error.message}`);
    }
  }
}

async function deleteIdsInChunks(client: SupabaseClient, table: string, ids: string[]): Promise<void> {
  const cleanIds = ids.filter(Boolean);
  const chunkSize = 200;
  for (let i = 0; i < cleanIds.length; i += chunkSize) {
    const slice = cleanIds.slice(i, i + chunkSize);
    const { error } = await client.from(table).delete().in("id", slice);
    if (error) {
      throw new Error(`${table} delete: ${error.message}`);
    }
  }
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use("/api/db", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Vary", "Accept-Encoding");

    const acceptEnc = String(req.headers["accept-encoding"] || "");
    if (acceptEnc.includes("gzip")) {
      const origJson = res.json.bind(res);
      res.json = ((body: any) => {
        const str = JSON.stringify(body);
        if (str.length < 1024) {
          return origJson(body);
        }
        zlib.gzip(Buffer.from(str, "utf8"), (err, compressed) => {
          if (err || res.headersSent) {
            return origJson(body);
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Encoding", "gzip");
          res.setHeader("Content-Length", String(compressed.length));
          res.end(compressed);
        });
        return res;
      }) as any;
    }
    next();
  });

  // Health probe for Supabase backend
  app.get("/api/db/health", async (_req, res) => {
    const { client, configError, host, keyKind } = getSupabaseState();
    if (configError) {
      return res.status(400).json({
        provider: "supabase",
        configured: true,
        ok: false,
        keyKind,
        message: configError,
      });
    }
    if (!client) {
      return res.json({
        provider: "supabase",
        configured: false,
        ok: false,
        message:
          "Tambahkan secret SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di panel Secrets AI Studio, lalu restart/refresh aplikasi.",
      });
    }

    try {
      const { error } = await client.from("konfigurasi").select("id").limit(1);
      if (error) {
        return res.status(500).json({
          provider: "supabase",
          configured: true,
          ok: false,
          host,
          keyKind,
          message: `Koneksi Supabase gagal (${error.message}). Pastikan Project URL benar (https://xxxx.supabase.co) dan skrip tabel SQL sudah dijalankan.`,
        });
      }
      return res.json({
        provider: "supabase",
        configured: true,
        ok: true,
        host,
        keyKind,
      });
    } catch (err: any) {
      return res.status(500).json({
        provider: "supabase",
        configured: true,
        ok: false,
        host,
        message: err?.message || "Gagal menghubungi server Supabase.",
      });
    }
  });

  // Bulk bootstrap endpoint (reduces HTTP roundtrips significantly for 350+ devices)
  app.get("/api/db/bootstrap", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }

    const scope = String(req.query.scope || "staff");
    const nisn = String(req.query.nisn || "").trim();
    const forceRefresh = req.query.force === "1" || req.query.force === "true";

    try {
      if (scope === "student") {
        // Lightweight student polling/bootstrap: jadwal, tokens, student's own session & student's own hasil
        const [jadwalRows, tokenRows, hasilRows, mySession] = await Promise.all([
          fetchAllRows(client, "jadwal_ujian", forceRefresh),
          fetchAllRows(client, "token_ujian", forceRefresh),
          nisn ? fetchAllRows(client, "hasil_ujian", forceRefresh) : Promise.resolve([]),
          nisn ? fetchStudentSessionCached(client, nisn, forceRefresh) : Promise.resolve(null),
        ]);

        const myHasil = nisn
          ? extractItems(hasilRows).filter((h: any) => String(h?.siswaNisn || "").trim() === nisn)
          : [];

        return res.json({
          ok: true,
          serverTime: Date.now(),
          data: {
            jadwal: extractItems(jadwalRows),
            tokens: extractItems(tokenRows),
            mySession,
            myHasil,
          },
        });
      }

      const keysToLoad =
        scope === "studentInit"
          ? ["kelas", "kelasAkademik", "mapel", "siswa", "jadwal", "tokens", "konfig"]
          : [...ALL_COLLECTION_KEYS];

      let clientVersions: Record<string, string | number> = {};
      if (!forceRefresh && typeof req.query.versions === "string" && req.query.versions.trim()) {
        try {
          const parsed = JSON.parse(req.query.versions);
          if (parsed && typeof parsed === "object") {
            clientVersions = parsed;
          }
        } catch {
          // ignore malformed versions query
        }
      }

      const data: Record<string, any> = {};
      const versionsOut: Record<string, string> = {};

      await Promise.all(
        keysToLoad.map(async (key) => {
          const table = TABLE_MAP[key];
          const entry = await fetchTableEntry(client, table, forceRefresh);
          const currentHash = entry.hash;
          versionsOut[key] = currentHash;

          if (!forceRefresh && clientVersions[key] !== undefined && String(clientVersions[key]) === currentHash) {
            return;
          }

          if (key === "konfig") {
            const docRow = entry.rows.find((r) => r.id === "sekolah") || entry.rows[0];
            const payload = docRow ? docRow.payload : null;
            if (payload && scope === "studentInit") {
              const { ttdKepsekUrl: _ttd, stempelSekolahUrl: _stempel, bgUrl: _bg, ...slimKonfig } = payload;
              data[key] = slimKonfig;
            } else {
              data[key] = payload;
            }
          } else if (key === "soal") {
            data[key] = sortSoalItems(extractItems(entry.rows));
          } else {
            data[key] = extractItems(entry.rows);
          }
        })
      );

      return res.json({ ok: true, serverTime: Date.now(), data, versions: versionsOut });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal memuat data Supabase." });
    }
  });

  // Targeted endpoint: returns only questions for a single mapelId from server cache (saves student bandwidth)
  app.get("/api/db/soal-by-mapel/:mapelId", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const mapelId = String(req.params.mapelId || "").trim();
    if (!mapelId) {
      return res.status(400).json({ ok: false, error: "mapelId wajib diisi." });
    }
    try {
      const rows = await fetchAllRows(client, "soal");
      const items = sortSoalItems(
        extractItems(rows).filter((s: any) => String(s?.mapelId || "").trim() === mapelId)
      );
      return res.json({ ok: true, items });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal memuat soal mata pelajaran." });
    }
  });

  // Get single collection
  app.get("/api/db/collection/:key", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }
    try {
      const rows = await fetchAllRows(client, table);
      if (table === "konfigurasi") {
        const docRow = rows.find((r) => r.id === "sekolah") || rows[0];
        return res.json({ ok: true, data: docRow ? docRow.payload : null });
      }
      const items = extractItems(rows);
      return res.json({ ok: true, items: table === "soal" ? sortSoalItems(items) : items });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal membaca koleksi." });
    }
  });

  // Get single document (e.g. sessions/:nisn)
  app.get("/api/db/doc/:key/:id", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }
    try {
      const { data, error } = await client
        .from(table)
        .select("id, payload")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) {
        throw new Error(`${table}/${req.params.id}: ${error.message}`);
      }
      const item = data ? { id: data.id, ...(data.payload || {}) } : null;
      return res.json({ ok: true, item });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal membaca dokumen." });
    }
  });

  // Sync collection changes (supports targeted { upserts, deleteIds } or full { items })
  app.put("/api/db/collection/:key", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }

    try {
      const { upserts, deleteIds, items } = req.body || {};
      const writeIso = new Date().toISOString();
      const writeTsMs = Date.parse(writeIso);

      if (Array.isArray(upserts) || Array.isArray(deleteIds)) {
        const cleanDeletes = Array.isArray(deleteIds) ? deleteIds.map(String).filter(Boolean) : [];
        const cleanUpserts = Array.isArray(upserts)
          ? upserts
              .filter((item: any) => item && item.id)
              .map((item: any) => ({ id: String(item.id), payload: item }))
          : [];

        if (cleanDeletes.length > 0) {
          await deleteIdsInChunks(client, table, cleanDeletes);
        }
        if (cleanUpserts.length > 0) {
          await upsertInChunks(client, table, cleanUpserts, writeIso);
        }
        patchTableCache(table, cleanUpserts, cleanDeletes, writeTsMs);
        return res.json({ ok: true });
      }

      if (Array.isArray(items)) {
        const cleanItems = items
          .filter((item: any) => item && item.id)
          .map((item: any) => ({ id: String(item.id), payload: item }));

        const incomingIdSet = new Set(cleanItems.map((i) => i.id));
        const { data: existingRows, error: listErr } = await client.from(table).select("id");
        if (listErr) {
          throw new Error(`${table} list: ${listErr.message}`);
        }
        const idsToDelete = (existingRows || [])
          .map((r: any) => String(r.id))
          .filter((id: string) => !incomingIdSet.has(id));

        if (idsToDelete.length > 0) {
          await deleteIdsInChunks(client, table, idsToDelete);
        }
        if (cleanItems.length > 0) {
          await upsertInChunks(client, table, cleanItems, writeIso);
        }
        const now = Date.now();
        const ttl = CACHE_TTL_MS[table] ?? 5000;
        const hash = computeRowsHash(cleanItems);
        const nextEntry: CacheEntry = {
          rows: cleanItems,
          hash,
          metaSig: formatMetaSig(cleanItems.length, cleanItems.length > 0 ? writeTsMs : 0),
          fetchedAt: now,
          fullFetchedAt: now,
          expiresAt: now + ttl,
        };
        tableCache.set(table, nextEntry);
        lastKnownGoodCache.set(table, nextEntry);
        tableHashes.set(table, hash);
        if (table === "sessions") {
          studentSessionCache.clear();
          for (const c of cleanItems) {
            studentSessionCache.set(c.id, {
              item: c.payload && typeof c.payload === "object" ? { id: c.id, ...c.payload } : { id: c.id },
              updatedAtMs: writeTsMs,
              fetchedAt: now,
            });
          }
        }
        return res.json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: "Payload sinkronisasi tidak valid." });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal menyimpan koleksi." });
    }
  });

  // Upsert single document (atomic, collision-free for concurrent student sessions & config)
  app.put("/api/db/doc/:key/:id", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }
    try {
      const payload = req.body?.item ?? req.body?.data ?? req.body;
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ ok: false, error: "Payload dokumen kosong." });
      }
      const docId = String(req.params.id);
      const writeIso = new Date().toISOString();
      const writeTsMs = Date.parse(writeIso);
      const { error } = await client.from(table).upsert(
        {
          id: docId,
          payload,
          updated_at: writeIso,
        },
        { onConflict: "id" }
      );
      if (error) {
        throw new Error(`${table}/${docId}: ${error.message}`);
      }
      patchTableCache(table, [{ id: docId, payload }], [], writeTsMs);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal menyimpan dokumen." });
    }
  });

  // Batch delete documents
  app.post("/api/db/doc/:key/batch-delete", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
      if (ids.length > 0) {
        await deleteIdsInChunks(client, table, ids);
        patchTableCache(table, [], ids, Date.now());
      }
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal menghapus data." });
    }
  });

  // Delete single document
  app.delete("/api/db/doc/:key/:id", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }
    try {
      const docId = String(req.params.id);
      const { error } = await client.from(table).delete().eq("id", docId);
      if (error) {
        throw new Error(`${table}/${docId}: ${error.message}`);
      }
      patchTableCache(table, [], [docId], Date.now());
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal menghapus dokumen." });
    }
  });

  // Clear entire collection
  app.delete("/api/db/collection/:key", async (req, res) => {
    const client = supabase();
    if (!client) {
      return res.status(503).json({ ok: false, error: "Supabase belum dikonfigurasi." });
    }
    const table = TABLE_MAP[req.params.key];
    if (!table) {
      return res.status(400).json({ ok: false, error: `Koleksi tidak dikenal: ${req.params.key}` });
    }
    try {
      const { error } = await client.from(table).delete().neq("id", "__nonexistent_sentinel__");
      if (error) {
        throw new Error(`${table} clear: ${error.message}`);
      }
      const now = Date.now();
      const ttl = CACHE_TTL_MS[table] ?? 5000;
      const emptyHash = computeRowsHash([]);
      const emptyEntry: CacheEntry = {
        rows: [],
        hash: emptyHash,
        metaSig: formatMetaSig(0, 0),
        fetchedAt: now,
        fullFetchedAt: now,
        expiresAt: now + ttl,
      };
      tableCache.set(table, emptyEntry);
      lastKnownGoodCache.set(table, emptyEntry);
      tableHashes.set(table, emptyHash);
      if (table === "sessions") {
        studentSessionCache.clear();
      }
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Gagal mengosongkan tabel." });
    }
  });

  // Vite middleware in development, static bundle in production
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server CBT MAS Al-Ma'sum berjalan di port ${port}`);
  });
}

createApp().catch((err) => {
  console.error("Gagal menjalankan server Express:", err);
  process.exit(1);
});
