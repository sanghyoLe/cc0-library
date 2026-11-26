/**
 * Provider fan-out and id routing. Has no Node-only imports, so the same code
 * runs in the MCP server and in the browser gallery (web/).
 */
import { getOpenverse, searchOpenverse } from "./providers/openverse.js";
import { getPolyhaven, searchPolyhaven } from "./providers/polyhaven.js";
import { getAmbientcg, searchAmbientcg } from "./providers/ambientcg.js";
import { getCleveland, searchCleveland } from "./providers/cleveland.js";
import { getMet, searchMet } from "./providers/met.js";
import { getCommons, searchCommons } from "./providers/commons.js";
import { getArchive, searchArchive } from "./providers/archive.js";
import { getSketchfab, searchSketchfab } from "./providers/sketchfab.js";
import { getWpPhoto, searchWpPhotos } from "./providers/wpphotos.js";
import { getINaturalist, searchINaturalist } from "./providers/inaturalist.js";
import { getGbif, searchGbif } from "./providers/gbif.js";
import { getPhylopic, searchPhylopic } from "./providers/phylopic.js";
import { getIconify, searchIconify } from "./providers/iconify.js";
import { getZenodo, searchZenodo } from "./providers/zenodo.js";
import { getGithub, getHuggingface, searchGithub, searchHuggingface } from "./providers/collections.js";
import { getBlenderkit, searchBlenderkit } from "./providers/blenderkit.js";
import type { Asset, AssetDetail, AssetKind, FetchLike, ProviderId } from "./types.js";

export type SearchKind = AssetKind | "any";

export interface SearchOptions {
  /**
   * Providers to leave out. The browser gallery skips ambientCG, whose API
   * sends no CORS headers.
   */
  skip?: ProviderId[];
  /** When set, only these providers run (applied after `skip`). */
  providers?: ProviderId[];
  /**
   * Called each time a provider settles, with the result so far and how many
   * providers are still running, so a UI can show results before slow sources answer.
   */
  onProgress?: (partial: SearchResult, pending: number) => void;
}

export interface SearchResult {
  query: string;
  kind: SearchKind;
  page: number;
  assets: Asset[];
  /** Upstream totals per provider (may exceed what one page returns). */
  totals: Record<string, number>;
  /** Providers that failed; the other providers' results are still returned. */
  errors: string[];
}

/**
 * Runs one search across the providers that serve `kind`. Results are first
 * interleaved by provider, so one provider cannot crowd out the others, and
 * then stably sorted by `relevance`: items whose title or tags contain the
 * query words come first. Providers that match loosely (taxon or full-text
 * search) return items that share no word with the query; those sink to the
 * end instead of filling the first page.
 */
export async function search(
  fetchImpl: FetchLike,
  query: string,
  kind: SearchKind,
  limit: number,
  page: number,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const all: { name: string; run: () => Promise<{ total: number; assets: Asset[] }> }[] = [];
  const params = { query, limit, page };

  if (kind === "image" || kind === "any") all.push({ name: "openverse:image", run: () => searchOpenverse(fetchImpl, "image", params) });
  if (kind === "audio" || kind === "any") all.push({ name: "openverse:audio", run: () => searchOpenverse(fetchImpl, "audio", params) });
  if (kind === "hdri" || kind === "texture" || kind === "model" || kind === "any") {
    const k = kind === "any" ? "all" : kind;
    all.push({ name: "polyhaven", run: () => searchPolyhaven(fetchImpl, k, params) });
    all.push({ name: "ambientcg", run: () => searchAmbientcg(fetchImpl, k, params) });
  }
  if (kind === "artwork" || kind === "any") {
    all.push({ name: "cleveland", run: () => searchCleveland(fetchImpl, params) });
    all.push({ name: "met", run: () => searchMet(fetchImpl, params) });
  }
  if (kind === "image" || kind === "audio" || kind === "video" || kind === "any") {
    // With "any", one combined query per provider keeps the request count down.
    const k = kind === "any" ? "all" : kind;
    all.push({ name: "commons", run: () => searchCommons(fetchImpl, k, params) });
    all.push({ name: "archive", run: () => searchArchive(fetchImpl, k, params) });
  }
  if (kind === "model" || kind === "any") all.push({ name: "sketchfab", run: () => searchSketchfab(fetchImpl, params) });
  if (kind === "image" || kind === "any") {
    all.push({ name: "wpphotos", run: () => searchWpPhotos(fetchImpl, params) });
    all.push({ name: "inaturalist", run: () => searchINaturalist(fetchImpl, params) });
    all.push({ name: "gbif", run: () => searchGbif(fetchImpl, params) });
    all.push({ name: "phylopic", run: () => searchPhylopic(fetchImpl, params) });
    all.push({ name: "iconify", run: () => searchIconify(fetchImpl, params) });
  }
  if (kind === "image" || kind === "video" || kind === "any") {
    const k = kind === "any" ? "all" : kind;
    all.push({ name: "zenodo", run: () => searchZenodo(fetchImpl, k, params) });
  }
  if (kind === "hdri" || kind === "texture" || kind === "model" || kind === "any") {
    const k = kind === "any" ? "all" : kind;
    all.push({ name: "blenderkit", run: () => searchBlenderkit(fetchImpl, k, params) });
  }
  // Collections only on request: GitHub allows 10 unauthenticated searches a minute.
  if (kind === "collection") {
    all.push({ name: "github", run: () => searchGithub(fetchImpl, params) });
    all.push({ name: "huggingface", run: () => searchHuggingface(fetchImpl, params) });
  }

  const skip = new Set<string>(options.skip ?? []);
  const only = options.providers?.length ? new Set<string>(options.providers) : null;
  const run = all.filter((j) => {
    const id = j.name.split(":")[0];
    return !skip.has(id) && (!only || only.has(id));
  });
  // Slots keep provider order, so the interleave is the same however the calls finish.
  const totals: Record<string, number> = {};
  const errorSlots: (string | undefined)[] = new Array(run.length);
  const listSlots: (Asset[] | undefined)[] = new Array(run.length);
  const snapshot = (): SearchResult => {
    const lists = listSlots.filter((l): l is Asset[] => !!l);
    const errors = errorSlots.filter((e): e is string => !!e);
    return { query, kind, page, assets: rank(query, interleave(lists)).slice(0, limit), totals: { ...totals }, errors };
  };
  let pending = run.length;
  await Promise.all(
    run.map(async (j, i) => {
      try {
        const r = await j.run();
        totals[j.name] = r.total;
        listSlots[i] = r.assets;
      } catch (e) {
        errorSlots[i] = `${j.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
      pending--;
      if (pending > 0) options.onProgress?.(snapshot(), pending);
    }),
  );
  return snapshot();
}

/** Words of two or more letters or digits, lowercased; works for any script. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

/** Drops a plural "s"/"es" so "footsteps" matches "footstep" and "boxes" matches "box". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set(["a", "an", "and", "the", "of", "for", "with", "in", "on", "to", "or"]);

/**
 * Share of the query's words found in the asset's title (weight 2) or tags
 * (weight 1), from 0 to 2. A word matches when an asset word starts with its
 * stem, so "sprite" matches "sprites" and "pixel" matches "pixelart".
 * Scripts without spaces (e.g. Korean "고양이") also match as substrings.
 */
export function relevance(query: string, asset: Pick<Asset, "title" | "tags">): number {
  const q = [...new Set(words(query).filter((w) => !STOPWORDS.has(w)).map(stem))];
  if (!q.length) return 0;
  const title = words(asset.title);
  const tags = words(asset.tags.join(" "));
  const hit = (list: string[], w: string) => list.some((t) => t.startsWith(w) || (w.length >= 2 && !/^[a-z0-9]+$/.test(w) && t.includes(w)));
  let score = 0;
  for (const w of q) score += hit(title, w) ? 2 : hit(tags, w) ? 1 : 0;
  return score / q.length;
}

/** Stable sort by relevance; ties keep the interleaved provider order. */
export function rank<T extends Pick<Asset, "title" | "tags">>(query: string, assets: T[]): T[] {
  return assets
    .map((a, i) => ({ a, i, s: relevance(query, a) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.a);
}

export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/**
 * Resolves ids produced by `search`: `openverse:image:<uuid>`, `openverse:audio:<uuid>`,
 * `polyhaven:<slug>`, `ambientcg:<assetId>`, `cleveland:<number>`, `met:<number>`,
 * `commons:<pageid>`, `archive:<identifier>`, `sketchfab:<uid>`, `wpphotos:<number>`,
 * `inaturalist:<number>`, `gbif:<number>`, `phylopic:<uuid>`, `iconify:<set>:<icon>`, `zenodo:<number>`,
 * `github:<owner>/<repo>`, `huggingface:<owner>/<dataset>`, `blenderkit:<uuid>`.
 */
export async function getAsset(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  const parts = id.split(":");
  const [provider, a, b] = parts;
  if (parts.length === 3 && provider === "openverse" && (a === "image" || a === "audio") && b) return getOpenverse(fetchImpl, a, b);
  if (parts.length === 3 && provider === "iconify" && a && b) return getIconify(fetchImpl, a, b);
  if (parts.length !== 2 || !a) return null;
  if (provider === "polyhaven") return getPolyhaven(fetchImpl, a);
  if (provider === "ambientcg") return getAmbientcg(fetchImpl, a);
  if (provider === "cleveland") return getCleveland(fetchImpl, a);
  if (provider === "met") return getMet(fetchImpl, a);
  if (provider === "commons") return getCommons(fetchImpl, a);
  if (provider === "archive") return getArchive(fetchImpl, a);
  if (provider === "sketchfab") return getSketchfab(fetchImpl, a);
  if (provider === "wpphotos") return getWpPhoto(fetchImpl, a);
  if (provider === "inaturalist") return getINaturalist(fetchImpl, a);
  if (provider === "gbif") return getGbif(fetchImpl, a);
  if (provider === "phylopic") return getPhylopic(fetchImpl, a);
  if (provider === "zenodo") return getZenodo(fetchImpl, a);
  if (provider === "github") return getGithub(fetchImpl, a);
  if (provider === "huggingface") return getHuggingface(fetchImpl, a);
  if (provider === "blenderkit") return getBlenderkit(fetchImpl, a);
  return null;
}

