import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * The Metropolitan Museum of Art Collection API (https://metmuseum.github.io/).
 * Works covered by the Met's Open Access policy are released under CC0
 * (https://github.com/metmuseum/openaccess: "identified ... with the Creative
 * Commons Zero (CC0) icon"). The API marks them with `isPublicDomain: true`.
 *
 * Search (v1.1) returns only object IDs and ignores `isPublicDomain`, so each
 * object is fetched and rejected unless `isPublicDomain` is true and it has an
 * image. A page can therefore hold fewer items than `limit`.
 */

const SEARCH = "https://collectionapi.metmuseum.org/public/collection/v1.1/search";
const OBJECT = "https://collectionapi.metmuseum.org/public/collection/v1/objects";
const SERVED_BY = "Via The Metropolitan Museum of Art Open Access (http://www.metmuseum.org/about-the-met/policies-and-documents/image-resources)";

interface MetObject {
  objectID: number;
  isPublicDomain: boolean;
  title: string;
  artistDisplayName?: string;
  objectURL: string;
  primaryImage?: string;
  primaryImageSmall?: string;
  additionalImages?: string[];
  classification?: string;
  department?: string;
  objectDate?: string;
  creditLine?: string;
  tags?: { term: string }[] | null;
}

export function isCc0(o: Pick<MetObject, "isPublicDomain" | "primaryImageSmall">): boolean {
  return o.isPublicDomain === true && !!o.primaryImageSmall;
}

export function toAsset(o: MetObject): Asset {
  return {
    id: `met:${o.objectID}`,
    kind: "artwork",
    title: o.title || "(untitled)",
    creator: o.artistDisplayName || null,
    landingUrl: o.objectURL,
    fileUrl: o.primaryImage || o.primaryImageSmall || null,
    thumbnailUrl: o.primaryImageSmall || null,
    tags: [...(o.tags ?? []).map((t) => t.term), o.classification, o.department, o.objectDate]
      .filter((t): t is string => !!t)
      .slice(0, 20),
    provider: "met",
    origin: "metmuseum.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Met Collection API field isPublicDomain=true (${OBJECT}/${o.objectID}); Open Access works are CC0 per https://github.com/metmuseum/openaccess`,
    },
    servedBy: SERVED_BY,
  };
}

const fetchObject = (fetchImpl: FetchLike, id: number | string) => getJson<MetObject>(fetchImpl, "The Met", `${OBJECT}/${id}`);

export async function searchMet(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    q: params.query,
    hasImages: "true",
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  const search = await getJson<{ total: number; objectIDs: number[] | null }>(fetchImpl, "The Met", `${SEARCH}?${qs}`);
  const ids = (search.objectIDs ?? []).slice(0, params.limit);
  const objects = await Promise.allSettled(ids.map((id) => fetchObject(fetchImpl, id)));
  const assets = objects.flatMap((r) => (r.status === "fulfilled" && isCc0(r.value) ? [toAsset(r.value)] : []));
  return { total: search.total, assets };
}

export async function getMet(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(id)) return null;
  const o = await fetchObject(fetchImpl, id);
  if (!isCc0(o)) return null;
  const images = [o.primaryImage, ...(o.additionalImages ?? [])].filter((u): u is string => !!u);
  return {
    ...toAsset(o),
    description: o.creditLine ?? null,
    files: images.map((url, i) => ({ label: i === 0 ? "primary" : `additional ${i}`, url, sizeBytes: null })),
  };
}
