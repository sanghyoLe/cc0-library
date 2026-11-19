import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Sketchfab Data API v3 (search and model info need no key).
 * Licenses are mixed. The query asks for `license=cc0`, and each model is
 * rejected unless its own license is the CC0 entry (uid below, or slug "cc0").
 *
 * Downloads need a user OAuth token, so this provider returns the model page,
 * not file URLs. Sketchfab's API terms require showing the license and crediting
 * the creator (username + model link); `creator` and `landingUrl` carry both.
 */

const BASE = "https://api.sketchfab.com/v3";
const SERVED_BY = "Via Sketchfab (https://sketchfab.com)";
/** Sketchfab's id for "CC0 Public Domain" (https://api.sketchfab.com/v3/licenses). */
export const CC0_LICENSE_UID = "7c23a1ba438d4306920229c12afcb5f9";

interface SketchfabModel {
  uid: string;
  name: string;
  viewerUrl: string;
  description?: string;
  isDownloadable?: boolean;
  isAgeRestricted?: boolean;
  license?: { uid?: string; slug?: string; label?: string } | null;
  user?: { username?: string; displayName?: string; profileUrl?: string };
  tags?: { name: string }[];
  thumbnails?: { images?: { url: string; width: number }[] };
}

export function isCc0(m: Pick<SketchfabModel, "license">): boolean {
  return m.license?.uid === CC0_LICENSE_UID || m.license?.slug === "cc0";
}

function thumbnail(m: SketchfabModel): string | null {
  const imgs = [...(m.thumbnails?.images ?? [])].sort((a, b) => a.width - b.width);
  return (imgs.find((i) => i.width >= 256) ?? imgs.at(-1))?.url ?? null;
}

export function toAsset(m: SketchfabModel): Asset {
  const u = m.user;
  return {
    id: `sketchfab:${m.uid}`,
    kind: "model",
    title: m.name,
    creator: u ? `${u.displayName ?? u.username}${u.username ? ` (@${u.username})` : ""}` : null,
    landingUrl: m.viewerUrl,
    fileUrl: null,
    thumbnailUrl: thumbnail(m),
    tags: (m.tags ?? []).map((t) => t.name).slice(0, 20),
    provider: "sketchfab",
    origin: "sketchfab.com",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Sketchfab model license "CC0 Public Domain" (${BASE}/models/${m.uid})`,
    },
    servedBy: SERVED_BY,
  };
}

export async function searchSketchfab(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const qs = new URLSearchParams({
    type: "models",
    q: params.query,
    license: "cc0",
    count: String(params.limit),
    cursor: String((params.page - 1) * params.limit),
  });
  const data = await getJson<{ results: SketchfabModel[]; totalCount?: number }>(fetchImpl, "Sketchfab", `${BASE}/search?${qs}`);
  const assets = data.results.filter((m) => isCc0(m) && !m.isAgeRestricted).map(toAsset);
  // Search responses carry no total; report what this page returned.
  return { total: data.totalCount ?? assets.length, assets };
}

export async function getSketchfab(fetchImpl: FetchLike, uid: string): Promise<AssetDetail | null> {
  if (!/^[0-9a-f]{32}$/.test(uid)) return null;
  const m = await getJson<SketchfabModel>(fetchImpl, "Sketchfab", `${BASE}/models/${uid}`);
  if (!isCc0(m) || m.isAgeRestricted) return null;
  return {
    ...toAsset(m),
    description: m.description?.trim() || null,
    // Downloads require the user's own Sketchfab login; link the model page instead.
    files: m.isDownloadable ? [{ label: "download on Sketchfab (login required)", url: m.viewerUrl, sizeBytes: null }] : [],
  };
}
