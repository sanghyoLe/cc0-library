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
  excluded: { name: string; reason: string }[];
  pending: { name: string; reason: string }[];
}

const CATALOG_PATH = fileURLToPath(new URL("../catalog/sources.json", import.meta.url));

export function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}
