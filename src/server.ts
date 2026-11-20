import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultFetch } from "./http.js";
import { getAsset, loadCatalog, search } from "./library.js";
import { ASSET_KINDS, PROVIDER_IDS, type FetchLike } from "./types.js";

/** Poly Haven textures can list 100+ map/resolution/format files; keep replies readable. */
const MAX_FILES_IN_REPLY = 60;

const KIND_HELP =
  "Asset type. image, audio, video: Openverse, Wikimedia Commons, Internet Archive (image also: WordPress Photo Directory). " +
  "hdri, texture: Poly Haven, ambientCG. model: Poly Haven, ambientCG, Sketchfab. " +
  "artwork: photos of public-domain works from the Cleveland Museum of Art and The Met. " +
  "any (default): all of the above, interleaved.";

// ---------- output schemas: every returned field is documented here ----------

const licenseEvidenceSchema = z
  .object({
    license: z.literal("CC0-1.0").describe("Always CC0-1.0; non-CC0 items are never returned"),
    licenseUrl: z.string().describe("CC0 1.0 deed URL"),
    method: z
      .enum(["per-item-license-field", "whole-library-cc0"])
      .describe("per-item-license-field: the item's own record says CC0; whole-library-cc0: the site publishes everything as CC0"),
    source: z.string().describe("The exact field or policy page the check used, with its URL"),
    declaredBy: z
      .enum(["library", "institution", "uploader"])
      .describe(
        "Who declared CC0. library = the studio that made it; institution = the museum holding the work; " +
          "uploader = a site user, unreviewed and sometimes wrong (warn the user to verify ownership)",
      ),
  })
  .describe("How CC0 status was verified for this item");

const assetShape = {
  id: z.string().describe("Stable id to pass to get_asset, e.g. 'polyhaven:brown_planks_03' or 'met:436535'"),
  kind: z.enum(ASSET_KINDS).describe("Asset type"),
  title: z.string().describe("Title at the source"),
  creator: z.string().nullable().describe("Creator or uploader name, null if the source gives none"),
  landingUrl: z.string().describe("Human-facing page at the source; link this when showing the item"),
  fileUrl: z.string().nullable().describe("Direct file or preview URL when the search response includes one; use get_asset for all files"),
  thumbnailUrl: z.string().nullable().describe("Small preview image URL, null for audio and some items"),
  tags: z.array(z.string()).describe("Up to 20 source tags or categories"),
  provider: z.enum(PROVIDER_IDS).describe("API that served the item"),
  origin: z.string().describe("Site the item originally came from (e.g. flickr, freesound, metmuseum.org)"),
  licenseEvidence: licenseEvidenceSchema,
  servedBy: z.string().describe("Credit line required by the serving API's terms; show it next to results"),
};

const fileSchema = z.object({
  label: z.string().describe("Variant, e.g. '2K-JPG (zip)', 'hdri / 4k / exr', 'primary'"),
  url: z.string().describe("Direct download URL (Sketchfab: model page, login required)"),
  sizeBytes: z.number().nullable().describe("File size in bytes when the source reports it"),
});

const nameReason = z.object({
  name: z.string(),
  url: z.string().describe("Site URL"),
  reason: z.string().describe("Why it is listed here"),
});

const searchOutput = {
  query: z.string().describe("Query as received"),
  kind: z.enum([...ASSET_KINDS, "any"]).describe("Kind as received"),
  page: z.number().describe("Page as received"),
  assets: z.array(z.object(assetShape)).describe("CC0 results, at most `limit`; may be fewer when sources drop non-CC0 items"),
  totals: z.record(z.string(), z.number()).describe("Upstream match count per source job (before CC0 re-checks); useful to decide whether to page"),
  errors: z.array(z.string()).describe("Sources that failed this time, e.g. 'met: The Met returned HTTP 503'; other sources still returned results"),
};

const getOutput = {
  ...assetShape,
  description: z.string().nullable().describe("Source description or credit line, if any"),
  files: z.array(fileSchema).describe(`Downloadable files, at most ${MAX_FILES_IN_REPLY}; empty when the source offers none`),
  filesNote: z.string().optional().describe("Present when files were truncated"),
};

const listOutput = {
  sources: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        url: z.string().describe("Where to browse the source"),
        kinds: z.array(z.enum(ASSET_KINDS)),
        scope: z.enum(["whole-library", "filter-only"]).describe("whole-library: everything is CC0; filter-only: only CC0-labeled items qualify"),
        searchable: z.boolean().describe("true if search_assets queries this source"),
        licensePage: z.string(),
        notes: z.string(),
        verified: z.object({ date: z.string().describe("YYYY-MM-DD"), evidence: z.string().describe("Text or field that was checked") }),
      }),
    )
    .describe("Verified CC0 sources"),
  notCc0: z.array(nameReason).describe("Popular 'free' sites that are NOT CC0"),
  pendingVerification: z.array(nameReason).describe("Candidates whose license could not be verified yet"),
};

const result = (value: object) => ({
  structuredContent: value as Record<string, unknown>,
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

export function createServer(fetchImpl: FetchLike = defaultFetch): McpServer {
  const server = new McpServer({ name: "cc0-library", version: "0.1.2" });

  server.registerTool(
    "search_assets",
    {
      title: "Search CC0 assets across 9 sources",
      description:
        "Find CC0 1.0 (public-domain dedication) images, audio, video, HDRIs, textures, 3D models and museum artworks by keyword, " +
        "returning only items whose CC0 status was checked. " +
        "Use it first to discover candidates; then call get_asset for download files and a fresh license re-check. " +
        "Use list_sources instead to answer which sites are CC0. Do not use it for CC BY, CC BY-SA or other 'free' licenses: they are filtered out. " +
        "Behavior: read-only, no API key, live HTTPS calls to each source (usually 2-10 s). A failing source is listed in `errors` while the others still return. " +
        "Results from uploader-driven sites (Openverse, Commons, Internet Archive, Sketchfab, WordPress Photo Directory) carry licenseEvidence.declaredBy='uploader': " +
        "tell the user to confirm the uploader owns the work. Show each item's servedBy credit with the results.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Keywords in any language, matched against titles and tags, e.g. 'rainy street' or 'brick wall'"),
        kind: z.enum([...ASSET_KINDS, "any"]).default("any").describe(KIND_HELP),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Maximum results to return, 1-20. With kind 'any' the sources are interleaved, so each contributes a few"),
        page: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(1)
          .describe("1-based page; each source paginates independently. Request page 2+ only if `totals` shows more matches"),
      },
      outputSchema: searchOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, kind, limit, page }) => result(await search(fetchImpl, query, kind, limit, page)),
  );

  server.registerTool(
    "get_asset",
    {
      title: "Get one CC0 asset with download files",
      description:
        "Fetch one asset's details and download files by an id from search_assets, re-checking at the source that it is still CC0. " +
        "Use it after search_assets when the user wants to download or inspect an item; it cannot search, so call search_assets first if you have no id. " +
        "Returns an error (do not retry the same id) when the id is malformed, the item was removed, or the source no longer reports CC0. " +
        "Behavior: read-only, no API key, one or two live HTTPS calls. Poly Haven lists up to 60 resolution/format variants; " +
        "ambientCG returns zip packs; Sketchfab returns only the model page because its downloads need the user's own login.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(120)
          .describe(
            "Asset id exactly as returned by search_assets: openverse:image:<uuid>, openverse:audio:<uuid>, polyhaven:<slug>, " +
              "ambientcg:<assetId>, cleveland:<number>, met:<number>, commons:<pageid>, archive:<identifier>, sketchfab:<uid> or wpphotos:<number>",
          ),
      },
      outputSchema: getOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const asset = await getAsset(fetchImpl, id);
      if (!asset) return fail(`No CC0 asset found for id "${id}". The id may be malformed, removed upstream, or no longer CC0.`);
      const truncated = asset.files.length > MAX_FILES_IN_REPLY;
      return result({
        ...asset,
        files: asset.files.slice(0, MAX_FILES_IN_REPLY),
        ...(truncated && { filesNote: `${asset.files.length - MAX_FILES_IN_REPLY} more files omitted; see landingUrl.` }),
      });
    },
  );

  server.registerTool(
    "list_sources",
    {
      title: "List verified CC0 source sites",
      description:
        "List the curated catalog of CC0 asset sites, each with its license page, scope and dated evidence, " +
        "plus popular 'free' sites that are NOT CC0 (e.g. Unsplash, Pixabay) and candidates still pending verification. " +
        "Use it to answer 'is site X CC0?' or to suggest sites to browse by hand; use search_assets instead to find actual assets. " +
        "Behavior: reads a bundled JSON file, so no network access, instant and deterministic.",
      inputSchema: {
        kind: z
          .enum([...ASSET_KINDS, "any"])
          .default("any")
          .describe("Keep only sources offering this asset type; 'any' (default) returns all. Does not filter the notCc0 and pending lists"),
      },
      outputSchema: listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ kind }) => {
      const catalog = loadCatalog();
      const sources = kind === "any" ? catalog.sources : catalog.sources.filter((s) => s.kinds.includes(kind));
      return result({ sources, notCc0: catalog.excluded, pendingVerification: catalog.pending });
    },
  );

  return server;
}
