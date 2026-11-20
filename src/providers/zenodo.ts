import { getJson } from "../http.js";
import { sanitizeQuery } from "./archive.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Zenodo research records (https://zenodo.org/api, no key): figures, photos
 * and videos deposited by researchers. The query requires
 * `metadata.rights.id:cc0-1.0`, and each record must report license "cc-zero".
 */

const BASE = "https://zenodo.org/api/records";
const SERVED_BY = "Via Zenodo (https://zenodo.org)";

export type ZenodoKind = "image" | "video";

interface ZenodoRecord {
  id: number;
  links: { self_html?: string };
  metadata: {
    title: string;
    description?: string;
    creators?: { name: string }[];
    keywords?: string[];
    license?: { id?: string };
    resource_type?: { type?: string; subtype?: string };
  };
  files?: { key: string; size?: number; links: { self: string } }[];
}

export const isCc0 = (r: ZenodoRecord) => r.metadata.license?.id === "cc-zero";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|tiff?|svg)$/i;

export function toAsset(r: ZenodoRecord): Asset {
  const kind: ZenodoKind = r.metadata.resource_type?.type === "video" ? "video" : "image";
  const preview = (r.files ?? []).find((f) => IMAGE_FILE.test(f.key));
  return {
    id: `zenodo:${r.id}`,
    kind,
    title: r.metadata.title,
    creator: (r.metadata.creators ?? []).map((c) => c.name).slice(0, 3).join("; ") || null,
    landingUrl: r.links.self_html ?? `https://zenodo.org/records/${r.id}`,
    fileUrl: (preview ?? r.files?.[0])?.links.self ?? null,
    thumbnailUrl: preview?.links.self ?? null,
    tags: (r.metadata.keywords ?? []).slice(0, 20),
    provider: "zenodo",
    origin: "zenodo.org",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Zenodo record license "cc-zero" (${BASE}/${r.id})`,
      declaredBy: "uploader",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchZenodo(fetchImpl: FetchLike, kind: ZenodoKind | "all", params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const words = sanitizeQuery(params.query);
  if (!words) return { total: 0, assets: [] };
  const qs = new URLSearchParams({ q: `(${words}) AND metadata.rights.id:cc0-1.0`, size: String(params.limit), page: String(params.page) });
  if (kind !== "all") qs.set("type", kind);
  else {
    qs.append("type", "image");
    qs.append("type", "video");
  }
  const data = await getJson<{ hits: { total: number; hits: ZenodoRecord[] } }>(fetchImpl, "Zenodo", `${BASE}?${qs}`);
  return { total: data.hits.total, assets: data.hits.hits.filter(isCc0).map(toAsset) };
}

export async function getZenodo(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!/^\d+$/.test(id)) return null;
  const r = await getJson<ZenodoRecord>(fetchImpl, "Zenodo", `${BASE}/${id}`);
  if (!isCc0(r)) return null;
  return {
    ...toAsset(r),
    description: r.metadata.description?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || null,
    files: (r.files ?? []).map((f) => ({ label: f.key, url: f.links.self, sizeBytes: f.size ?? null })),
  };
}
