import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultFetch } from "./http.js";
import { getAsset, loadCatalog, search } from "./library.js";
import { ASSET_KINDS, type FetchLike } from "./types.js";

/** Poly Haven textures can list 100+ map/resolution/format files; keep replies readable. */
const MAX_FILES_IN_REPLY = 60;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createServer(fetchImpl: FetchLike = defaultFetch): McpServer {
  const server = new McpServer({ name: "cc0-library", version: "0.1.0" });

  server.registerTool(
    "search_assets",
    {
      title: "Search CC0 assets",
      description:
        "Search CC0-only images, audio, video, HDRIs, textures, 3D models and museum artworks. Every result was checked as " +
        "CC0 1.0 (public domain dedication) and carries licenseEvidence. Sources: Openverse, Wikimedia Commons and " +
        "Internet Archive (image, audio, video), Poly Haven and ambientCG (hdri, texture, model), Sketchfab (model), " +
        "Cleveland Museum of Art and The Met (artwork). " +
        "licenseEvidence.declaredBy says who declared CC0: 'library' or 'institution' (the rights holder) or " +
        "'uploader' (a site user; not reviewed, can be wrong). Tell people to check uploader-declared items. " +
        "Include each result's servedBy credit when showing results to people.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Search words, e.g. 'rainy street' or 'brick wall'"),
        kind: z.enum([...ASSET_KINDS, "any"]).default("any").describe("Asset type to search"),
        limit: z.number().int().min(1).max(20).default(10).describe("Max results (1-20)"),
        page: z.number().int().min(1).max(12).default(1).describe("Result page, starting at 1"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, kind, limit, page }) => json(await search(fetchImpl, query, kind, limit, page)),
  );

  server.registerTool(
    "get_asset",
    {
      title: "Get CC0 asset details",
      description:
        "Get details and download URLs for one asset id returned by search_assets " +
        "(formats: 'openverse:image:<uuid>', 'openverse:audio:<uuid>', 'polyhaven:<slug>', " +
        "'ambientcg:<assetId>', 'cleveland:<number>', 'met:<number>', 'commons:<pageid>', 'archive:<identifier>', " +
        "'sketchfab:<uid>'). Sketchfab returns the model page only: its downloads need the user's own login. " +
        "Re-checks the CC0 status at the source before returning.",
      inputSchema: { id: z.string().min(1).max(120).describe("Asset id from search_assets") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const asset = await getAsset(fetchImpl, id);
      if (!asset) return fail(`No CC0 asset found for id "${id}". The id may be malformed, removed upstream, or no longer CC0.`);
      const truncated = asset.files.length > MAX_FILES_IN_REPLY;
      return json({
        ...asset,
        files: asset.files.slice(0, MAX_FILES_IN_REPLY),
        ...(truncated && { filesNote: `${asset.files.length - MAX_FILES_IN_REPLY} more files omitted; see landingUrl.` }),
      });
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List curated CC0 sources",
      description:
        "List the curated catalog of CC0 asset sources, with license evidence and the date each was verified. " +
        "Also lists popular 'free' sources that are NOT CC0 and why, and candidates still pending verification.",
      inputSchema: {
        kind: z.enum([...ASSET_KINDS, "any"]).default("any").describe("Only sources offering this asset type"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind }) => {
      const catalog = loadCatalog();
      const sources = kind === "any" ? catalog.sources : catalog.sources.filter((s) => s.kinds.includes(kind));
      return json({ sources, notCc0: catalog.excluded, pendingVerification: catalog.pending });
    },
  );

  return server;
}
