import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * iNaturalist observations (https://api.inaturalist.org/v1, no key).
 * Observers choose a license per photo. The query asks for `photo_license=cc0`,
 * and only photos whose own `license_code` is "cc0" are used.
 */

const BASE = "https://api.inaturalist.org/v1/observations";
const SERVED_BY = "Via iNaturalist (https://www.inaturalist.org)";

interface Photo {
  id: number;
  license_code: string | null;
  url: string;
  original_dimensions?: { width: number; height: number } | null;
}

interface Observation {
  id: number;
  uri: string;
  species_guess?: string | null;
  taxon?: { name?: string; preferred_common_name?: string } | null;
  user?: { login?: string; name?: string | null } | null;
  photos?: Photo[];
}

/** Photo URLs come in sizes (square, small, medium, large, original); swap the size segment. */
export const sized = (url: string, size: "square" | "medium" | "large" | "original") => url.replace(/\/(square|small|medium|large|original)\./, `/${size}.`);

const cc0Photos = (o: Observation) => (o.photos ?? []).filter((p) => p.license_code === "cc0");

export function toAsset(o: Observation): Asset | null {
  const photo = cc0Photos(o)[0];
  if (!photo) return null;
  const common = o.taxon?.preferred_common_name;
  const name = o.taxon?.name;
  return {
    id: `inaturalist:${o.id}`,
    kind: "image",
    title: [common ?? o.species_guess, name && name !== common ? `(${name})` : null].filter(Boolean).join(" ") || `Observation ${o.id}`,
    creator: o.user?.name || o.user?.login || null,
    landingUrl: o.uri,
    fileUrl: sized(photo.url, "original"),
    thumbnailUrl: sized(photo.url, "medium"),
    tags: [name, common].filter((t): t is string => !!t),
    provider: "inaturalist",
    origin: "inaturalist.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `iNaturalist photo license_code="cc0" (${BASE}/${o.id})`,
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchINaturalist(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    q: params.query,
    photo_license: "cc0",
    photos: "true",
    quality_grade: "research",
    per_page: String(params.limit),
    page: String(params.page),
  });
  const data = await getJson<{ total_results: number; results: Observation[] }>(fetchImpl, "iNaturalist", `${BASE}?${qs}`);
  return { total: data.total_results, assets: data.results.map(toAsset).filter((a): a is Asset => a !== null) };
}

export async function getINaturalist(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(id)) return null;
  const data = await getJson<{ results: Observation[] }>(fetchImpl, "iNaturalist", `${BASE}/${id}`);
  const o = data.results[0];
  const asset = o ? toAsset(o) : null;
  if (!o || !asset) return null;
  return {
    ...asset,
    description: null,
    files: cc0Photos(o).map((p, i) => ({
      label: `photo ${i + 1}${p.original_dimensions ? ` (${p.original_dimensions.width}×${p.original_dimensions.height})` : ""}`,
      url: sized(p.url, "original"),
      sizeBytes: null,
    })),
  };
}
