import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Wikimedia Commons (MediaWiki Action API, no key).
 * Licenses are mixed across Commons. Search is limited to Category:CC-Zero,
 * and each file is rejected unless its own `extmetadata.License` is "cc0".
 * Wikimedia's API etiquette requires an identifying User-Agent (see http.ts).
 */

const API = "https://commons.wikimedia.org/w/api.php";
const SERVED_BY = "Via Wikimedia Commons (https://commons.wikimedia.org)";

export type CommonsKind = "image" | "audio" | "video";
/** CirrusSearch `filetype:` filter per kind. */
const FILETYPE: Record<CommonsKind, string> = { image: "bitmap|drawing", audio: "audio", video: "video" };

interface ImageInfo {
  url: string;
  descriptionurl: string;
  thumburl?: string;
  mime: string;
  size?: number;
  extmetadata?: Record<string, { value: string } | undefined>;
}

interface Page {
  pageid: number;
  title: string;
  index?: number;
  imageinfo?: ImageInfo[];
}

interface QueryResponse {
  query?: { pages?: Page[]; searchinfo?: { totalhits: number } };
}

const meta = (ii: ImageInfo, key: string) => ii.extmetadata?.[key]?.value ?? null;

/** extmetadata values are HTML fragments; keep the text only. */
export function stripHtml(s: string | null): string | null {
  if (!s) return null;
  const text = s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return text || null;
}

export function isCc0(page: Page): boolean {
  const ii = page.imageinfo?.[0];
  return !!ii && meta(ii, "License") === "cc0";
}

/** `application/ogg` covers both Ogg audio and Ogg video; the extension tells them apart. */
export function kindOfMime(mime: string, fileName = ""): CommonsKind {
  if (mime === "application/ogg") return /\.ogv$/i.test(fileName) ? "video" : "audio";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "image";
}

export function toAsset(page: Page): Asset {
  const ii = page.imageinfo![0];
  const kind = kindOfMime(ii.mime, page.title);
  return {
    id: `commons:${page.pageid}`,
    kind,
    title: page.title.replace(/^File:/, ""),
    creator: stripHtml(meta(ii, "Artist")),
    landingUrl: ii.descriptionurl,
    fileUrl: ii.url,
    // Audio files get a generic file-type icon as thumbnail; drop it.
    thumbnailUrl: kind === "audio" ? null : (ii.thumburl ?? null),
    tags: [],
    provider: "commons",
    origin: "commons.wikimedia.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Wikimedia Commons file extmetadata License="cc0" (${ii.descriptionurl})`,
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

const IMAGEINFO = {
  /** Lets browsers call the API anonymously (MediaWiki CORS). */
  origin: "*",
  prop: "imageinfo",
  iiprop: "url|mime|size|extmetadata",
  iiurlwidth: "320",
  iiextmetadatafilter: "License|LicenseShortName|Artist|ImageDescription",
};

export async function searchCommons(
  fetchImpl: FetchLike,
  kind: CommonsKind | "all",
  params: SearchParams,
): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: `${params.query} incategory:CC-Zero${kind === "all" ? "" : ` filetype:${FILETYPE[kind]}`}`,
    gsrlimit: String(params.limit),
    gsroffset: String((params.page - 1) * params.limit),
    gsrinfo: "totalhits",
    ...IMAGEINFO,
  });
  const data = await getJson<QueryResponse>(fetchImpl, "Wikimedia Commons", `${API}?${qs}`);
  const pages = [...(data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return { total: data.query?.searchinfo?.totalhits ?? pages.length, assets: pages.filter(isCc0).map(toAsset) };
}

export async function getCommons(fetchImpl: FetchLike, pageid: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(pageid)) return null;
  const qs = new URLSearchParams({ action: "query", format: "json", formatversion: "2", pageids: pageid, ...IMAGEINFO });
  const data = await getJson<QueryResponse>(fetchImpl, "Wikimedia Commons", `${API}?${qs}`);
  const page = data.query?.pages?.[0];
  if (!page || !isCc0(page)) return null;
  const ii = page.imageinfo![0];
  return {
    ...toAsset(page),
    description: stripHtml(meta(ii, "ImageDescription")),
    files: [{ label: `original (${ii.mime})`, url: ii.url, sizeBytes: ii.size ?? null }],
  };
}
