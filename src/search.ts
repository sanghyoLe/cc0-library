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
import type { Asset, AssetDetail, AssetKind, FetchLike, ProviderId } from "./types.js";

export type SearchKind = AssetKind | "any";

export interface SearchOptions {
  /**
   * Providers to leave out. The browser gallery skips ambientCG, whose API
   * sends no CORS headers.
   */
  skip?: ProviderId[];
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
 * Runs one search across the providers that serve `kind`. With kind "any",
 * results from each provider are interleaved so one provider cannot crowd
 * out the others.
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

  const skip = new Set<string>(options.skip ?? []);
  const run = all.filter((j) => !skip.has(j.name.split(":")[0]));
  const settled = await Promise.allSettled(run.map((j) => j.run()));
  const totals: Record<string, number> = {};
  const errors: string[] = [];
  const lists: Asset[][] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      totals[run[i].name] = s.value.total;
      lists.push(s.value.assets);
    } else {
      errors.push(`${run[i].name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    }
  });

  return { query, kind, page, assets: interleave(lists).slice(0, limit), totals, errors };
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
 * `commons:<pageid>`, `archive:<identifier>`, `sketchfab:<uid>`.
 */
export async function getAsset(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  const parts = id.split(":");
  const [provider, a, b] = parts;
  if (parts.length === 3 && provider === "openverse" && (a === "image" || a === "audio") && b) return getOpenverse(fetchImpl, a, b);
  if (parts.length !== 2 || !a) return null;
  if (provider === "polyhaven") return getPolyhaven(fetchImpl, a);
  if (provider === "ambientcg") return getAmbientcg(fetchImpl, a);
  if (provider === "cleveland") return getCleveland(fetchImpl, a);
  if (provider === "met") return getMet(fetchImpl, a);
  if (provider === "commons") return getCommons(fetchImpl, a);
  if (provider === "archive") return getArchive(fetchImpl, a);
  if (provider === "sketchfab") return getSketchfab(fetchImpl, a);
  return null;
}

