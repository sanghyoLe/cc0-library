import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * GBIF occurrence images (https://api.gbif.org/v1, no key): specimen and
 * field photos published by museums, herbaria and other institutions.
 * The query asks for `license=CC0_1_0` and still images. An image is used only
 * when the record's license is CC0 and the image's own license (if given) is CC0.
 */

const BASE = "https://api.gbif.org/v1/occurrence";
const SERVED_BY = "Via GBIF (https://www.gbif.org)";
const CC0_RE = /creativecommons\.org\/publicdomain\/zero\/1\.0/;

interface Media {
  type?: string;
  identifier?: string;
  license?: string;
  rightsHolder?: string;
  title?: string;
}

interface Occurrence {
  key: number;
  scientificName?: string;
  vernacularName?: string;
  license?: string;
  institutionCode?: string;
  datasetName?: string;
  publishingOrgKey?: string;
  recordedBy?: string;
  media?: Media[];
}

const isCc0 = (u?: string) => !!u && CC0_RE.test(u);

/** Images on a CC0 record whose own license is CC0 or unstated (then the record license applies). */
export function cc0Images(o: Occurrence): Media[] {
  if (!isCc0(o.license)) return [];
  return (o.media ?? []).filter((m) => m.type === "StillImage" && m.identifier && (m.license ? isCc0(m.license) : true));
}

export function toAsset(o: Occurrence): Asset | null {
  const img = cc0Images(o)[0];
  if (!img) return null;
  return {
    id: `gbif:${o.key}`,
    kind: "image",
    title: [o.vernacularName, o.scientificName].filter(Boolean).join(" — ") || `Occurrence ${o.key}`,
    creator: img.rightsHolder ?? o.recordedBy ?? o.institutionCode ?? null,
    landingUrl: `https://www.gbif.org/occurrence/${o.key}`,
    fileUrl: img.identifier!,
    thumbnailUrl: img.identifier!,
    tags: [o.scientificName, o.datasetName, o.institutionCode].filter((t): t is string => !!t),
    provider: "gbif",
    origin: o.institutionCode ?? "gbif.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `GBIF occurrence license and media license are CC0 (${BASE}/${o.key})`,
      declaredBy: "institution",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchGbif(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    q: params.query,
    mediaType: "StillImage",
    license: "CC0_1_0",
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  const data = await getJson<{ count: number; results: Occurrence[] }>(fetchImpl, "GBIF", `${BASE}/search?${qs}`);
  return { total: data.count, assets: data.results.map(toAsset).filter((a): a is Asset => a !== null) };
}

export async function getGbif(fetchImpl: FetchLike, key: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(key)) return null;
  const o = await getJson<Occurrence>(fetchImpl, "GBIF", `${BASE}/${key}`);
  const asset = toAsset(o);
  if (!asset) return null;
  return {
    ...asset,
    description: o.datasetName ?? null,
    files: cc0Images(o).map((m, i) => ({ label: m.title || `image ${i + 1}`, url: m.identifier!, sizeBytes: null })),
  };
}
