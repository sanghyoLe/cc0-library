import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Openverse indexes openly licensed media from many sites (Flickr, Freesound,
 * Wikimedia, museums...). Licenses are mixed, so every item is filtered twice:
 * the query asks for `license=cc0`, and each returned item is rejected unless
 * its own `license` field is exactly "cc0". Public Domain Mark ("pdm") items
 * are rejected too: PDM is a label, not a CC0 dedication.
 *
 * Anonymous clients may request at most 20 items per page (HTTP 401 above that).
 */

const BASE = "https://api.openverse.org/v1";
export const OPENVERSE_MAX_PAGE_SIZE = 20;
const SERVED_BY = "Search results via Openverse (https://openverse.org)";

export type OpenverseMedia = "image" | "audio";

interface OpenverseItem {
  id: string;
  title: string | null;
  foreign_landing_url: string;
  url: string | null;
  creator: string | null;
  license: string;
  license_url?: string | null;
  source?: string | null;
  provider?: string | null;
  thumbnail?: string | null;
  tags?: { name: string }[] | null;
  filesize?: number | null;
  filetype?: string | null;
  mature?: boolean;
}

interface OpenverseSearchResponse {
  result_count: number;
  results: OpenverseItem[];
}

const endpoint = (media: OpenverseMedia) => (media === "image" ? "images" : "audio");

export function isCc0(item: Pick<OpenverseItem, "license">): boolean {
  return item.license === "cc0";
}

export function toAsset(media: OpenverseMedia, item: OpenverseItem): Asset {
  return {
    id: `openverse:${media}:${item.id}`,
    kind: media,
    title: item.title?.trim() || "(untitled)",
    creator: item.creator ?? null,
    landingUrl: item.foreign_landing_url,
    fileUrl: item.url ?? null,
    thumbnailUrl: item.thumbnail ?? null,
    tags: (item.tags ?? []).map((t) => t.name).slice(0, 20),
    provider: "openverse",
    origin: item.source ?? item.provider ?? "unknown",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: item.license_url ?? CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Openverse item field license="cc0" (${BASE}/${endpoint(media)}/${item.id}/)`,
    },
    servedBy: SERVED_BY,
  };
}

export async function searchOpenverse(
  fetchImpl: FetchLike,
  media: OpenverseMedia,
  params: SearchParams,
): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    q: params.query,
    license: "cc0",
    mature: "false",
    page_size: String(Math.min(params.limit, OPENVERSE_MAX_PAGE_SIZE)),
    page: String(params.page),
  });
  const data = await getJson<OpenverseSearchResponse>(
    fetchImpl,
    "Openverse",
    `${BASE}/${endpoint(media)}/?${qs}`,
  );
  const assets = data.results.filter((i) => isCc0(i) && !i.mature).map((i) => toAsset(media, i));
  return { total: data.result_count, assets };
}

export async function getOpenverse(
  fetchImpl: FetchLike,
  media: OpenverseMedia,
  id: string,
): Promise<AssetDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const item = await getJson<OpenverseItem>(fetchImpl, "Openverse", `${BASE}/${endpoint(media)}/${id}/`);
  if (!isCc0(item)) return null;
  const asset = toAsset(media, item);
  return {
    ...asset,
    description: null,
    files: item.url
      ? [{ label: item.filetype ? `original (${item.filetype})` : "original", url: item.url, sizeBytes: item.filesize ?? null }]
      : [],
  };
}
