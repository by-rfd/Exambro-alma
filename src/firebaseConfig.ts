import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  doc,
  collection,
  onSnapshot,
  getDocFromServer,
} from "firebase/firestore";
import firebaseConfig from "./firebase-applet-config.json";
import type {
  Kelas,
  KelasAkademik,
  Mapel,
  Siswa,
  Guru,
  Pengawas,
  JadwalNgawas,
  Soal,
  JadwalUjian,
  TokenUjian,
  SesiSiswa,
  HasilUjian,
  KonfigurasiSekolah,
} from "./types";
import { sortSoalByUploadOrder } from "./utils/examQuestionFilter";

// Safe payload cleaner: recurses and removes any undefined fields
export function cleanPayload<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => cleanPayload(item)) as any;
  }
  if (typeof obj === "object" && !(obj instanceof Date)) {
    const cleaned: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) {
        cleaned[k] = cleanPayload(v);
      }
    }
    return cleaned;
  }
  return obj;
}

export enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export const isFirebaseConfigured =
  Boolean(firebaseConfig.apiKey) &&
  firebaseConfig.apiKey !== "YOUR_API_KEY_PLACEHOLDER" &&
  !firebaseConfig.apiKey.startsWith("YOUR_");

export let db: any = null;
export let auth: any = null;

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
) {
  const currentUser = auth?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid || null,
      email: currentUser?.email || null,
      emailVerified: currentUser?.emailVerified || null,
      isAnonymous: currentUser?.isAnonymous || null,
      tenantId: currentUser?.tenantId || null,
      providerInfo:
        currentUser?.providerData?.map((provider: any) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Database Error Decoded: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// ------------------------------------------------------------------------
// REACTIVE LOCAL CACHE & SUBSCRIBERS
// ------------------------------------------------------------------------

type Subscriber = () => void;
const subscribers = new Set<Subscriber>();

export function notifySync() {
  subscribers.forEach((cb) => cb());
}

export function subscribeToDB(cb: Subscriber) {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

const DEFAULT_KELAS: Kelas[] = [
  { id: "k1", nama: "Ruang CBT 01", jurusan: "UMUM" },
  { id: "k2", nama: "Ruang CBT 02", jurusan: "UMUM" },
  { id: "k3", nama: "Ruang LAB-1", jurusan: "LAB" },
  { id: "k4", nama: "Ruang LAB-2", jurusan: "LAB" },
];

const DEFAULT_KELAS_AKADEMIK: KelasAkademik[] = [
  { id: "ka_x_1", nama: "Kelas X-1" },
  { id: "ka_x_2", nama: "Kelas X-2" },
  { id: "ka_x_3", nama: "Kelas X-3" },
  { id: "ka_xi_1", nama: "Kelas XI-1" },
  { id: "ka_xi_2", nama: "Kelas XI-2" },
  { id: "ka_xi_3", nama: "Kelas XI-3" },
  { id: "ka_xii_1", nama: "Kelas XII-1" },
  { id: "ka_xii_2", nama: "Kelas XII-2" },
  { id: "ka_xii_3", nama: "Kelas XII-3" },
  { id: "ka_x_legacy", nama: "Kelas X" },
  { id: "ka_xi_legacy", nama: "XI IPA" },
  { id: "ka_xii_legacy", nama: "XII IPA" },
  { id: "ka_xii_ips_legacy", nama: "XII IPS" },
];

const DEFAULT_MAPEL: Mapel[] = [
  { id: "m1", nama: "Matematika Peminatan", kode: "MAT-XII" },
  { id: "m2", nama: "Bahasa Inggris", kode: "ING-XII" },
  { id: "m3", nama: "Fisika", kode: "FIS-XII" },
  { id: "m4", nama: "Biologi", kode: "BIO-XII" },
];

const DEFAULT_GURU: Guru[] = [
  { id: "g1", nama: "H. Ahmad Fauzi, S.Pd.", nip: "19840112 201001 1 002", username: "guru1", password: "Password123", mapelIds: ["m1", "m3"] },
  { id: "g2", nama: "Dra. Siti Masithoh", nip: "19720815 199803 2 001", username: "guru2", password: "Password123", mapelIds: ["m2", "m4"] },
];

const DEFAULT_PENGAWAS: Pengawas[] = [
  { id: "p1", nama: "Drs. H. Mulyadi, M.Pd.", nip: "19760514 200212 1 003", username: "pengawas1", password: "Password123" },
  { id: "p2", nama: "Siti Rahmawati, S.Sos.", nip: "19831120 201101 2 004", username: "pengawas2", password: "Password123" },
];

const DEFAULT_JADWAL_NGAWAS: JadwalNgawas[] = [
  { id: "jn1", pengawasId: "p1", mapelId: "m1", ruangId: "k1", sesi: "Sesi I (07:30 - 09:30)", tanggal: "2026-06-08" },
  { id: "jn2", pengawasId: "p2", mapelId: "m2", ruangId: "k2", sesi: "Sesi I (07:30 - 09:30)", tanggal: "2026-06-08" },
];

const DEFAULT_SISWA: Siswa[] = [
  { id: "s1", nama: "Ahmad Dani", nisn: "0065432101", username: "siswa1", password: "Password123", kelasId: "k1", kelas: "XII IPA", noPeserta: "26-04-01-0001" },
  { id: "s2", nama: "Budi Santoso", nisn: "0065432102", username: "siswa2", password: "Password123", kelasId: "k1", kelas: "XII IPA", noPeserta: "26-04-01-0002" },
  { id: "s3", nama: "Citra Kirana", nisn: "0065432103", username: "siswa3", password: "Password123", kelasId: "k2", kelas: "XII IPS", noPeserta: "26-04-02-0001" },
  { id: "s4", nama: "Dewi Lestari", nisn: "0065432104", username: "siswa4", password: "Password123", kelasId: "k3", kelas: "Kelas X", noPeserta: "26-04-03-0001" },
  { id: "s5", nama: "Farhan Malik", nisn: "0065432105", username: "siswa5", password: "Password123", kelasId: "k4", kelas: "XI IPA", noPeserta: "26-04-04-0001" },
];

const DEFAULT_SOAL: Soal[] = [
  {
    id: "q1_1",
    mapelId: "m1",
    teks: "Berapakah hasil dari turunan pertama fungsi f(x) = sin^2(3x)?",
    opsi: {
      A: "3 sin(6x)",
      B: "6 sin(3x) cos(3x)",
      C: "3 sin(3x)",
      D: "3 cos(6x)",
      E: "6 cos(3x)",
    },
    kunci: "A",
  },
  {
    id: "q1_2",
    mapelId: "m1",
    teks: "Carilah nilai limit dari (x^2 - 4) / (x - 2) saat x mendekati 2.",
    opsi: {
      A: "2",
      B: "4",
      C: "0",
      D: "Tak terhingga",
      E: "1",
    },
    kunci: "B",
  },
  {
    id: "q1_3",
    mapelId: "m1",
    teks: "Persamaan garis singgung kurva y = x^2 - 2x + 1 di titik (1,0) adalah...",
    opsi: {
      A: "y = 0",
      B: "y = x - 1",
      C: "y = 2x - 2",
      D: "y = -x + 1",
      E: "y = 2x",
    },
    kunci: "A",
  },
  {
    id: "q1_4",
    mapelId: "m1",
    teks: "Bila f(x) = 3x^2 - 5x + 2, maka nilai f'(2) adalah...",
    opsi: {
      A: "7",
      B: "12",
      C: "5",
      D: "8",
      E: "6",
    },
    kunci: "A",
  },
  {
    id: "q1_5",
    mapelId: "m1",
    teks: "Berapakah rata-rata (mean) dari data berkelompok berikut: 10, 15, 20, 25, 30?",
    opsi: {
      A: "15",
      B: "20",
      C: "25",
      D: "30",
      E: "18",
    },
    kunci: "B",
  },
  {
    id: "q2_1",
    mapelId: "m2",
    teks: "Choose the correct sentence to complete the dialogues:\nJohn: 'Would you like some coffee?'\nMarry: '________. I don't drink caffeine.'",
    opsi: {
      A: "Yes, please",
      B: "No, thank you",
      C: "I'd love to",
      D: "Sure, sounds great",
      E: "Of course",
    },
    kunci: "B",
  },
  {
    id: "q2_2",
    mapelId: "m2",
    teks: "Identify the passive form of: 'The chef prepares the delicious meal.'",
    opsi: {
      A: "The delicious meal is prepared by the chef.",
      B: "The delicious meal is preparing by the chef.",
      C: "The delicious meal was prepared by the chef.",
      D: "The delicious meal has been prepared by the chef.",
      E: "The chef is preparing the delicious meal.",
    },
    kunci: "A",
  },
];

const DEFAULT_JADWAL: JadwalUjian[] = [
  {
    id: "j1",
    mapelId: "m1",
    kelasIds: ["XII IPA", "XII IPS"],
    tanggal: new Date().toISOString().split("T")[0],
    jamMulai: "00:00",
    jamSelesai: "23:59",
    acakSoal: true,
    durasiMenit: 120,
  },
  {
    id: "j2",
    mapelId: "m2",
    kelasIds: ["Kelas X", "XI IPA", "XI IPS"],
    tanggal: new Date().toISOString().split("T")[0],
    jamMulai: "00:00",
    jamSelesai: "23:59",
    acakSoal: false,
    durasiMenit: 90,
  },
];

const DEFAULT_KONFIGURASI: KonfigurasiSekolah = {
  namaSekolah: "MA AL-MA'SUM MALAUSMA",
  alamatSekolah: "Jl. Lapangan Olahraga No. 04, Malausma, Majalengka, Jawa Barat",
  kodeRegistrasi: "MA-ALMASUM-2026",
  logoKiriUrl: "/school-logo.png",
  logoKananUrl: "/school-logo.png",
  bgUrl: "",
  ttdKepsekUrl: "",
  stempelSekolahUrl: "",
  namaKepsek: "Drs. KH. Mas'ud Ma'sum, M.Pd.I",
  nipKepsek: "19671104 199403 1 001",
  zonaWaktu: "WIB",
  batasPelanggaran: 3,
};

const memoryCache = new Map<string, any>();

// Lightweight IndexedDB store so >5MB collections (like 1,600+ questions with images) persist across refreshes
const IDB_NAME = "exambro_cache_db";
const IDB_STORE = "collections";

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbWrite(key: string, val: any): Promise<void> {
  const idb = await openIdb();
  if (!idb) return;
  try {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(val, key);
  } catch {
    // ignore IDB write errors
  }
}

async function idbRead<T = any>(key: string): Promise<T | undefined> {
  const idb = await openIdb();
  if (!idb) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = idb.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

let hasLiveSupabaseSoal = false;

if (typeof window !== "undefined") {
  try {
    // Bebaskan kuota ~5MB browser dari cache bank soal lama agar sesi & konfigurasi selalu aman tersimpan
    window.localStorage.removeItem("exambro_soal");
  } catch {
    // Abaikan jika browser membatasi akses localStorage
  }
  void idbRead<any[]>("soal").then((cachedSoal) => {
    if (!hasLiveSupabaseSoal && Array.isArray(cachedSoal) && cachedSoal.length > 0 && !memoryCache.has("soal")) {
      memoryCache.set("soal", sortSoalByUploadOrder(cachedSoal));
      notifySync();
    }
  });
}

function safeWriteLocalStorage(key: string, serialized: string) {
  if (typeof window === "undefined") return;
  // Bank soal bisa >5MB sehingga disimpan di IndexedDB + memoryCache + Supabase, bukan localStorage
  if (key === "soal" || serialized.length > 1_500_000) return;
  try {
    window.localStorage.setItem(`exambro_${key}`, serialized);
  } catch (err) {
    console.warn(`Penyimpanan lokal browser penuh untuk '${key}', dialihkan ke memori aktif:`, err);
  }
}

const storage = {
  get: <T>(key: string, defaultValue: T): T => {
    if (memoryCache.has(key)) {
      return memoryCache.get(key) as T;
    }
    if (key !== "soal" && typeof window !== "undefined") {
      try {
        const data = window.localStorage.getItem(`exambro_${key}`);
        if (data !== null) {
          const parsed = JSON.parse(data);
          memoryCache.set(key, parsed);
          return parsed as T;
        }
      } catch {
        return defaultValue;
      }
    }
    return defaultValue;
  },
  set: <T>(key: string, val: T, notify = true): T => {
    const normalizedVal = key === "soal" && Array.isArray(val) ? (sortSoalByUploadOrder(val) as unknown as T) : val;
    memoryCache.set(key, normalizedVal);
    try {
      if (key === "soal") {
        void idbWrite("soal", normalizedVal);
      } else {
        const serialized = JSON.stringify(normalizedVal);
        safeWriteLocalStorage(key, serialized);
        if (serialized.length > 1_500_000) {
          void idbWrite(key, normalizedVal);
        }
      }
    } catch (e) {
      console.warn(`Gagal serialisasi cache '${key}':`, e);
    }
    if (notify) notifySync();
    return normalizedVal;
  },
};

export function updateLocalSessionCache(session: SesiSiswa) {
  if (!session || !session.id) return;
  const current = storage.get<SesiSiswa[]>("sessions", []);
  const next = [...current.filter((s) => s.id !== session.id), session];
  storage.set("sessions", next);
}

// ------------------------------------------------------------------------
// SYNC STATUS & BACKEND PROVIDER MANAGEMENT
// ------------------------------------------------------------------------
export type BackendProvider = "supabase" | "firestore-readonly" | "unconfigured";

export interface SyncStatus {
  pendingCount: number;
  outboxCount?: number;
  lastSavedAt: number | null;
  lastSyncedAt?: number | null;
  lastError: string | null;
  cloudReady: boolean;
  quotaExceeded: boolean;
  provider?: BackendProvider;
}

let activeProvider: BackendProvider = "unconfigured";
let syncMode: "staff" | "student" = "staff";
let activeStudentNisn = "";

let currentSyncStatus: SyncStatus = {
  pendingCount: 0,
  outboxCount: 0,
  lastSavedAt: null,
  lastSyncedAt: null,
  lastError: null,
  cloudReady: false,
  quotaExceeded: false,
  provider: "unconfigured",
};

type SyncStatusSubscriber = (status: SyncStatus) => void;
const syncStatusSubscribers = new Set<SyncStatusSubscriber>();

function notifySyncStatus() {
  syncStatusSubscribers.forEach((cb) => cb(currentSyncStatus));
}

export function getBackendProvider(): BackendProvider {
  return activeProvider;
}

export function getSyncStatus(): SyncStatus {
  return currentSyncStatus;
}

export function subscribeToSyncStatus(cb: SyncStatusSubscriber) {
  syncStatusSubscribers.add(cb);
  return () => {
    syncStatusSubscribers.delete(cb);
  };
}

export function clearSyncError() {
  currentSyncStatus = { ...currentSyncStatus, lastError: null, quotaExceeded: false };
  notifySyncStatus();
}

export function setSyncMode(mode: "staff" | "student", studentNisn?: string) {
  const nextNisn = mode === "student" && studentNisn ? studentNisn.trim() : "";
  const changed = syncMode !== mode || activeStudentNisn !== nextNisn;
  syncMode = mode;
  activeStudentNisn = nextNisn;
  if (changed && activeProvider === "supabase") {
    void fetchSupabaseBootstrap(false, false);
  }
}

const recentlyDeletedDocIds = new Set<string>();
const inFlightWriteTimestamps = new Map<string, number>();

function markDocWriteInFlight(path: string, id: string) {
  inFlightWriteTimestamps.set(`${path}::${id}`, Date.now());
}

function clearDocWriteInFlight(path: string, id: string) {
  const key = `${path}::${id}`;
  setTimeout(() => {
    const ts = inFlightWriteTimestamps.get(key);
    if (ts && Date.now() - ts >= 550) {
      inFlightWriteTimestamps.delete(key);
    }
  }, 600);
}

function isDocWriteProtected(path: string, id: string): boolean {
  const ts = inFlightWriteTimestamps.get(`${path}::${id}`);
  if (!ts) return false;
  if (Date.now() - ts > 8000) {
    inFlightWriteTimestamps.delete(`${path}::${id}`);
    return false;
  }
  return true;
}

export function markDocAsDeleted(id: string) {
  if (!id) return;
  recentlyDeletedDocIds.add(id);
  setTimeout(() => {
    recentlyDeletedDocIds.delete(id);
  }, 30000);
}

function stableStringify(val: any): string {
  if (val === null || val === undefined) return "null";
  if (typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

// ------------------------------------------------------------------------
// SUPABASE SERVER PROXY TRANSPORT (/api/db/*) & PERSISTENT RETRY OUTBOX
// ------------------------------------------------------------------------

const OUTBOX_STORAGE_KEY = "exambro_sync_outbox";

type OutboxOp =
  | { kind: "doc-put"; storageKey: string; docId: string; data: any; queuedAt: number }
  | { kind: "collection-put"; storageKey: string; upserts: any[]; deleteIds: string[]; queuedAt: number }
  | { kind: "doc-delete"; storageKey: string; docId: string; queuedAt: number }
  | { kind: "collection-delete"; storageKey: string; queuedAt: number }
  | { kind: "batch-delete"; storageKey: string; ids: string[]; queuedAt: number };

function loadOutboxFromStorage(): OutboxOp[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let syncOutbox: OutboxOp[] = loadOutboxFromStorage();
let activeWriteCount = 0;
let outboxFlushInProgress = false;
let outboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

function persistOutbox() {
  if (typeof window !== "undefined") {
    try {
      if (syncOutbox.length === 0) {
        window.localStorage.removeItem(OUTBOX_STORAGE_KEY);
      } else {
        const serialized = JSON.stringify(syncOutbox);
        if (serialized.length <= 2_500_000) {
          window.localStorage.setItem(OUTBOX_STORAGE_KEY, serialized);
        }
      }
    } catch {
      // Ignore localStorage quota errors; in-memory outbox remains active
    }
  }
  currentSyncStatus = {
    ...currentSyncStatus,
    outboxCount: syncOutbox.length,
    pendingCount: activeWriteCount + syncOutbox.length,
  };
  notifySyncStatus();
}

function scheduleOutboxFlush(delayMs = 3000) {
  if (outboxRetryTimer || syncOutbox.length === 0) return;
  outboxRetryTimer = setTimeout(() => {
    outboxRetryTimer = null;
    void flushSyncOutbox();
  }, delayMs);
}

function enqueueOutboxOp(op: OutboxOp) {
  if (op.kind === "doc-put") {
    syncOutbox = syncOutbox.filter(
      (existing) =>
        !(
          (existing.kind === "doc-put" || existing.kind === "doc-delete") &&
          existing.storageKey === op.storageKey &&
          existing.docId === op.docId
        )
    );
    syncOutbox.push(op);
  } else if (op.kind === "doc-delete") {
    syncOutbox = syncOutbox.filter(
      (existing) =>
        !(
          (existing.kind === "doc-put" || existing.kind === "doc-delete") &&
          existing.storageKey === op.storageKey &&
          existing.docId === op.docId
        )
    );
    syncOutbox.push(op);
  } else if (op.kind === "collection-delete") {
    syncOutbox = syncOutbox.filter((existing) => existing.storageKey !== op.storageKey);
    syncOutbox.push(op);
  } else if (op.kind === "collection-put") {
    const existingIdx = syncOutbox.findIndex(
      (e) => e.kind === "collection-put" && e.storageKey === op.storageKey
    );
    if (existingIdx !== -1) {
      const prev = syncOutbox[existingIdx] as Extract<OutboxOp, { kind: "collection-put" }>;
      const upsertMap = new Map<string, any>();
      (prev.upserts || []).forEach((u) => u?.id && upsertMap.set(u.id, u));
      (op.upserts || []).forEach((u) => u?.id && upsertMap.set(u.id, u));
      const deleteSet = new Set<string>([...(prev.deleteIds || []), ...(op.deleteIds || [])]);
      upsertMap.forEach((_v, id) => deleteSet.delete(id));
      syncOutbox[existingIdx] = {
        kind: "collection-put",
        storageKey: op.storageKey,
        upserts: Array.from(upsertMap.values()),
        deleteIds: Array.from(deleteSet),
        queuedAt: op.queuedAt,
      };
    } else {
      syncOutbox.push(op);
    }
  } else if (op.kind === "batch-delete") {
    const existingIdx = syncOutbox.findIndex(
      (e) => e.kind === "batch-delete" && e.storageKey === op.storageKey
    );
    if (existingIdx !== -1) {
      const prev = syncOutbox[existingIdx] as Extract<OutboxOp, { kind: "batch-delete" }>;
      syncOutbox[existingIdx] = {
        kind: "batch-delete",
        storageKey: op.storageKey,
        ids: Array.from(new Set([...(prev.ids || []), ...(op.ids || [])])),
        queuedAt: op.queuedAt,
      };
    } else {
      syncOutbox.push(op);
    }
  }
  persistOutbox();
  scheduleOutboxFlush(3000);
}

async function executeOutboxOp(op: OutboxOp): Promise<void> {
  if (op.kind === "doc-put") {
    markDocWriteInFlight(op.storageKey, op.docId);
    try {
      await apiRequest(`/api/db/doc/${op.storageKey}/${encodeURIComponent(op.docId)}`, {
        method: "PUT",
        body: JSON.stringify({ item: cleanPayload(op.data) }),
      });
    } finally {
      clearDocWriteInFlight(op.storageKey, op.docId);
    }
  } else if (op.kind === "collection-put") {
    (op.upserts || []).forEach((u: any) => u?.id && markDocWriteInFlight(op.storageKey, u.id));
    try {
      await apiRequest(`/api/db/collection/${op.storageKey}`, {
        method: "PUT",
        body: JSON.stringify({ upserts: op.upserts, deleteIds: op.deleteIds }),
      });
    } finally {
      (op.upserts || []).forEach((u: any) => u?.id && clearDocWriteInFlight(op.storageKey, u.id));
    }
  } else if (op.kind === "doc-delete") {
    await apiRequest(`/api/db/doc/${op.storageKey}/${encodeURIComponent(op.docId)}`, {
      method: "DELETE",
    });
  } else if (op.kind === "collection-delete") {
    await apiRequest(`/api/db/collection/${op.storageKey}`, { method: "DELETE" });
  } else if (op.kind === "batch-delete") {
    await apiRequest(`/api/db/doc/${op.storageKey}/batch-delete`, {
      method: "POST",
      body: JSON.stringify({ ids: op.ids }),
    });
  }
}

export async function flushSyncOutbox(): Promise<boolean> {
  if (outboxFlushInProgress || syncOutbox.length === 0) return true;
  if (activeProvider !== "supabase") {
    return false;
  }

  outboxFlushInProgress = true;
  try {
    while (syncOutbox.length > 0) {
      const nextOp = syncOutbox[0];
      try {
        await executeOutboxOp(nextOp);
        syncOutbox.shift();
        persistOutbox();
        currentSyncStatus = {
          ...currentSyncStatus,
          lastSavedAt: Date.now(),
          lastError: null,
          quotaExceeded: false,
        };
        notifySyncStatus();
      } catch (err: any) {
        console.warn("Gagal mengirim antrean sinkronisasi, akan dicoba ulang otomatis:", err?.message || err);
        scheduleOutboxFlush(3000);
        return false;
      }
    }
    return true;
  } finally {
    outboxFlushInProgress = false;
  }
}

if (syncOutbox.length > 0) {
  currentSyncStatus = {
    ...currentSyncStatus,
    outboxCount: syncOutbox.length,
    pendingCount: syncOutbox.length,
  };
}

async function apiRequest<T = any>(
  url: string,
  options?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 25000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const bodyStr = typeof options?.body === "string" ? options.body : "";
    const canKeepAlive = Boolean(options?.keepalive && bodyStr.length > 0 && bodyStr.length < 60000);
    const { timeoutMs: _t, ...fetchOpts } = options || {};
    const res = await fetch(url, {
      ...fetchOpts,
      keepalive: canKeepAlive,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) {
      throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

function mergeIncomingCollection(storageKey: string, remoteItems: any[]) {
  const localCurrent = storage.get<any[]>(storageKey, []);
  const localMap = new Map(
    (Array.isArray(localCurrent) ? localCurrent : [])
      .filter((i: any) => i && i.id)
      .map((i: any) => [i.id, i])
  );

  const merged: any[] = [];
  const seenIds = new Set<string>();

  for (const remoteItem of remoteItems || []) {
    if (!remoteItem || !remoteItem.id) continue;
    if (recentlyDeletedDocIds.has(remoteItem.id)) continue;
    seenIds.add(remoteItem.id);
    if (isDocWriteProtected(storageKey, remoteItem.id) && localMap.has(remoteItem.id)) {
      merged.push(localMap.get(remoteItem.id));
    } else {
      merged.push(remoteItem);
    }
  }

  localMap.forEach((item, id) => {
    if (!seenIds.has(id) && !recentlyDeletedDocIds.has(id) && isDocWriteProtected(storageKey, id)) {
      merged.push(item);
    }
  });

  const prevSerialized = memoryCache.has(storageKey) ? JSON.stringify(memoryCache.get(storageKey)) : null;
  const nextSerialized = JSON.stringify(merged);
  if (prevSerialized !== nextSerialized) {
    storage.set(storageKey, merged, false);
    return true;
  }
  return false;
}

let pollInProgress = false;
let knownBootstrapVersions: Record<string, string> = {};
let lastBootstrapScope = "";
let consecutivePollFailures = 0;
let lastSuccessfulSyncAt = 0;
let hasCompletedInitialBootstrap = false;

export async function fetchSoalForMapel(mapelId: string): Promise<Soal[]> {
  const targetId = String(mapelId || "").trim();
  if (!targetId) return [];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await apiRequest<{ ok: boolean; items: Soal[] }>(
        `/api/db/soal-by-mapel/${encodeURIComponent(targetId)}`,
        { timeoutMs: 30000 }
      );
      const items = Array.isArray(res.items) ? res.items : [];
      hasLiveSupabaseSoal = true;
      const existing = storage.get<Soal[]>("soal", []);
      const others = (Array.isArray(existing) ? existing : []).filter(
        (s) => String(s?.mapelId || "").trim() !== targetId
      );
      storage.set("soal", [...others, ...items]);
      return items;
    } catch (err) {
      console.warn(`Percobaan ${attempt + 1} gagal memuat soal mapel dari server:`, err);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
      }
    }
  }

  const cachedIdb = await idbRead<Soal[]>("soal");
  if (Array.isArray(cachedIdb) && cachedIdb.length > 0) {
    const matched = cachedIdb.filter((s) => String(s?.mapelId || "").trim() === targetId);
    if (matched.length > 0) {
      if (!memoryCache.has("soal")) {
        memoryCache.set("soal", cachedIdb);
      }
      return matched;
    }
  }

  return getDB.soal().filter((s) => String(s?.mapelId || "").trim() === targetId);
}

export async function fetchStudentSession(nisn: string): Promise<SesiSiswa | null> {
  const target = String(nisn || "").trim();
  if (!target) return null;
  if (activeProvider === "supabase") {
    try {
      const res = await apiRequest<{ ok: boolean; item: SesiSiswa | null }>(
        `/api/db/doc/sessions/${encodeURIComponent(target)}`
      );
      const remoteSes = res.item;
      const currentSessions = storage.get<SesiSiswa[]>("sessions", []);
      if (remoteSes && !recentlyDeletedDocIds.has(target)) {
        const next = [...currentSessions.filter((s) => s.id !== target), remoteSes];
        storage.set("sessions", next);
        return remoteSes;
      }
      if (!remoteSes) {
        const next = currentSessions.filter((s) => s.id !== target);
        if (next.length !== currentSessions.length) {
          storage.set("sessions", next);
        }
        return null;
      }
    } catch (err) {
      console.warn("Gagal memuat sesi siswa:", err);
    }
  }
  return getDB.sessions().find((s) => s.id === target) || null;
}

async function fetchSupabaseBootstrap(initial = false, forceRefresh = false) {
  if (activeProvider !== "supabase" || pollInProgress) return;
  if (!initial && !forceRefresh && typeof document !== "undefined" && document.visibilityState === "hidden") return;

  pollInProgress = true;
  try {
    if (syncOutbox.length > 0) {
      await flushSyncOutbox();
    }

    if (syncMode === "student" && activeStudentNisn) {
      const forceParam = forceRefresh ? "&force=1" : "";
      const res = await apiRequest<{
        ok: boolean;
        data: { jadwal: any[]; tokens: any[]; mySession: any | null; myHasil?: any[] };
      }>(`/api/db/bootstrap?scope=student&nisn=${encodeURIComponent(activeStudentNisn)}${forceParam}`);
      let changed = false;
      if (Array.isArray(res.data?.jadwal)) {
        if (mergeIncomingCollection("jadwal", res.data.jadwal)) changed = true;
      }
      if (Array.isArray(res.data?.tokens)) {
        if (mergeIncomingCollection("tokens", res.data.tokens)) changed = true;
      }
      if (Array.isArray(res.data?.myHasil)) {
        const remoteHasil = res.data.myHasil.filter((h: any) => h && h.id && !recentlyDeletedDocIds.has(h.id));
        const currentHasil = storage.get<HasilUjian[]>("hasil", []);
        const otherHasil = currentHasil.filter(
          (h) => String(h?.siswaNisn || "").trim() !== activeStudentNisn
        );
        const protectedLocalMine = currentHasil.filter(
          (h) =>
            String(h?.siswaNisn || "").trim() === activeStudentNisn &&
            isDocWriteProtected("hasil", h.id) &&
            !remoteHasil.some((r: any) => r.id === h.id)
        );
        const mergedMine = remoteHasil.map((r: any) => {
          if (isDocWriteProtected("hasil", r.id)) {
            const localMatch = currentHasil.find((l) => l.id === r.id);
            if (localMatch) return localMatch;
          }
          return r;
        });
        const nextHasil = [...otherHasil, ...mergedMine, ...protectedLocalMine];
        if (stableStringify(currentHasil) !== stableStringify(nextHasil)) {
          storage.set("hasil", nextHasil, false);
          changed = true;
        }
      }
      // Update only this student's session so admin/proctor force-submit or reset takes effect immediately
      const currentSessions = storage.get<SesiSiswa[]>("sessions", []);
      const remoteSes = res.data?.mySession;
      if (!isDocWriteProtected("sessions", activeStudentNisn)) {
        if (remoteSes && !recentlyDeletedDocIds.has(activeStudentNisn)) {
          const withoutMe = currentSessions.filter((s) => s.id !== activeStudentNisn);
          const next = [...withoutMe, remoteSes];
          if (stableStringify(currentSessions) !== stableStringify(next)) {
            storage.set("sessions", next, false);
            changed = true;
          }
        } else {
          // Session was deleted (Reset Sesi by proctor/admin)
          const withoutMe = currentSessions.filter((s) => s.id !== activeStudentNisn);
          if (withoutMe.length !== currentSessions.length) {
            storage.set("sessions", withoutMe, false);
            changed = true;
          }
        }
      }
      consecutivePollFailures = 0;
      hasCompletedInitialBootstrap = true;
      lastSuccessfulSyncAt = Date.now();
      if (!currentSyncStatus.cloudReady || currentSyncStatus.lastError || currentSyncStatus.lastSyncedAt !== lastSuccessfulSyncAt) {
        currentSyncStatus = {
          ...currentSyncStatus,
          cloudReady: true,
          lastError: null,
          lastSyncedAt: lastSuccessfulSyncAt,
          quotaExceeded: false,
          provider: "supabase",
        };
        notifySyncStatus();
      }
      if (changed || initial) notifySync();
    } else {
      const isStudentPage =
        typeof window !== "undefined" && window.location.search.toLowerCase().includes("siswa");
      const scope = isStudentPage ? "studentInit" : "staff";
      if (lastBootstrapScope !== scope || forceRefresh) {
        knownBootstrapVersions = {};
        lastBootstrapScope = scope;
      }
      const versionsQuery =
        !initial && !forceRefresh && Object.keys(knownBootstrapVersions).length > 0
          ? `&versions=${encodeURIComponent(JSON.stringify(knownBootstrapVersions))}`
          : "";
      const forceQuery = forceRefresh ? "&force=1" : "";
      const res = await apiRequest<{
        ok: boolean;
        data: Record<string, any>;
        versions?: Record<string, string>;
      }>(`/api/db/bootstrap?scope=${scope}${versionsQuery}${forceQuery}`, {
        timeoutMs: initial || forceRefresh ? 45000 : 25000,
      });
      if (res.versions && typeof res.versions === "object") {
        knownBootstrapVersions = { ...knownBootstrapVersions, ...res.versions };
      }
      const data = res.data || {};
      let changed = false;

      const arrayKeys = [
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
      ];

      for (const k of arrayKeys) {
        if (Array.isArray(data[k])) {
          if (k === "soal") hasLiveSupabaseSoal = true;
          if (mergeIncomingCollection(k, data[k])) changed = true;
        }
      }

      if (data.konfig && !isDocWriteProtected("konfig", "sekolah")) {
        const prevK = memoryCache.has("konfig") ? JSON.stringify(memoryCache.get("konfig")) : null;
        const nextK = JSON.stringify(data.konfig);
        if (prevK !== nextK) {
          storage.set("konfig", data.konfig, false);
          changed = true;
        }
      }

      consecutivePollFailures = 0;
      hasCompletedInitialBootstrap = true;
      lastSuccessfulSyncAt = Date.now();
      currentSyncStatus = {
        ...currentSyncStatus,
        cloudReady: true,
        lastError: null,
        lastSyncedAt: lastSuccessfulSyncAt,
        quotaExceeded: false,
        provider: "supabase",
      };
      notifySyncStatus();

      if (changed || initial) notifySync();
    }
  } catch (err: any) {
    consecutivePollFailures += 1;
    console.warn("Sinkronisasi Supabase sementara tertunda:", err?.message || err);
    if (!hasCompletedInitialBootstrap) {
      currentSyncStatus = {
        ...currentSyncStatus,
        cloudReady: false,
        lastError: `Memuat database dari server (${err?.message || "menghubungkan ulang"})...`,
        provider: "supabase",
      };
      notifySyncStatus();
      setTimeout(() => {
        if (!hasCompletedInitialBootstrap && activeProvider === "supabase") {
          void fetchSupabaseBootstrap(true, false);
        }
      }, 2000);
    } else if (consecutivePollFailures >= 2) {
      currentSyncStatus = {
        ...currentSyncStatus,
        cloudReady: true,
        lastError: `Koneksi ke server sempat terputus (${err?.message || "timeout"}). Mencoba sinkronisasi ulang otomatis...`,
        provider: "supabase",
      };
      notifySyncStatus();
    }
  } finally {
    pollInProgress = false;
  }
}

export async function forceSyncNow(bypassServerCache = true): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (activeProvider !== "supabase") {
    await probeAndActivateSupabase(0);
  }
  if (activeProvider !== "supabase") return false;
  await flushSyncOutbox();
  await fetchSupabaseBootstrap(!hasCompletedInitialBootstrap, bypassServerCache);
  return hasCompletedInitialBootstrap && consecutivePollFailures === 0;
}

function beginWriteTracking() {
  activeWriteCount += 1;
  currentSyncStatus = {
    ...currentSyncStatus,
    pendingCount: activeWriteCount + syncOutbox.length,
    outboxCount: syncOutbox.length,
    lastError: null,
  };
  notifySyncStatus();
}

function endWriteTracking(saved: boolean, errMsg?: string) {
  activeWriteCount = Math.max(0, activeWriteCount - 1);
  currentSyncStatus = {
    ...currentSyncStatus,
    pendingCount: activeWriteCount + syncOutbox.length,
    outboxCount: syncOutbox.length,
    lastSavedAt: saved ? Date.now() : currentSyncStatus.lastSavedAt,
    lastError: errMsg ?? (saved ? null : currentSyncStatus.lastError),
    quotaExceeded: false,
  };
  notifySyncStatus();
}

async function syncArrayToBackend(storageKey: string, newItems: any[], prevItems?: any[]) {
  const cleanedItems = (newItems || [])
    .map((item) => cleanPayload(item))
    .filter((i: any) => Boolean(i && i.id));
  const incomingMap = new Map(cleanedItems.map((item) => [item.id, item]));

  const oldItems = (prevItems ?? storage.get<any[]>(storageKey, [])).map((item) => cleanPayload(item));
  const oldMap = new Map(
    oldItems.filter((i: any) => Boolean(i && i.id)).map((item: any) => [item.id, item])
  );

  const oldDeletedIds = oldItems
    .filter((item: any) => item && item.id && !incomingMap.has(item.id))
    .map((item: any) => item.id);

  oldDeletedIds.forEach((id: string) => markDocAsDeleted(id));

  const changedItems = cleanedItems.filter((item: any) => {
    const prevDoc = oldMap.get(item.id);
    if (!prevDoc) return true;
    return stableStringify(prevDoc) !== stableStringify(item);
  });

  const itemsToWrite = oldItems.length === 0 && changedItems.length === 0 ? cleanedItems : changedItems;

  if (cleanedItems.length > 0 && oldDeletedIds.length === 0 && itemsToWrite.length === 0) {
    return;
  }

  if (activeProvider !== "supabase") {
    if (cleanedItems.length === 0) {
      enqueueOutboxOp({ kind: "collection-delete", storageKey, queuedAt: Date.now() });
    } else {
      enqueueOutboxOp({
        kind: "collection-put",
        storageKey,
        upserts: itemsToWrite,
        deleteIds: oldDeletedIds,
        queuedAt: Date.now(),
      });
    }
    return;
  }

  beginWriteTracking();
  try {
    if (cleanedItems.length === 0) {
      await apiRequest(`/api/db/collection/${storageKey}`, { method: "DELETE" });
    } else {
      itemsToWrite.forEach((item: any) => markDocWriteInFlight(storageKey, item.id));
      try {
        await apiRequest(`/api/db/collection/${storageKey}`, {
          method: "PUT",
          body: JSON.stringify({
            upserts: itemsToWrite,
            deleteIds: oldDeletedIds,
          }),
        });
      } finally {
        itemsToWrite.forEach((item: any) => clearDocWriteInFlight(storageKey, item.id));
      }
    }
    endWriteTracking(true);
  } catch (err: any) {
    console.warn(`Gagal menyimpan '${storageKey}' ke Supabase, masuk antrean retry:`, err?.message || err);
    if (cleanedItems.length === 0) {
      enqueueOutboxOp({ kind: "collection-delete", storageKey, queuedAt: Date.now() });
    } else {
      enqueueOutboxOp({
        kind: "collection-put",
        storageKey,
        upserts: itemsToWrite,
        deleteIds: oldDeletedIds,
        queuedAt: Date.now(),
      });
    }
    endWriteTracking(false, `Koneksi lambat/terputus saat menyimpan (${storageKey}). Data tersimpan lokal & otomatis dikirim ulang.`);
  }
}

async function syncSingleDocToBackend(storageKey: string, docId: string, data: any, keepalive = false) {
  const cleaned = cleanPayload(data);
  if (activeProvider !== "supabase") {
    enqueueOutboxOp({ kind: "doc-put", storageKey, docId, data: cleaned, queuedAt: Date.now() });
    return;
  }

  beginWriteTracking();
  markDocWriteInFlight(storageKey, docId);

  try {
    await apiRequest(`/api/db/doc/${storageKey}/${encodeURIComponent(docId)}`, {
      method: "PUT",
      keepalive,
      body: JSON.stringify({ item: cleaned }),
    });
    endWriteTracking(true);
  } catch (err: any) {
    console.warn(`Gagal menyimpan dokumen ${storageKey}/${docId}, masuk antrean retry:`, err?.message || err);
    enqueueOutboxOp({ kind: "doc-put", storageKey, docId, data: cleaned, queuedAt: Date.now() });
    endWriteTracking(false, `Koneksi sempat terputus (${storageKey}). Perubahan disimpan lokal & otomatis disinkronkan ulang.`);
  } finally {
    clearDocWriteInFlight(storageKey, docId);
  }
}

// Atomic student session upsert: updates localStorage + single row sessions/{nisn} without colliding with other 349 students
export async function syncSingleSession(session: SesiSiswa, keepalive = false): Promise<void> {
  if (!session || !session.id) return;
  const cleaned = cleanPayload(session);
  const current = storage.get<SesiSiswa[]>("sessions", []);
  const next = [...current.filter((s) => s.id !== cleaned.id), cleaned];
  storage.set("sessions", next);
  await syncSingleDocToBackend("sessions", cleaned.id, cleaned, keepalive);
}

// Atomic student result upsert: prevents overwriting/losing other students' results and retries automatically on Wi-Fi hiccups
export async function syncSingleHasil(hasil: HasilUjian, oldIdsToDelete: string[] = []): Promise<void> {
  if (!hasil || !hasil.id) return;
  const cleaned = cleanPayload(hasil);
  const deleteIds = oldIdsToDelete.filter((id) => id && id !== cleaned.id);
  deleteIds.forEach((id) => markDocAsDeleted(id));

  const current = storage.get<HasilUjian[]>("hasil", []);
  const next = [
    ...current.filter((h) => h.id !== cleaned.id && !deleteIds.includes(h.id)),
    cleaned,
  ];
  storage.set("hasil", next);

  await syncSingleDocToBackend("hasil", cleaned.id, cleaned, true);
  if (deleteIds.length > 0) {
    if (activeProvider === "supabase") {
      try {
        await apiRequest(`/api/db/doc/hasil/batch-delete`, {
          method: "POST",
          body: JSON.stringify({ ids: deleteIds }),
        });
      } catch {
        enqueueOutboxOp({ kind: "batch-delete", storageKey: "hasil", ids: deleteIds, queuedAt: Date.now() });
      }
    } else {
      enqueueOutboxOp({ kind: "batch-delete", storageKey: "hasil", ids: deleteIds, queuedAt: Date.now() });
    }
  }
}

async function deleteSingleDocFromBackend(storageKey: string, id: string): Promise<boolean> {
  markDocAsDeleted(id);
  const filtered = storage.get<any[]>(storageKey, []).filter((item) => item.id !== id);
  storage.set(storageKey, filtered);

  if (activeProvider !== "supabase") {
    enqueueOutboxOp({ kind: "doc-delete", storageKey, docId: id, queuedAt: Date.now() });
    return false;
  }

  beginWriteTracking();
  try {
    await apiRequest(`/api/db/doc/${storageKey}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    endWriteTracking(true);
    return true;
  } catch (err: any) {
    console.warn(`Gagal menghapus ${storageKey}/${id}, masuk antrean retry:`, err?.message || err);
    enqueueOutboxOp({ kind: "doc-delete", storageKey, docId: id, queuedAt: Date.now() });
    endWriteTracking(false, `Penghapusan (${storageKey}) tertunda karena koneksi, akan dicoba ulang otomatis.`);
    return false;
  }
}

async function deleteAllDocsFromBackend(storageKey: string): Promise<boolean> {
  const existing = storage.get<any[]>(storageKey, []);
  existing.forEach((item) => item?.id && markDocAsDeleted(item.id));
  storage.set(storageKey, []);

  if (activeProvider !== "supabase") {
    enqueueOutboxOp({ kind: "collection-delete", storageKey, queuedAt: Date.now() });
    return false;
  }

  beginWriteTracking();
  try {
    await apiRequest(`/api/db/collection/${storageKey}`, { method: "DELETE" });
    endWriteTracking(true);
    return true;
  } catch (err: any) {
    console.warn(`Gagal mengosongkan ${storageKey}, masuk antrean retry:`, err?.message || err);
    enqueueOutboxOp({ kind: "collection-delete", storageKey, queuedAt: Date.now() });
    endWriteTracking(false, `Gagal menghapus data di server (${storageKey}), akan dicoba ulang otomatis.`);
    return false;
  }
}

let firestoreFallbackStarted = false;

// ------------------------------------------------------------------------
// READ-ONLY FIRESTORE FALLBACK (only used before Supabase Secrets/backend are active, so user can export Backup JSON)
// ------------------------------------------------------------------------
function startFirestoreReadFallback(reasonMessage: string) {
  if (activeProvider === "supabase") return;
  activeProvider = "firestore-readonly";
  currentSyncStatus = {
    ...currentSyncStatus,
    provider: "firestore-readonly",
    lastError: reasonMessage,
  };
  notifySyncStatus();

  if (firestoreFallbackStarted) return;
  firestoreFallbackStarted = true;

  if (!isFirebaseConfigured) {
    currentSyncStatus = { ...currentSyncStatus, cloudReady: true };
    notifySyncStatus();
    return;
  }

  try {
    const firebaseApp = initializeApp(firebaseConfig);
    try {
      db = initializeFirestore(
        firebaseApp,
        { ignoreUndefinedProperties: true },
        firebaseConfig.firestoreDatabaseId
      );
    } catch {
      db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
    }
    auth = getAuth(firebaseApp);
    signInAnonymously(auth).catch(() => {});
    getDocFromServer(doc(db, "test", "connection")).catch(() => {});

    const syncCollections = [
      { key: "kelas", path: "kelas" },
      { key: "kelasAkademik", path: "kelasAkademik" },
      { key: "mapel", path: "mapel" },
      { key: "siswa", path: "siswa" },
      { key: "guru", path: "guru" },
      { key: "pengawas", path: "pengawas" },
      { key: "jadwalNgawas", path: "jadwalNgawas" },
      { key: "soal", path: "soal" },
      { key: "jadwal", path: "jadwalUjian" },
      { key: "tokens", path: "tokenUjian" },
      { key: "sessions", path: "sessions" },
      { key: "hasil", path: "hasilUjian" },
    ];

    const loadedKeys = new Set<string>();
    const markLoaded = (k: string) => {
      loadedKeys.add(k);
      if (!currentSyncStatus.cloudReady && loadedKeys.size >= syncCollections.length) {
        currentSyncStatus = { ...currentSyncStatus, cloudReady: true };
        notifySyncStatus();
      }
    };

    syncCollections.forEach(({ key, path }) => {
      onSnapshot(
        collection(db, path),
        (snapshot) => {
          if (activeProvider === "supabase") return;
          const items: any[] = [];
          snapshot.forEach((docSnap) => {
            if (!recentlyDeletedDocIds.has(docSnap.id)) {
              items.push({ id: docSnap.id, ...docSnap.data() });
            }
          });
          // Never wipe cached data if Firestore collection is empty
          const existingLocal = storage.get<any[]>(key, []);
          if (items.length > 0 || existingLocal.length === 0) {
            storage.set(key, items, false);
          }
          markLoaded(key);
          notifySync();
        },
        () => {
          markLoaded(key);
        }
      );
    });

    onSnapshot(
      doc(db, "konfigurasi", "sekolah"),
      (snapshot) => {
        if (activeProvider === "supabase") return;
        if (snapshot.exists()) {
          storage.set("konfig", snapshot.data());
        }
      },
      () => {}
    );
  } catch (err) {
    console.warn("Firestore read-only fallback error:", err);
    currentSyncStatus = { ...currentSyncStatus, cloudReady: true };
    notifySyncStatus();
  }
}

let supabasePollStarted = false;
let probeInProgress = false;
let probeRetryTimer: ReturnType<typeof setTimeout> | null = null;

async function probeAndActivateSupabase(retryCount = 0): Promise<void> {
  if (typeof window === "undefined" || probeInProgress) return;
  probeInProgress = true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let res: Response;
    try {
      res = await fetch("/api/db/health", { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Server sedang bersiap (cold start). Menghubungkan ulang otomatis...");
    }
    const health = (await res.json()) as {
      provider?: string;
      configured?: boolean;
      ok?: boolean;
      message?: string;
    };

    if (health.provider === "supabase" && health.configured && health.ok) {
      activeProvider = "supabase";
      knownBootstrapVersions = {};
      currentSyncStatus = {
        ...currentSyncStatus,
        provider: "supabase",
        lastError: null,
        quotaExceeded: false,
      };
      notifySyncStatus();

      await flushSyncOutbox();
      await fetchSupabaseBootstrap(true, false);

      if (!supabasePollStarted) {
        supabasePollStarted = true;
        const scheduleNextPoll = () => {
          const delayMs = syncMode === "student" ? 12000 : 10000;
          setTimeout(async () => {
            await fetchSupabaseBootstrap(false, false);
            scheduleNextPoll();
          }, delayMs);
        };
        scheduleNextPoll();
      }
      return;
    }

    // Only switch to Firestore read-only fallback if Supabase env vars are genuinely unconfigured
    if (health.configured === false) {
      startFirestoreReadFallback(
        health.message ||
          "Database Supabase belum aktif: tambahkan SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY di panel Secrets AI Studio, lalu restart aplikasi."
      );
      return;
    }

    throw new Error(health.message || "Koneksi Supabase sedang dipulihkan...");
  } catch (err: any) {
    console.warn("Probe Supabase tertunda, mencoba ulang:", err?.message || err);
    currentSyncStatus = {
      ...currentSyncStatus,
      lastError: err?.message || "Menghubungkan ke server database...",
    };
    notifySyncStatus();

    if (!probeRetryTimer) {
      const retryDelay = retryCount < 5 ? 1500 : retryCount < 15 ? 3000 : 6000;
      probeRetryTimer = setTimeout(() => {
        probeRetryTimer = null;
        if (activeProvider !== "supabase") {
          void probeAndActivateSupabase(retryCount + 1);
        }
      }, retryDelay);
    }
  } finally {
    probeInProgress = false;
  }
}

if (typeof window !== "undefined") {
  const triggerForegroundSync = () => {
    const now = Date.now();
    if (now - lastSuccessfulSyncAt < 1500) {
      if (syncOutbox.length > 0 && activeProvider === "supabase") {
        void flushSyncOutbox();
      }
      return;
    }
    void forceSyncNow(false);
  };

  window.addEventListener("online", () => {
    void forceSyncNow(false);
  });
  window.addEventListener("focus", triggerForegroundSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      triggerForegroundSync();
    }
  });
}

probeAndActivateSupabase(0);

export async function seedDefaultDataToFirebase() {
  const entries = [
    { key: "kelas", items: DEFAULT_KELAS },
    { key: "kelasAkademik", items: DEFAULT_KELAS_AKADEMIK },
    { key: "mapel", items: DEFAULT_MAPEL },
    { key: "siswa", items: DEFAULT_SISWA },
    { key: "guru", items: DEFAULT_GURU },
    { key: "pengawas", items: DEFAULT_PENGAWAS },
    { key: "jadwalNgawas", items: DEFAULT_JADWAL_NGAWAS },
    { key: "soal", items: DEFAULT_SOAL },
    { key: "jadwal", items: DEFAULT_JADWAL },
  ];

  for (const entry of entries) {
    storage.set(entry.key, entry.items);
    if (activeProvider === "supabase") {
      await apiRequest(`/api/db/collection/${entry.key}`, {
        method: "PUT",
        body: JSON.stringify({ items: cleanPayload(entry.items) }),
      });
    }
  }

  storage.set("konfig", DEFAULT_KONFIGURASI);
  if (activeProvider === "supabase") {
    await apiRequest(`/api/db/doc/konfig/sekolah`, {
      method: "PUT",
      body: JSON.stringify({ item: cleanPayload(DEFAULT_KONFIGURASI) }),
    });
  }
  return true;
}

// Unified Getters
export const getDB = {
  kelas: (): Kelas[] => storage.get<Kelas[]>("kelas", DEFAULT_KELAS),
  kelasAkademik: (): KelasAkademik[] => storage.get<KelasAkademik[]>("kelasAkademik", DEFAULT_KELAS_AKADEMIK),
  mapel: (): Mapel[] => storage.get<Mapel[]>("mapel", DEFAULT_MAPEL),
  siswa: (): Siswa[] => storage.get<Siswa[]>("siswa", DEFAULT_SISWA),
  guru: (): Guru[] => storage.get<Guru[]>("guru", DEFAULT_GURU),
  pengawas: (): Pengawas[] => storage.get<Pengawas[]>("pengawas", DEFAULT_PENGAWAS),
  jadwalNgawas: (): JadwalNgawas[] => storage.get<JadwalNgawas[]>("jadwalNgawas", DEFAULT_JADWAL_NGAWAS),
  soal: (): Soal[] => storage.get<Soal[]>("soal", DEFAULT_SOAL),
  jadwal: (): JadwalUjian[] => storage.get<JadwalUjian[]>("jadwal", DEFAULT_JADWAL),
  tokens: (): TokenUjian[] => storage.get<TokenUjian[]>("tokens", []),
  sessions: (): SesiSiswa[] => storage.get<SesiSiswa[]>("sessions", []),
  hasil: (): HasilUjian[] => storage.get<HasilUjian[]>("hasil", []),
  konfig: (): KonfigurasiSekolah => storage.get<KonfigurasiSekolah>("konfig", DEFAULT_KONFIGURASI),
};

// Unified Setters
export const setDB = {
  kelas: (val: any) => {
    const prev = storage.get<any[]>("kelas", []);
    const res = storage.set("kelas", val);
    syncArrayToBackend("kelas", val, prev);
    return res;
  },
  kelasAkademik: (val: any) => {
    const prev = storage.get<any[]>("kelasAkademik", []);
    const res = storage.set("kelasAkademik", val);
    syncArrayToBackend("kelasAkademik", val, prev);
    return res;
  },
  mapel: (val: any) => {
    const prev = storage.get<any[]>("mapel", []);
    const res = storage.set("mapel", val);
    syncArrayToBackend("mapel", val, prev);
    return res;
  },
  siswa: (val: any) => {
    const prev = storage.get<any[]>("siswa", []);
    const res = storage.set("siswa", val);
    syncArrayToBackend("siswa", val, prev);
    return res;
  },
  guru: (val: any) => {
    const prev = storage.get<any[]>("guru", []);
    const res = storage.set("guru", val);
    syncArrayToBackend("guru", val, prev);
    return res;
  },
  pengawas: (val: any) => {
    const prev = storage.get<any[]>("pengawas", []);
    const res = storage.set("pengawas", val);
    syncArrayToBackend("pengawas", val, prev);
    return res;
  },
  jadwalNgawas: (val: any) => {
    const prev = storage.get<any[]>("jadwalNgawas", []);
    const res = storage.set("jadwalNgawas", val);
    syncArrayToBackend("jadwalNgawas", val, prev);
    return res;
  },
  soal: (val: any) => {
    const prev = storage.get<any[]>("soal", []);
    const res = storage.set("soal", val);
    syncArrayToBackend("soal", val, prev);
    return res;
  },
  jadwal: (val: any) => {
    const prev = storage.get<any[]>("jadwal", []);
    const res = storage.set("jadwal", val);
    syncArrayToBackend("jadwal", val, prev);
    return res;
  },
  tokens: (val: any) => {
    const prev = storage.get<any[]>("tokens", []);
    const res = storage.set("tokens", val);
    syncArrayToBackend("tokens", val, prev);
    return res;
  },
  sessions: (val: any) => {
    const prev = storage.get<any[]>("sessions", []);
    const res = storage.set("sessions", val);
    syncArrayToBackend("sessions", val, prev);
    return res;
  },
  hasil: (val: any) => {
    const prev = storage.get<any[]>("hasil", []);
    const res = storage.set("hasil", val);
    syncArrayToBackend("hasil", val, prev);
    return res;
  },
  konfig: (val: any) => {
    const res = storage.set("konfig", val);
    syncSingleDocToBackend("konfig", "sekolah", val);
    return res;
  },

  deleteSession: (id: string) => deleteSingleDocFromBackend("sessions", id),
  deleteKelas: (id: string) => deleteSingleDocFromBackend("kelas", id),
  deleteKelasAkademik: (id: string) => deleteSingleDocFromBackend("kelasAkademik", id),
  deleteMapel: (id: string) => deleteSingleDocFromBackend("mapel", id),
  deleteSiswa: (id: string) => deleteSingleDocFromBackend("siswa", id),
  deleteAllSiswa: () => deleteAllDocsFromBackend("siswa"),
  deleteGuru: (id: string) => deleteSingleDocFromBackend("guru", id),
  deleteAllGuru: () => deleteAllDocsFromBackend("guru"),
  deletePengawas: (id: string) => deleteSingleDocFromBackend("pengawas", id),
  deleteAllPengawas: async (): Promise<boolean> => {
    const okP = await deleteAllDocsFromBackend("pengawas");
    const okJ = await deleteAllDocsFromBackend("jadwalNgawas");
    return okP && okJ;
  },
  deleteJadwalNgawas: (id: string) => deleteSingleDocFromBackend("jadwalNgawas", id),
  deleteSoal: (id: string) => deleteSingleDocFromBackend("soal", id),
  deleteJadwal: (id: string) => deleteSingleDocFromBackend("jadwal", id),
  deleteHasil: (id: string, _currentHasil?: any[]) => deleteSingleDocFromBackend("hasil", id),
  deleteSelectedHasil: async (ids: string[], _currentHasil?: any[]): Promise<boolean> => {
    ids.forEach((id) => markDocAsDeleted(id));
    const current = storage.get<any[]>("hasil", []);
    const filtered = current.filter((h) => !ids.includes(h.id));
    storage.set("hasil", filtered);

    if (activeProvider !== "supabase") {
      enqueueOutboxOp({ kind: "batch-delete", storageKey: "hasil", ids, queuedAt: Date.now() });
      return false;
    }

    beginWriteTracking();
    try {
      await apiRequest(`/api/db/doc/hasil/batch-delete`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      endWriteTracking(true);
      return true;
    } catch (err: any) {
      enqueueOutboxOp({ kind: "batch-delete", storageKey: "hasil", ids, queuedAt: Date.now() });
      endWriteTracking(false, `Penghapusan hasil tertunda karena koneksi, akan dicoba ulang otomatis.`);
      return false;
    }
  },
  deleteAllHasil: () => deleteAllDocsFromBackend("hasil"),
};

export async function restoreFullBackupToBackend(data: Record<string, any>): Promise<number> {
  const keys = [
    "kelas",
    "kelasAkademik",
    "mapel",
    "siswa",
    "guru",
    "pengawas",
    "jadwalNgawas",
    "soal",
    "jadwal",
    "hasil",
  ] as const;

  let restoredCount = 0;
  for (const key of keys) {
    if (Array.isArray(data[key])) {
      const cleaned = cleanPayload(data[key]).filter((item: any) => Boolean(item && item.id));
      storage.set(key, cleaned);
      restoredCount++;
      if (activeProvider === "supabase") {
        beginWriteTracking();
        try {
          await apiRequest(`/api/db/collection/${key}`, {
            method: "PUT",
            timeoutMs: 60000,
            body: JSON.stringify({ items: cleaned }),
          });
          endWriteTracking(true);
        } catch (err: any) {
          enqueueOutboxOp({
            kind: "collection-put",
            storageKey: key,
            upserts: cleaned,
            deleteIds: [],
            queuedAt: Date.now(),
          });
          endWriteTracking(
            false,
            `Sinkronisasi restore '${key}' tertunda (${err?.message || "koneksi"}), otomatis dicoba ulang.`
          );
        }
      }
    }
  }

  if (data.konfig && typeof data.konfig === "object") {
    const cleanedKonfig = cleanPayload(data.konfig);
    storage.set("konfig", cleanedKonfig);
    await syncSingleDocToBackend("konfig", "sekolah", cleanedKonfig);
    restoredCount++;
  }

  return restoredCount;
}
