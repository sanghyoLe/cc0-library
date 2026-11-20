import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Iconify icon sets (https://api.iconify.design, no key). Iconify serves 280+
 * open-source icon sets under many licenses. Search is limited to the sets
 * whose own license (from /collections) is CC0-1.0. Logo sets (Simple Icons,
 * cryptocurrency icons...) are CC0 as files, but the logos stay trademarks.
 */

const BASE = "https://api.iconify.design";
const SERVED_BY = "Via Iconify (https://iconify.design)";
const SETS_TTL_MS = 60 * 60 * 1000;

interface IconSet {
  name: string;
  total?: number;
  author?: { name?: string; url?: string };
  license?: { title?: string; spdx?: string; url?: string };
  category?: string;
}

let setsCache: { at: number; sets: Record<string, IconSet> } | null = null;

/** Test hook. */
export function resetIconifyCache(): void {
  setsCache = null;
}

/** Icon sets whose license is CC0-1.0, keyed by prefix. */
export async function cc0Sets(fetchImpl: FetchLike): Promise<Record<string, IconSet>> {
  if (setsCache && Date.now() - setsCache.at < SETS_TTL_MS) return setsCache.sets;
  const all = await getJson<Record<string, IconSet>>(fetchImpl, "Iconify", `${BASE}/collections`);
  const sets = Object.fromEntries(Object.entries(all).filter(([, s]) => s.license?.spdx === "CC0-1.0"));
  setsCache = { at: Date.now(), sets };
  return sets;
}

export function toAsset(prefix: string, name: string, set: IconSet): Asset {
  const svg = `${BASE}/${prefix}/${name}.svg`;
  return {
    id: `iconify:${prefix}:${name}`,
    kind: "image",
    title: `${name.replace(/-/g, " ")} — ${set.name}`,
    creator: set.author?.name ?? null,
    landingUrl: `https://icon-sets.iconify.design/${prefix}/${name}/`,
    fileUrl: svg,
    thumbnailUrl: svg,
    tags: [set.name, set.category, "icon", "svg"].filter((t): t is string => !!t),
    provider: "iconify",
    origin: set.author?.url ?? "iconify.design",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: set.license?.url ?? CC0_LICENSE_URL,
      method: "whole-library-cc0",
      source: `Iconify /collections lists icon set "${prefix}" with license CC0-1.0`,
      declaredBy: "library",
    },
    servedBy: SERVED_BY,
  };
}

export async function searchIconify(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const sets = await cc0Sets(fetchImpl);
  const prefixes = Object.keys(sets);
  if (!prefixes.length) return { total: 0, assets: [] };
  // The search API has no offset; ask for enough results to cover the requested page.
  const want = params.limit * params.page;
  const qs = new URLSearchParams({ query: params.query, prefixes: prefixes.join(","), limit: String(Math.max(32, want)) });
  const data = await getJson<{ icons: string[]; total: number }>(fetchImpl, "Iconify", `${BASE}/search?${qs}`);
  const page = data.icons.slice((params.page - 1) * params.limit, want);
  const assets = page.flatMap((full) => {
    const [prefix, name] = full.split(":");
    return sets[prefix] && name ? [toAsset(prefix, name, sets[prefix])] : [];
  });
  return { total: data.total, assets };
}

export async function getIconify(fetchImpl: FetchLike, prefix: string, name: string): Promise<AssetDetail | null> {
  if (!/^[a-z0-9-]+$/.test(prefix) || !/^[a-z0-9-]+$/.test(name)) return null;
  const sets = await cc0Sets(fetchImpl);
  const set = sets[prefix];
  if (!set) return null;
  const asset = toAsset(prefix, name, set);
  return {
    ...asset,
    description: set.category === "Logos" ? "Logo icon: the SVG file is CC0, but the logo is a trademark of its owner." : null,
    files: [
      { label: "SVG", url: asset.fileUrl!, sizeBytes: null },
      { label: "SVG 256px (fixed size)", url: `${asset.fileUrl}?height=256`, sizeBytes: null },
    ],
  };
}
