import { getJson } from "../http.js";
import { CC0_LICENSE_URL, type Asset, type AssetDetail, type FetchLike, type SearchParams } from "../types.js";

/**
 * Asset collections: whole repositories and datasets released under CC0.
 *
 * - GitHub (https://api.github.com, no key; 10 searches/minute unauthenticated):
 *   repositories whose detected license is CC0-1.0. A repository's README can
 *   still license some contents differently, so results carry declaredBy
 *   "uploader" and the description says to check the README.
 * - Hugging Face datasets (https://huggingface.co/api, no key): datasets tagged
 *   license:cc0-1.0 by their uploaders.
 */

const GH = "https://api.github.com";
const HF = "https://huggingface.co/api/datasets";

interface Repo {
  full_name: string;
  html_url: string;
  description: string | null;
  owner?: { login?: string; avatar_url?: string };
  license?: { spdx_id?: string } | null;
  topics?: string[];
  stargazers_count?: number;
  default_branch?: string;
}

interface Dataset {
  id: string;
  author?: string;
  tags?: string[];
  downloads?: number;
  description?: string;
  cardData?: { pretty_name?: string };
}

/** owner/name; each part starts with a letter or digit, so ".." path segments are rejected. */
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const repoIsCc0 = (r: Repo) => r.license?.spdx_id === "CC0-1.0";
const datasetIsCc0 = (d: Dataset) => (d.tags ?? []).includes("license:cc0-1.0");

export function repoToAsset(r: Repo): Asset {
  return {
    id: `github:${r.full_name}`,
    kind: "collection",
    title: r.full_name,
    creator: r.owner?.login ?? null,
    landingUrl: r.html_url,
    fileUrl: `${r.html_url}/archive/refs/heads/${r.default_branch ?? "main"}.zip`,
    thumbnailUrl: `https://opengraph.githubassets.com/1/${r.full_name}`,
    tags: (r.topics ?? []).slice(0, 20),
    provider: "github",
    origin: "github.com",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `GitHub detected license CC0-1.0 for ${r.full_name} (${GH}/repos/${r.full_name}); check the README for contents under other licenses`,
      declaredBy: "uploader",
    },
    servedBy: "Via GitHub (https://github.com)",
  };
}

export function datasetToAsset(d: Dataset): Asset {
  const modalities = (d.tags ?? []).filter((t) => t.startsWith("modality:")).map((t) => t.slice(9));
  return {
    id: `huggingface:${d.id}`,
    kind: "collection",
    title: d.cardData?.pretty_name ?? d.id,
    creator: d.author ?? d.id.split("/")[0] ?? null,
    landingUrl: `https://huggingface.co/datasets/${d.id}`,
    fileUrl: null,
    thumbnailUrl: null,
    tags: modalities,
    provider: "huggingface",
    origin: "huggingface.co",
    licenseEvidence: {
      license: "CC0-1.0",
      licenseUrl: CC0_LICENSE_URL,
      method: "per-item-license-field",
      source: `Hugging Face dataset tag license:cc0-1.0 (${HF}/${d.id})`,
      declaredBy: "uploader",
    },
    servedBy: "Via Hugging Face (https://huggingface.co)",
  };
}

/** Keeps letters, digits and spaces so user text cannot add GitHub search qualifiers. */
const plainWords = (q: string) => q.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export async function searchGithub(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const words = plainWords(params.query);
  if (!words) return { total: 0, assets: [] };
  const qs = new URLSearchParams({ q: `${words} license:cc0-1.0`, sort: "stars", per_page: String(params.limit), page: String(params.page) });
  const data = await getJson<{ total_count: number; items: Repo[] }>(fetchImpl, "GitHub", `${GH}/search/repositories?${qs}`, {
    Accept: "application/vnd.github+json",
  });
  return { total: data.total_count, assets: data.items.filter(repoIsCc0).map(repoToAsset) };
}

export async function getGithub(fetchImpl: FetchLike, fullName: string): Promise<AssetDetail | null> {
  if (!OWNER_NAME.test(fullName)) return null;
  const r = await getJson<Repo>(fetchImpl, "GitHub", `${GH}/repos/${fullName}`, { Accept: "application/vnd.github+json" });
  if (!repoIsCc0(r)) return null;
  const asset = repoToAsset(r);
  return { ...asset, description: r.description, files: [{ label: "repository ZIP", url: asset.fileUrl!, sizeBytes: null }] };
}

export async function searchHuggingface(fetchImpl: FetchLike, params: SearchParams): Promise<{ total: number; assets: Asset[] }> {
  const words = plainWords(params.query);
  if (!words) return { total: 0, assets: [] };
  // The Hub API pages with cursors; fetch enough for the requested page and slice.
  const want = params.limit * params.page;
  const qs = new URLSearchParams({ search: words, filter: "license:cc0-1.0", sort: "downloads", limit: String(want), full: "true" });
  const data = await getJson<Dataset[]>(fetchImpl, "Hugging Face", `${HF}?${qs}`);
  const page = data.filter(datasetIsCc0).slice((params.page - 1) * params.limit, want);
  return { total: data.length, assets: page.map(datasetToAsset) };
}

export async function getHuggingface(fetchImpl: FetchLike, id: string): Promise<AssetDetail | null> {
  if (!OWNER_NAME.test(id)) return null;
  const d = await getJson<Dataset>(fetchImpl, "Hugging Face", `${HF}/${id}`);
  if (!datasetIsCc0(d)) return null;
  return {
    ...datasetToAsset(d),
    description: d.description?.replace(/\s+/g, " ").trim().slice(0, 500) || null,
    files: [{ label: "dataset files on Hugging Face", url: `https://huggingface.co/datasets/${id}/tree/main`, sizeBytes: null }],
  };
}
