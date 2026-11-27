import type { KonfigurasiSekolah, Soal } from "../types";

// Client-side WebP/JPEG image compression utility to keep database storage & Supabase egress minimal

export interface CompressImageOptions {
  minLength?: number;
  preserveAlpha?: boolean;
}

export async function compressImageBlobToDataUrl(
  blob: Blob,
  maxWidth = 720,
  quality = 0.72,
  options?: CompressImageOptions
): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Gagal membaca blob gambar"));
    };
    reader.onerror = () => reject(reader.error || new Error("Gagal membaca gambar"));
    reader.readAsDataURL(blob);
  });

  if (blob.type === "image/svg+xml") {
    return rawDataUrl;
  }

  return compressImageDataUrl(rawDataUrl, maxWidth, quality, options);
}

export async function compressImageDataUrl(
  dataUrl: string,
  maxWidth = 720,
  quality = 0.72,
  options?: CompressImageOptions
): Promise<string> {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) return dataUrl;
  const minLength = options?.minLength ?? 20_000;
  if (dataUrl.startsWith("data:image/svg+xml") || dataUrl.length < minLength) {
    return dataUrl;
  }

  if (typeof document === "undefined") return dataUrl;

  const preserveAlpha =
    options?.preserveAlpha ??
    (dataUrl.startsWith("data:image/png") || dataUrl.startsWith("data:image/webp"));

  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        let { width, height } = img;
        if (!width || !height) {
          resolve(dataUrl);
          return;
        }
        if (width > maxWidth) {
          height = Math.max(1, Math.round((height * maxWidth) / width));
          width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(dataUrl);
          return;
        }

        if (!preserveAlpha) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);

        const webp = canvas.toDataURL("image/webp", quality);
        if (webp.startsWith("data:image/webp") && webp.length < dataUrl.length) {
          resolve(webp);
          return;
        }

        if (!preserveAlpha) {
          const jpeg = canvas.toDataURL("image/jpeg", quality);
          if (jpeg.length < dataUrl.length) {
            resolve(jpeg);
            return;
          }
        } else {
          // If WebP wasn't supported by browser, try resized PNG
          const png = canvas.toDataURL("image/png");
          if (png.length < dataUrl.length) {
            resolve(png);
            return;
          }
        }
        resolve(dataUrl);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function compressImageFile(
  file: File,
  maxWidth = 720,
  quality = 0.72,
  options?: CompressImageOptions
): Promise<string> {
  return compressImageBlobToDataUrl(file, maxWidth, quality, options);
}

export async function compressBrandingFile(file: File): Promise<string> {
  return compressImageBlobToDataUrl(file, 360, 0.78, {
    minLength: 12_000,
    preserveAlpha: true,
  });
}

export async function optimizeSingleSoalImages(soal: Soal): Promise<{ soal: Soal; changed: boolean }> {
  let changed = false;
  const next: Soal = { ...soal };

  if (next.gambarUrl && next.gambarUrl.startsWith("data:image/") && next.gambarUrl.length >= 20_000) {
    const compressed = await compressImageDataUrl(next.gambarUrl, 720, 0.72);
    if (compressed.length < next.gambarUrl.length) {
      next.gambarUrl = compressed;
      changed = true;
    }
  }

  if (next.opsiGambar) {
    const nextOpsiGambar = { ...next.opsiGambar };
    let opsiChanged = false;
    for (const key of ["A", "B", "C", "D", "E"] as const) {
      const val = nextOpsiGambar[key];
      if (val && val.startsWith("data:image/") && val.length >= 20_000) {
        const compressed = await compressImageDataUrl(val, 520, 0.72);
        if (compressed.length < val.length) {
          nextOpsiGambar[key] = compressed;
          opsiChanged = true;
        }
      }
    }
    if (opsiChanged) {
      next.opsiGambar = nextOpsiGambar;
      changed = true;
    }
  }

  return { soal: next, changed };
}

export async function optimizeKonfigImages(
  konfig: KonfigurasiSekolah
): Promise<{ konfig: KonfigurasiSekolah; changed: boolean }> {
  let changed = false;
  const next: KonfigurasiSekolah = { ...konfig };

  const brandingKeys = ["logoKiriUrl", "logoKananUrl", "stempelSekolahUrl", "ttdKepsekUrl"] as const;
  for (const key of brandingKeys) {
    const val = next[key];
    if (val && val.startsWith("data:image/") && val.length >= 12_000) {
      const compressed = await compressImageDataUrl(val, 360, 0.78, {
        minLength: 12_000,
        preserveAlpha: true,
      });
      if (compressed.length < val.length) {
        next[key] = compressed;
        changed = true;
      }
    }
  }

  if (next.bgUrl && next.bgUrl.startsWith("data:image/") && next.bgUrl.length >= 24_000) {
    const compressedBg = await compressImageDataUrl(next.bgUrl, 1024, 0.65, {
      minLength: 24_000,
      preserveAlpha: false,
    });
    if (compressedBg.length < next.bgUrl.length) {
      next.bgUrl = compressedBg;
      changed = true;
    }
  }

  return { konfig: next, changed };
}
