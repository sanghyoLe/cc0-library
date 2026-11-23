import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Internet Archive (advancedsearch + metadata APIs, no key).
 * Licenses are mixed. The query requires a CC0 `licenseurl`, and each item is
 * rejected unless its own `licenseurl` is the CC0 1.0 deed (http or https).
 */

const BASE = "https://archive.org";
const SERVED_BY = "Via Internet Archive (https://archive.org)";
const CC0_URL_RE = /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/;

export type ArchiveKind = "image" | "audio" | "video";
const MEDIATYPE: Record<ArchiveKind, string> = { image: "image", audio: "audio", video: "movies" };
const KIND_BY_MEDIATYPE: Record<string, ArchiveKind> = { image: "image", audio: "audio", movies: "video" };

/** Formats that describe an item rather than being its content. */
const SKIP_FORMATS = /^(Metadata|Item Tile|Thumbnail|Archive BitTorrent|JSON|Text|Columbia Peaks|Spectrogram|PNG Spectrogram)$/i;

interface SearchDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  mediatype: string;
  licenseurl?: string;
  subject?: string | string[];
}

interface MetadataResponse {
  metadata?: SearchDoc & { description?: string | string[] };
  files?: { name: string; format?: string; size?: string; source?: string }[];
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * User text goes into a Lucene query. Keep letters, digits and spaces only, so
 * the user cannot add operators (OR, field:, quotes) that bypass the CC0 clause.
 */
export function sanitizeQuery(q: string): string {
  return q.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\b(AND|OR|NOT|TO)\b/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Items titled like an archive or disk image (e.g. "pack 2026.7z") have no
 * viewable media of their own, even when filed under an image or audio mediatype.
 */
export function isPackedFile(doc: Pick<SearchDoc, "title">): boolean {
  return /\.(7z|zip|rar|tar|gz|tgz|bz2|xz|iso|img|exe|dmg|bin)$/i.test((first(doc.title) ?? "").trim());
}

export function isCc0(doc: Pick<SearchDoc, "licenseurl">): boolean {
  return !!doc.licenseurl && CC0_URL_RE.test(doc.licenseurl);
}

export function toAsset(doc: SearchDoc): Asset {
  return {
    id: `archive:${doc.identifier}`,
    kind: KIND_BY_MEDIATYPE[doc.mediatype] ?? "video",
    title: first(doc.title) ?? doc.identifier,
    creator: first(doc.creator),
    landingUrl: `${BASE}/details/${encodeURIComponent(doc.identifier)}`,
    fileUrl: null,
    thumbnailUrl: `${BASE}/services/img/${encodeURIComponent(doc.identifier)}`,
    tags: list(doc.subject).slice(0, 20),
    provider: "archive",
    origin: "archive.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Internet Archive item licenseurl="${doc.licenseurl}" (${BASE}/metadata/${doc.identifier})`,
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchArchive(
  fetchImpl: FetchLike,
  kind: ArchiveKind | "all",
  params: SearchParams,
): Promise<{ total: number; assets: Asset[] }> {
  const words = sanitizeQuery(params.query);
  if (!words) return { total: 0, assets: [] };
  const q =
    `(${words}) AND mediatype:${kind === "all" ? "(image OR audio OR movies)" : MEDIATYPE[kind]} AND ` +
    `(licenseurl:"http://creativecommons.org/publicdomain/zero/1.0/" OR licenseurl:"https://creativecommons.org/publicdomain/zero/1.0/")`;
  const qs = new URLSearchParams({ q, rows: String(params.limit), page: String(params.page), output: "json" });
  for (const f of ["identifier", "title", "creator", "mediatype", "licenseurl", "subject"]) qs.append("fl[]", f);
  const data = await getJson<{ response: { numFound: number; docs: SearchDoc[] } }>(
    fetchImpl,
    "Internet Archive",
    `${BASE}/advancedsearch.php?${qs}`,
  );
  const assets = data.response.docs.filter((d) => isCc0(d) && !isPackedFile(d)).map(toAsset);
  return { total: data.response.numFound, assets };
}

export async function getArchive(fetchImpl: FetchLike, identifier: string): Promise<AssetDetail | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;
  const data = await getJson<MetadataResponse>(fetchImpl, "Internet Archive", `${BASE}/metadata/${identifier}`);
  const m = data.metadata;
  if (!m || !isCc0(m)) return null;
  const files = (data.files ?? [])
    .filter((f) => f.source === "original" && !SKIP_FORMATS.test(f.format ?? "") && !/_meta\.(txt|xml)$|_files\.xml$/.test(f.name))
    .map((f) => ({
      label: `${f.name}${f.format ? ` (${f.format})` : ""}`,
      url: `${BASE}/download/${identifier}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
      sizeBytes: f.size ? Number(f.size) : null,
    }));
  return { ...toAsset({ ...m, identifier }), description: first(m.description), files };
}
