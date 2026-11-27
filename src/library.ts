import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CatalogKind } from "./types.js";

export { search, getAsset, interleave, rank, relevance, type SearchKind, type SearchResult, type SearchOptions } from "./search.js";

export interface CatalogSource {
  id: string;
  name: string;
  url: string;
  kinds: CatalogKind[];
  scope: "whole-library" | "filter-only";
  searchable: boolean;
  licensePage: string;
  notes: string;
  verified: { date: string; evidence: string };
}

export interface Catalog {
  sources: CatalogSource[];
  excluded: { name: string; url: string; reason: string }[];
  pending: { name: string; url: string; reason: string }[];
}

const CATALOG_PATH = fileURLToPath(new URL("../catalog/sources.json", import.meta.url));

export function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}

export interface CatalogPage {
  sources: CatalogSource[];
  notCc0: Catalog["excluded"];
  pendingVerification: Catalog["pending"];
  /** Matches per list before paging, so a caller can tell whether another page exists. */
  totals: { sources: number; notCc0: number; pendingVerification: number };
}

/**
 * One page of the catalog. The whole catalog is several hundred kilobytes of
 * JSON, more than an MCP client accepts in one reply, so each of the three
 * lists is cut to `limit` entries and `totals` reports the full match counts.
 * `query` keeps entries whose id, name, URL, notes or reason contain every
 * query word (case-insensitive substring). `kind` applies to `sources` only:
 * the other two lists record no kinds.
 */
export function listSources(
  catalog: Catalog,
  { kind = "any", query = "", limit, page = 1 }: { kind?: CatalogKind | "any"; query?: string; limit: number; page?: number },
): CatalogPage {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...fields: (string | undefined)[]) => {
    const text = fields.join("\n").toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const sources = catalog.sources.filter((s) => (kind === "any" || s.kinds.includes(kind)) && matches(s.id, s.name, s.url, s.notes));
  const notCc0 = catalog.excluded.filter((s) => matches(s.name, s.url, s.reason));
  const pending = catalog.pending.filter((s) => matches(s.name, s.url, s.reason));
  const cut = <T>(list: T[]) => list.slice((page - 1) * limit, page * limit);
  return {
    sources: cut(sources),
    notCc0: cut(notCc0),
    pendingVerification: cut(pending),
    totals: { sources: sources.length, notCc0: notCc0.length, pendingVerification: pending.length },
  };
}
