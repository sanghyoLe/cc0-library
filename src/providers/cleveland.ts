import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type AssetFile, type FetchLike, type SearchParams } from "../types.js";

/**
 * Cleveland Museum of Art Open Access API (https://openaccess-api.clevelandart.org/).
 * The collection mixes CC0 and copyrighted works. The query asks for `cc0=1`,
 * and each item is rejected unless its own `share_license_status` is "CC0".
 * No API key is needed.
 */

const BASE = "https://openaccess-api.clevelandart.org/api/artworks";
const SERVED_BY = "Via Cleveland Museum of Art Open Access (https://www.clevelandart.org/open-access)";
const FIELDS = "id,title,creators,url,images,share_license_status,type,department,creation_date,tombstone";

interface ClevelandImage {
  url: string;
  filesize?: string | null;
}

interface ClevelandArtwork {
  id: number;
  title: string;
  url: string;
  share_license_status: string;
  creators?: { description?: string }[];
  type?: string | null;
  department?: string | null;
  creation_date?: string | null;
  tombstone?: string | null;
  images?: { web?: ClevelandImage | null; print?: ClevelandImage | null; full?: ClevelandImage | null } | null;
}

export function isCc0(a: Pick<ClevelandArtwork, "share_license_status">): boolean {
  return a.share_license_status === "CC0";
}

export function toAsset(a: ClevelandArtwork): Asset {
  const creators = (a.creators ?? []).map((c) => c.description).filter((d): d is string => !!d);
  return {
    id: `cleveland:${a.id}`,
    kind: "artwork",
    title: a.title,
    creator: creators.length ? creators.join("; ") : null,
    landingUrl: a.url,
    fileUrl: a.images?.print?.url ?? a.images?.web?.url ?? null,
    thumbnailUrl: a.images?.web?.url ?? null,
    tags: [a.type, a.department, a.creation_date].filter((t): t is string => !!t),
    provider: "cleveland",
    origin: "clevelandart.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Cleveland Open Access item field share_license_status="CC0" (${BASE}/${a.id})`,
    },
    servedBy: SERVED_BY,
  };
}

export async function searchCleveland(
  fetchImpl: FetchLike,
  params: SearchParams,
): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    q: params.query,
    cc0: "1",
    has_image: "1",
    limit: String(params.limit),
    skip: String((params.page - 1) * params.limit),
    fields: FIELDS,
  });
  const data = await getJson<{ info: { total: number }; data: ClevelandArtwork[] }>(fetchImpl, "Cleveland", `${BASE}/?${qs}`);
  return { total: data.info.total, assets: data.data.filter((a) => isCc0(a) && a.images?.web).map(toAsset) };
}

export async function getCleveland(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(id)) return null;
  const { data: a } = await getJson<{ data: ClevelandArtwork }>(fetchImpl, "Cleveland", `${BASE}/${id}`);
  if (!isCc0(a)) return null;
  const files: AssetFile[] = (["web", "print", "full"] as const).flatMap((k) => {
    const img = a.images?.[k];
    return img ? [{ label: k, url: img.url, sizeBytes: img.filesize ? Number(img.filesize) : null }] : [];
  });
  return { ...toAsset(a), description: a.tombstone ?? null, files };
}
