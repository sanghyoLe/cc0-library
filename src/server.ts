import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DownloadRequestError, MAX_FILES_PER_CALL, RECEIPT_NAME, downloadAsset, type DownloadLike } from "./download.js";
import { defaultDownload, defaultFetch } from "./http.js";
import { getAsset, loadCatalog, search } from "./library.js";
import { ASSET_KINDS, CATALOG_KINDS, PROVIDER_IDS, type FetchLike } from "./types.js";

/** One slow source (The Met can take 30 s) must not hold every reply; it is reported in `pending`. */
const SEARCH_DEADLINE_MS = 10_000;

/** Poly Haven textures can list 100+ map/resolution/format files; keep replies readable. */
const MAX_FILES_IN_REPLY = 60;

const KIND_HELP =
  "Asset type. image: Openverse, Wikimedia Commons, Internet Archive, WordPress Photo Directory, iNaturalist and GBIF " +
  "(nature photos), PhyloPic (organism silhouettes; search by taxon name), Iconify (CC0 icon sets), Zenodo (research figures). " +
  "audio: Openverse, Commons, Internet Archive. video: Commons, Internet Archive, Zenodo. " +
  "hdri, texture: Poly Haven, ambientCG, BlenderKit. model: Poly Haven, ambientCG, Sketchfab, BlenderKit. " +
  "artwork: public-domain works from the Cleveland Museum of Art and The Met. " +
  "collection: whole CC0 GitHub repositories and Hugging Face datasets (only when asked for; not part of 'any'). " +
  "any (default): every kind except collection, interleaved.";

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
  riskFlags: z
    .array(z.string())
    .optional()
    .describe(
      "Present only on uploader-declared items whose title or tags name a known franchise, character or brand, or say the work is fan-made or copied " +
        "(e.g. 'franchise-name: star wars'). CC0 from an uploader does not clear the franchise owner's rights: tell the user before suggesting it. " +
        "Absence does not mean the item is safe",
    ),
};

const fileSchema = z.object({
  label: z.string().describe("Variant, e.g. '2K-JPG (zip)', 'hdri / 4k / exr', 'primary'"),
  url: z.string().describe("Direct download URL (Sketchfab: model page, login required)"),
  sizeBytes: z.number().nullable().describe("File size in bytes when the source reports it"),
  includes: z
    .array(z.object({ path: z.string(), url: z.string(), sizeBytes: z.number().nullable() }))
    .optional()
    .describe("Companion files (a glTF's .bin and textures). Save each at `path` relative to the main file, or the main file will not open"),
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
  pending: z
    .array(z.string())
    .describe(`Sources that had not answered within ${SEARCH_DEADLINE_MS / 1000} s and were left out; search again (or narrow with providers) to include them`),
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
        kinds: z.array(z.enum(CATALOG_KINDS)),
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

const savedFileSchema = z.object({
  label: z.string().describe("File label from get_asset; companions read '<main label> + <path>'"),
  path: z.string().describe("Path relative to `folder`"),
  url: z.string().describe("Where it was downloaded from"),
  bytes: z.number(),
  sha256: z.string(),
});

const downloadOutput = {
  folder: z.string().describe("Absolute path of the folder created for this asset"),
  saved: z.array(savedFileSchema).describe("Files written, including each model's companion files at their relative paths"),
  skipped: z
    .array(z.object({ label: z.string(), url: z.string(), reason: z.string() }))
    .describe("Files not saved and why, e.g. a page that needs the user's login; tell the user and give them landingUrl"),
  receipt: z.string().describe(`Absolute path of ${RECEIPT_NAME}: id, title, creator, source URLs, license evidence, riskFlags and download time`),
};

export function createServer(fetchImpl: FetchLike = defaultFetch, downloadImpl: DownloadLike = defaultDownload): McpServer {
  const server = new McpServer({ name: "cc0-library", version: "0.2.13" });

  server.registerTool(
    "search_assets",
    {
      title: "Search CC0 assets across 17 sources",
      description:
        "Find CC0 1.0 (public-domain dedication) images, audio, video, HDRIs, textures, 3D models and museum artworks by keyword, " +
        "returning only items whose CC0 status was checked. " +
        "Use it first to discover candidates; then call get_asset for download files and a fresh license re-check. " +
        "Use list_sources instead to answer which sites are CC0. Do not use it for CC BY, CC BY-SA or other 'free' licenses: they are filtered out. " +
        `Behavior: read-only, no API key, live HTTPS calls to each source; replies within ${SEARCH_DEADLINE_MS / 1000} s. ` +
        "A failing source is listed in `errors` and a source still running at the deadline in `pending`, while the others still return. " +
        "Results from uploader-driven sites (Openverse, Commons, Internet Archive, Sketchfab, WordPress Photo Directory, iNaturalist, PhyloPic, Zenodo, BlenderKit, GitHub, Hugging Face) carry licenseEvidence.declaredBy='uploader': " +
        "tell the user to confirm the uploader owns the work; items with riskFlags name a franchise or brand and need that warning most. " +
        "Show each item's servedBy credit with the results.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Keywords in any language, matched against titles and tags, e.g. 'rainy street' or 'brick wall'"),
        kind: z.enum([...ASSET_KINDS, "any"]).default("any").describe(KIND_HELP),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Maximum results to return, 1-20. Results are ranked by how many query words appear in the title or tags; ties alternate between sources"),
        page: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(1)
          .describe("1-based page; each source paginates independently. Request page 2+ only if `totals` shows more matches"),
        providers: z
          .array(z.enum(PROVIDER_IDS))
          .min(1)
          .max(PROVIDER_IDS.length)
          .optional()
          .describe(
            "Search only these sources. Leave out to search every source for `kind`. Useful picks: ['iconify'] for icons, " +
              "['polyhaven','ambientcg'] for studio-made textures and HDRIs, ['inaturalist','gbif'] for wildlife and specimens, " +
              "['cleveland','met'] for museum art, ['openverse'] for sound effects",
          ),
      },
      outputSchema: searchOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, kind, limit, page, providers }) => result(await search(fetchImpl, query, kind, limit, page, { providers, deadlineMs: SEARCH_DEADLINE_MS })),
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
              "ambientcg:<assetId>, cleveland:<number>, met:<number>, commons:<pageid>, archive:<identifier>, sketchfab:<uid>, wpphotos:<number>, " +
              "inaturalist:<number>, gbif:<number>, phylopic:<uuid>, iconify:<set>:<icon>, zenodo:<number>, github:<owner>/<repo>, " +
              "huggingface:<owner>/<dataset> or blenderkit:<uuid>",
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
    "download_asset",
    {
      title: "Download a CC0 asset with a license receipt",
      description:
        "Save chosen files of one asset to a local folder, re-checking at the source that it is still CC0 first. " +
        "Creates <dir>/<asset id>/, saves each file there with its companions (a glTF's .bin and textures) at the relative paths the main file expects, " +
        `and writes ${RECEIPT_NAME} recording the source, creator, license evidence, riskFlags and download time, so the project keeps proof of where the asset came from. ` +
        "Use it after search_assets (and get_asset when the asset has several files, to read their labels) when the user wants the asset in their project; " +
        "use get_asset instead when they only want links. " +
        "Pages that need the user's login (Sketchfab, BlenderKit, Freesound originals) are not downloaded and come back in `skipped`. " +
        "Zip packs (ambientCG) are saved as-is, not extracted. " +
        "Behavior: writes files under `dir` only, overwriting same-named files from an earlier download of the same asset; live HTTPS downloads, up to 1 GB per file.",
      inputSchema: {
        id: z.string().min(1).max(120).describe("Asset id exactly as returned by search_assets"),
        dir: z
          .string()
          .min(1)
          .max(1024)
          .describe("Folder to save into, normally inside the user's project (e.g. 'assets/cc0'). A subfolder named after the asset id is created. Relative paths resolve against the server's working directory"),
        files: z
          .array(z.string().min(1).max(200))
          .min(1)
          .max(MAX_FILES_PER_CALL)
          .optional()
          .describe(
            "Exact file labels from get_asset, e.g. ['gltf / 1k / gltf'] or ['1K-JPG (zip)']. Leave out only when the asset has a single file; " +
              "otherwise the call fails and lists the labels",
          ),
      },
      outputSchema: downloadOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, dir, files }) => {
      const asset = await getAsset(fetchImpl, id);
      if (!asset) return fail(`No CC0 asset found for id "${id}". The id may be malformed, removed upstream, or no longer CC0.`);
      try {
        return result(await downloadAsset(downloadImpl, asset, dir, files));
      } catch (e) {
        if (e instanceof DownloadRequestError) return fail(e.message);
        throw e;
      }
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
          .enum([...CATALOG_KINDS, "any"])
          .default("any")
          .describe("Keep only sources offering this asset type ('font' is catalog-only); 'any' (default) returns all. Does not filter the notCc0 and pending lists"),
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
