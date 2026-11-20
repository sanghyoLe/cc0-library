import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * PhyloPic silhouettes of organisms (https://api.phylopic.org, no key).
 * Contributors choose a license per image; only images whose license link is
 * the CC0 1.0 deed are used. Search matches taxon names (often scientific
 * names, e.g. "vulpes"), not free text.
 */

const BASE = "https://api.phylopic.org";
const SERVED_BY = "Via PhyloPic (https://www.phylopic.org)";
const ACCEPT = { Accept: "application/vnd.phylopic.v2+json" };
const CC0_RE = /creativecommons\.org\/publicdomain\/zero\/1\.0/;
/** The API versions its data by "build"; requests must name the current one. */
const BUILD_TTL_MS = 60 * 60 * 1000;

interface Link {
  href: string;
  title?: string;
  sizes?: string;
  type?: string;
}

interface PhyloImage {
  uuid: string;
  attribution?: string | null;
  _links: {
    license: Link;
    self: Link;
    vectorFile?: Link;
    sourceFile?: Link;
    rasterFiles?: Link[];
    thumbnailFiles?: Link[];
    contributor?: Link;
    specificNode?: Link;
  };
}

let buildCache: { at: number; build: number } | null = null;

/** Test hook. */
export function resetPhylopicCache(): void {
  buildCache = null;
}

async function currentBuild(fetchImpl: FetchLike): Promise<number> {
  if (buildCache && Date.now() - buildCache.at < BUILD_TTL_MS) return buildCache.build;
  const root = await getJson<{ build: number }>(fetchImpl, "PhyloPic", `${BASE}/`, ACCEPT);
  buildCache = { at: Date.now(), build: root.build };
  return root.build;
}

export const isCc0 = (img: PhyloImage) => CC0_RE.test(img._links.license?.href ?? "");

/** Largest raster file, then the vector, as the primary file. */
function bestFile(img: PhyloImage): string | null {
  const raster = [...(img._links.rasterFiles ?? [])].sort((a, b) => parseInt(b.sizes ?? "0") - parseInt(a.sizes ?? "0"))[0];
  return raster?.href ?? img._links.vectorFile?.href ?? null;
}

export function toAsset(img: PhyloImage): Asset {
  const thumb = [...(img._links.thumbnailFiles ?? [])].sort((a, b) => parseInt(b.sizes ?? "0") - parseInt(a.sizes ?? "0"))[0];
  const taxon = img._links.specificNode?.title ?? img._links.self.title ?? "Silhouette";
  return {
    id: `phylopic:${img.uuid}`,
    kind: "image",
    title: `${taxon} (silhouette)`,
    creator: img.attribution ?? img._links.contributor?.title ?? null,
    landingUrl: `https://www.phylopic.org/images/${img.uuid}`,
    fileUrl: bestFile(img),
    thumbnailUrl: thumb?.href ?? null,
    tags: [taxon, "silhouette"],
    provider: "phylopic",
    origin: "phylopic.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `PhyloPic image license link is the CC0 deed (${BASE}/images/${img.uuid})`,
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchPhylopic(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const name = params.query.toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return { total: 0, assets: [] };
  const build = await currentBuild(fetchImpl);
  const qs = new URLSearchParams({
    build: String(build),
    filter_name: name,
    // Exclude licenses that add conditions; CC0 and Public Domain Mark remain, and PDM is filtered out below.
    filter_license_by: "false",
    filter_license_nc: "false",
    filter_license_sa: "false",
    page: String(params.page - 1),
    embed_items: "true",
  });
  const data = await getJson<{ totalItems?: number; _embedded?: { items?: PhyloImage[] } }>(fetchImpl, "PhyloPic", `${BASE}/images?${qs}`, ACCEPT);
  const items = (data._embedded?.items ?? []).filter(isCc0).slice(0, params.limit);
  return { total: data.totalItems ?? items.length, assets: items.map(toAsset) };
}

export async function getPhylopic(fetchImpl: FetchLike, uuid: string): Promise<AssetDetail | null> {
  if (!/^[0-9a-f-]{36}$/.test(uuid)) return null;
  const build = await currentBuild(fetchImpl);
  const img = await getJson<PhyloImage>(fetchImpl, "PhyloPic", `${BASE}/images/${uuid}?build=${build}`, ACCEPT);
  if (!isCc0(img)) return null;
  const files = [
    ...(img._links.vectorFile ? [{ label: "vector (SVG)", url: img._links.vectorFile.href, sizeBytes: null }] : []),
    ...(img._links.rasterFiles ?? []).map((f) => ({ label: `raster ${f.sizes ?? ""} (PNG)`.trim(), url: f.href, sizeBytes: null })),
  ];
  return { ...toAsset(img), description: null, files };
}
