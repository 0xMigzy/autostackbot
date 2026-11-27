// Coin logo cache: downloads a coin's logo image (CoinGecko CDN URL) once into a local dir
// and returns its path. Never throws; any failure yields null so callers fall back.
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TIMEOUT_MS = 10_000;

/** True when the bytes start with a PNG, JPEG, GIF or WEBP signature. */
function looksLikeImage(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString("ascii", 0, 4) === "GIF8") return true;
  return buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
}

/**
 * Return a local path to the coin's logo, downloading it on first use.
 * @param {{coingeckoId: string, logoUrl?: string|null}} coin
 * @param {{dir?: string, fetch?: typeof globalThis.fetch}} [opts]
 * @returns {Promise<string|null>} path under `dir`, or null when unavailable
 */
export async function ensureLogo({ coingeckoId, logoUrl }, { dir = "cache/logos", fetch = globalThis.fetch } = {}) {
  // The id becomes a file name, so only accept plain CoinGecko-style ids.
  if (!coingeckoId || !/^[a-z0-9-]+$/i.test(coingeckoId)) return null;
  const file = resolve(process.cwd(), dir, `${coingeckoId}.png`);

  try {
    if ((await stat(file)).size > 0) return file;
  } catch {
    // Not cached yet.
  }

  if (typeof logoUrl !== "string" || !/^https?:\/\//i.test(logoUrl)) return null;

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!looksLikeImage(bytes)) throw new Error("not an image");
    await mkdir(resolve(process.cwd(), dir), { recursive: true });
    // Write to a temp file then rename, so a half-written logo is never cached.
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    return file;
  } catch (err) {
    console.warn(`logo for ${coingeckoId} unavailable: ${err.message}`);
    await unlink(tmp).catch(() => {});
    return null;
  }
}
