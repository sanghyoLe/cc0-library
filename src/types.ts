/**
 * Shared shapes for every provider.
 *
 * An Asset is only ever produced after its provider has confirmed the CC0
 * status of that specific item. `licenseEvidence` records how that was
 * confirmed, so a caller can re-check it instead of trusting this library.
 */

export const ASSET_KINDS = ["image", "audio", "hdri", "texture", "model"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const CC0_LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/";

export interface LicenseEvidence {
  /** Always "CC0-1.0". Items that are not CC0 never become an Asset. */
  license: "CC0-1.0";
  licenseUrl: string;
  /** How CC0 status was confirmed for this item. */
  method: "per-item-license-field" | "whole-library-cc0";
  /** The field or policy page the confirmation came from. */
  source: string;
}

export interface Asset {
  /** Stable id understood by `getAsset`, e.g. `polyhaven:brown_planks_03`. */
  id: string;
  kind: AssetKind;
  title: string;
  creator: string | null;
  /** Human-facing page for the item at its origin. */
  landingUrl: string;
  /** Direct file or preview URL, when the provider exposes one. */
  fileUrl: string | null;
  thumbnailUrl: string | null;
  tags: string[];
  provider: "openverse" | "polyhaven";
  /** Upstream site the item originally came from (e.g. flickr, freesound). */
  origin: string;
  licenseEvidence: LicenseEvidence;
  /** Credit line for the API that served the item (required by its terms). */
  servedBy: string;
}

export interface AssetFile {
  label: string;
  url: string;
  sizeBytes: number | null;
}

export interface AssetDetail extends Asset {
  description: string | null;
  files: AssetFile[];
}

export interface SearchParams {
  query: string;
  limit: number;
  page: number;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;
