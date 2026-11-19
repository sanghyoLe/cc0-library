import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type AssetKind, type FetchLike, type SearchParams } from "../types.js";

/**
 * ambientCG publishes every asset under CC0 (https://docs.ambientcg.com/license/),
 * so CC0 status is confirmed at library level.
 *
 * Uses the v3 API (https://docs.ambientcg.com/api/v3/assets/). The site is run
 * by one person and its docs warn the API is not enterprise-grade, so this
 * provider asks only for the fields it needs and never prefetches.
 * The API sends no CORS headers: it works from servers, not from browsers.
 */

const BASE = "https://ambientcg.com/api/v3/assets";
const SERVED_BY = "Via ambientCG (https://ambientcg.com)";
const FIELDS = "type,title,url,tags,thumbnails,shortDescription";

type AcgKind = Extract<AssetKind, "hdri" | "texture" | "model">;
/** v3 `type` filter values requested per kind. */
const TYPE_FILTER: Record<AcgKind | "all", string> = {
  texture: "material",
  hdri: "hdri",
  model: "3d-model",
  all: "material,hdri,3d-model",
};

interface AcgAsset {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  tags?: string[];
  thumbnails?: Record<string, string>;
  shortDescription?: string;
  downloads?: { attributes: string; extension: string; url: string; size?: number }[];
}

interface AcgResponse {
  totalResults: number;
  assets: AcgAsset[];
}

export function kindOf(type: string | undefined): AcgKind {
  if (type === "hdri" || type === "hdri-element") return "hdri";
  if (type === "3d-model") return "model";
  return "texture";
}

export function toAsset(a: AcgAsset): Asset {
  return {
    id: `ambientcg:${a.id}`,
    kind: kindOf(a.type),
    title: a.title ?? a.id,
    creator: "ambientCG",
    landingUrl: a.url ?? `https://ambientcg.com/a/${a.id}`,
    fileUrl: null,
    thumbnailUrl: a.thumbnails?.["256-PNG"] ?? null,
    tags: (a.tags ?? []).slice(0, 20),
    provider: "ambientcg",
    origin: "ambientcg",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "whole-library-cc0",
      source: "https://docs.ambientcg.com/license/",
      declaredBy: "library",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchAmbientcg(
  fetchImpl: FetchLike,
  kind: AcgKind | "all",
  params: SearchParams,
): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    q: params.query,
    type: TYPE_FILTER[kind],
    sort: "popular",
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
    include: FIELDS,
  });
  const data = await getJson<AcgResponse>(fetchImpl, "ambientCG", `${BASE}?${qs}`);
  return { total: data.totalResults, assets: data.assets.map(toAsset) };
}

export async function getAmbientcg(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const qs = new URLSearchParams({ id, include: `${FIELDS},downloads` });
  const data = await getJson<AcgResponse>(fetchImpl, "ambientCG", `${BASE}?${qs}`);
  const a = data.assets.find((x) => x.id === id);
  if (!a) return null;
  return {
    ...toAsset(a),
    description: a.shortDescription || null,
    files: (a.downloads ?? []).map((d) => ({ label: `${d.attributes} (${d.extension})`, url: d.url, sizeBytes: d.size ?? null })),
  };
}
