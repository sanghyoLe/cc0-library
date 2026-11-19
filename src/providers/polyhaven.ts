import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type AssetFile, type AssetKind, type FetchLike, type SearchParams } from "../types.js";

/**
 * Poly Haven publishes every asset under CC0 (https://polyhaven.com/license),
 * so CC0 status is confirmed at library level, not per item.
 *
 * API terms (https://github.com/Poly-Haven/Public-API/blob/master/ToS.md):
 * send a User-Agent naming the app (see http.ts) and credit Poly Haven when
 * showing live API content. `servedBy` carries that credit on every result.
 */

const BASE = "https://api.polyhaven.com";
const SERVED_BY = "Powered by Poly Haven (https://polyhaven.com)";
/** The full /assets index is ~2.4k entries; refresh it at most hourly. */
const INDEX_TTL_MS = 60 * 60 * 1000;

type PolyKind = Extract<AssetKind, "hdri" | "texture" | "model">;
const TYPE_PARAM: Record<PolyKind, string> = { hdri: "hdris", texture: "textures", model: "models" };
/** Poly Haven's numeric `type` field: 0 = HDRI, 1 = texture, 2 = model. */
const KIND_BY_TYPE: Record<number, PolyKind> = { 0: "hdri", 1: "texture", 2: "model" };

interface PolyInfo {
  name: string;
  type: number;
  tags?: string[];
  categories?: string[];
  authors?: Record<string, string>;
  description?: string;
  thumbnail_url?: string;
}

interface PolySearchResponse {
  total: number;
  results: { slug: string; score: number }[];
}

let indexCache: { at: number; data: Record<string, PolyInfo> } | null = null;

/** Test hook: forget the cached /assets index. */
export function resetPolyhavenCache(): void {
  indexCache = null;
}

async function loadIndex(fetchImpl: FetchLike): Promise<Record<string, PolyInfo>> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.data;
  const data = await getJson<Record<string, PolyInfo>>(fetchImpl, "Poly Haven", `${BASE}/assets?type=all`);
  indexCache = { at: Date.now(), data };
  return data;
}

export function toAsset(slug: string, info: PolyInfo): Asset {
  return {
    id: `polyhaven:${slug}`,
    kind: KIND_BY_TYPE[info.type] ?? "texture",
    title: info.name,
    creator: info.authors ? Object.keys(info.authors).join(", ") || null : null,
    landingUrl: `https://polyhaven.com/a/${slug}`,
    fileUrl: null,
    thumbnailUrl: info.thumbnail_url ?? null,
    tags: [...new Set([...(info.tags ?? []), ...(info.categories ?? [])])].slice(0, 20),
    provider: "polyhaven",
    origin: "polyhaven",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "whole-library-cc0",
      source: "https://polyhaven.com/license",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchPolyhaven(
  fetchImpl: FetchLike,
  kind: PolyKind | "all",
  params: SearchParams,
): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({ q: params.query, t: kind === "all" ? "all" : TYPE_PARAM[kind] });
  const [search, index] = await Promise.all([
    getJson<PolySearchResponse>(fetchImpl, "Poly Haven", `${BASE}/search?${qs}`),
    loadIndex(fetchImpl),
  ]);
  const ranked = [...search.results].sort((a, b) => b.score - a.score);
  const start = (params.page - 1) * params.limit;
  const assets = ranked
    .slice(start, start + params.limit)
    .filter((r) => index[r.slug])
    .map((r) => toAsset(r.slug, index[r.slug]));
  return { total: search.total, assets };
}

/** Flattens the nested /files response into one row per downloadable file. */
export function flattenFiles(node: unknown, path: string[] = []): AssetFile[] {
  if (!node || typeof node !== "object") return [];
  const rec = node as Record<string, unknown>;
  if (typeof rec.url === "string") {
    return [{ label: path.join(" / "), url: rec.url, sizeBytes: typeof rec.size === "number" ? rec.size : null }];
  }
  return Object.entries(rec).flatMap(([k, v]) => (k === "include" ? [] : flattenFiles(v, [...path, k])));
}

export async function getPolyhaven(fetchImpl: FetchLike, slug: string): Promise<AssetDetail | null> {
  if (!/^[A-Za-z0-9_.-]+$/.test(slug)) return null;
  const index = await loadIndex(fetchImpl);
  const info = index[slug];
  if (!info) return null;
  const files = await getJson<unknown>(fetchImpl, "Poly Haven", `${BASE}/files/${encodeURIComponent(slug)}`);
  return { ...toAsset(slug, info), description: info.description ?? null, files: flattenFiles(files) };
}
