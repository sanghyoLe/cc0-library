import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type AssetKind, type FetchLike, type SearchParams } from "../types.js";

/**
 * BlenderKit (https://www.blenderkit.com/api/v1, search needs no key).
 * Assets are under "Royalty Free" or CC0; the query asks for `license:cc_zero`
 * and each result must report license "cc_zero". Downloads go through the
 * BlenderKit add-on or website with a free account, so results link the asset
 * page. The API sends no CORS headers: it works from servers, not browsers.
 */

const BASE = "https://www.blenderkit.com/api/v1";
const SERVED_BY = "Via BlenderKit (https://www.blenderkit.com)";

type BkKind = Extract<AssetKind, "model" | "texture" | "hdri">;
/** BlenderKit asset_type per kind. */
const ASSET_TYPE: Record<BkKind, string> = { model: "model", texture: "material", hdri: "hdr" };
const KIND_OF: Record<string, BkKind> = { model: "model", material: "texture", hdr: "hdri", scene: "model" };

interface BkAsset {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  assetType: string;
  license: string;
  tags?: string[];
  author?: { fullName?: string };
  thumbnailMiddleUrl?: string;
  thumbnailLargeUrl?: string;
  isPrivate?: boolean;
}

export const isCc0 = (a: BkAsset) => a.license === "cc_zero" && !a.isPrivate;

export function toAsset(a: BkAsset): Asset {
  return {
    id: `blenderkit:${a.id}`,
    kind: KIND_OF[a.assetType] ?? "model",
    title: a.displayName || a.name,
    creator: a.author?.fullName ?? null,
    landingUrl: `https://www.blenderkit.com/asset-gallery-detail/${a.id}/`,
    fileUrl: null,
    thumbnailUrl: a.thumbnailMiddleUrl ?? null,
    tags: (a.tags ?? []).slice(0, 20),
    provider: "blenderkit",
    origin: "blenderkit.com",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `BlenderKit asset license "cc_zero" (${BASE}/assets/${a.id}/)`,
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

const plainWords = (q: string) => q.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export async function searchBlenderkit(fetchImpl: FetchLike, kind: BkKind | "all", params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const words = plainWords(params.query);
  if (!words) return { total: 0, assets: [] };
  const filters = kind === "all" ? "" : ` asset_type:${ASSET_TYPE[kind]}`;
  const qs = new URLSearchParams({ query: `${words} license:cc_zero${filters}`, page_size: String(params.limit), page: String(params.page) });
  const data = await getJson<{ count: number; results: BkAsset[] }>(fetchImpl, "BlenderKit", `${BASE}/search/?${qs}`);
  return { total: data.count, assets: data.results.filter(isCc0).map(toAsset) };
}

export async function getBlenderkit(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const a = await getJson<BkAsset>(fetchImpl, "BlenderKit", `${BASE}/assets/${id}/`);
  if (a.id !== id || !isCc0(a)) return null;
  const asset = toAsset(a);
  return {
    ...asset,
    description: a.description ?? null,
    files: [{ label: "download with a free BlenderKit account or the Blender add-on", url: asset.landingUrl, sizeBytes: null }],
  };
}
