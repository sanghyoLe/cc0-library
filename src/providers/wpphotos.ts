import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * WordPress Photo Directory (https://wordpress.org/photos/), WP REST API, no key.
 * Every photo is CC0 ("All photos are CC0 licensed" on the directory page), so
 * CC0 is confirmed at library level. Contributors upload their own photos and
 * the directory moderates submissions; the CC0 claim is still the uploader's,
 * so declaredBy is "uploader".
 */

const BASE = "https://wordpress.org/photos/wp-json/wp/v2/photos";
const SERVED_BY = "Via WordPress Photo Directory (https://wordpress.org/photos/)";
/** Photo posts have a generic title ("Photo detail"); the alt text in `content` describes the photo. */
const TITLE_MAX = 90;

interface WpMedia {
  source_url?: string;
  media_details?: { width?: number; height?: number; filesize?: number; sizes?: Record<string, { source_url: string; width: number; height: number }> };
}

interface WpPhoto {
  id: number;
  link: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  "photo-thumbnail-url"?: string;
  _embedded?: { author?: { name?: string }[]; "wp:featuredmedia"?: WpMedia[] };
}

const text = (html: string | undefined) =>
  (html ?? "").replace(/<[^>]*>/g, " ").replace(/&#8217;/g, "'").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();

export function titleOf(p: WpPhoto): string {
  const alt = text(p.content?.rendered);
  if (alt) return alt.length > TITLE_MAX ? `${alt.slice(0, TITLE_MAX - 1).trimEnd()}…` : alt;
  return text(p.title?.rendered) || `Photo ${p.id}`;
}

export function toAsset(p: WpPhoto): Asset {
  const media = p._embedded?.["wp:featuredmedia"]?.[0];
  return {
    id: `wpphotos:${p.id}`,
    kind: "image",
    title: titleOf(p),
    creator: p._embedded?.author?.[0]?.name ?? null,
    landingUrl: p.link,
    fileUrl: media?.source_url ?? null,
    thumbnailUrl: p["photo-thumbnail-url"] ?? null,
    tags: [],
    provider: "wpphotos",
    origin: "wordpress.org/photos",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "whole-library-cc0",
      source: "https://wordpress.org/photos/ ('All photos are CC0 licensed')",
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchWpPhotos(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    search: params.query,
    per_page: String(params.limit),
    page: String(params.page),
    _embed: "author,wp:featuredmedia",
  });
  const photos = await getJson<WpPhoto[]>(fetchImpl, "WordPress Photo Directory", `${BASE}?${qs}`);
  // The response total lives in a header the shared fetch helper does not expose; report this page's size.
  return { total: photos.length, assets: photos.map(toAsset) };
}

export async function getWpPhoto(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(id)) return null;
  const p = await getJson<WpPhoto>(fetchImpl, "WordPress Photo Directory", `${BASE}/${id}?_embed=author,wp:featuredmedia`);
  const media = p._embedded?.["wp:featuredmedia"]?.[0];
  const files = [];
  if (media?.source_url) {
    const d = media.media_details;
    files.push({ label: `original${d?.width ? ` (${d.width}×${d.height})` : ""}`, url: media.source_url, sizeBytes: d?.filesize ?? null });
    for (const [name, size] of Object.entries(d?.sizes ?? {})) {
      if (name !== "full") files.push({ label: `${name} (${size.width}×${size.height})`, url: size.source_url, sizeBytes: null });
    }
  }
  return { ...toAsset(p), description: text(p.content?.rendered) || null, files };
}
