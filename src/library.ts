import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOpenverse, searchOpenverse } from "./providers/openverse.js";
import { getPolyhaven, searchPolyhaven } from "./providers/polyhaven.js";
import type { Asset, AssetDetail, AssetKind, FetchLike } from "./types.js";

export type SearchKind = AssetKind | "any";

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
 * out the other.
 */
export async function search(
  fetchImpl: FetchLike,
  query: string,
  kind: SearchKind,
  limit: number,
  page: number,
): Promise<SearchResult> {
  const jobs: { name: string; run: () => Promise<{ total: number; assets: Asset[] }> }[] = [];
  const params = { query, limit, page };

  if (kind === "image" || kind === "any") jobs.push({ name: "openverse:image", run: () => searchOpenverse(fetchImpl, "image", params) });
  if (kind === "audio" || kind === "any") jobs.push({ name: "openverse:audio", run: () => searchOpenverse(fetchImpl, "audio", params) });
  if (kind === "hdri" || kind === "texture" || kind === "model") {
    jobs.push({ name: "polyhaven", run: () => searchPolyhaven(fetchImpl, kind, params) });
  } else if (kind === "any") {
    jobs.push({ name: "polyhaven", run: () => searchPolyhaven(fetchImpl, "all", params) });
  }

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const totals: Record<string, number> = {};
  const errors: string[] = [];
  const lists: Asset[][] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      totals[jobs[i].name] = s.value.total;
      lists.push(s.value.assets);
    } else {
      errors.push(`${jobs[i].name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
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

/** Resolves ids produced by `search`: `openverse:image:<uuid>`, `openverse:audio:<uuid>`, `polyhaven:<slug>`. */
export async function getAsset(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  const [provider, a, b] = id.split(":");
  if (provider === "polyhaven" && a && b === undefined) return getPolyhaven(fetchImpl, a);
  if (provider === "openverse" && (a === "image" || a === "audio") && b) return getOpenverse(fetchImpl, a, b);
  return null;
}

export interface CatalogSource {
  id: string;
  name: string;
  url: string;
  kinds: AssetKind[];
  scope: "whole-library" | "filter-only";
  searchable: boolean;
  licensePage: string;
  notes: string;
  verified: { date: string; evidence: string };
}

export interface Catalog {
  sources: CatalogSource[];
  excluded: { name: string; reason: string }[];
}

const CATALOG_PATH = fileURLToPath(new URL("../catalog/sources.json", import.meta.url));

export function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}
