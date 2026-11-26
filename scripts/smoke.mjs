// End-to-end check against the live APIs: starts dist/index.js over stdio
// and calls every tool through a real MCP client. Needs network access.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "cc0-library-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content[0].text}`);
  if (!r.structuredContent) throw new Error(`${name} returned no structuredContent`);
  return r.structuredContent;
};
const check = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

const toolDefs = (await client.listTools()).tools;
const tools = toolDefs.map((t) => t.name).sort();
check(tools.join() === "download_asset,get_asset,list_sources,search_assets", `tools listed: ${tools}`);
// Glama's TDQS rewards documented outputs and declared annotations; keep them on every tool.
check(toolDefs.every((t) => t.outputSchema?.properties && typeof t.annotations?.readOnlyHint === "boolean" && t.title && t.description.length > 200),
  "every tool has outputSchema, readOnly annotation, title and a full description");
check(toolDefs.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name).join() === "download_asset", "only download_asset writes");

const QUERIES = { image: "cat", audio: "rain", video: "forest", hdri: "sunset", texture: "brick", model: "chair", artwork: "cat" };
const seenProviders = new Map();
for (const [kind, q] of Object.entries(QUERIES)) {
  const r = await call("search_assets", { query: q, kind, limit: 20 });
  check(r.assets.length > 0 && r.errors.length === 0, `search ${kind} "${q}" -> ${r.assets.length} results, errors=${JSON.stringify(r.errors)}`);
  check(r.assets.every((a) => a.licenseEvidence.license === "CC0-1.0"), `${kind} results all carry CC0 evidence`);
  for (const a of r.assets) if (!seenProviders.has(a.provider)) seenProviders.set(a.provider, a.id);
}
// Providers whose results depend on specific words get a targeted query, restricted
// to that provider so the check does not depend on how the mixed results rank.
const TARGETED = [
  ["fox", "image", "inaturalist"], ["fox", "image", "gbif"], ["cat", "image", "wpphotos"], ["vulpes", "image", "phylopic"], ["heart", "image", "iconify"],
  ["bird", "image", "zenodo"], ["chair", "model", "blenderkit"], ["sprites", "collection", "github"], ["pixel", "collection", "huggingface"],
];
for (const [q, kind, provider] of TARGETED) {
  const r = await call("search_assets", { query: q, kind, limit: 20, providers: [provider] });
  const hit = r.assets.find((a) => a.provider === provider);
  check(!!hit && r.assets.every((a) => a.provider === provider), `search ${kind} "${q}" with providers=[${provider}] -> ${provider} only${hit ? ` (${hit.id})` : ""}`);
  if (hit && !seenProviders.has(provider)) seenProviders.set(provider, hit.id);
}
const ALL = ["openverse", "polyhaven", "ambientcg", "cleveland", "met", "commons", "archive", "sketchfab", "wpphotos",
  "inaturalist", "gbif", "phylopic", "iconify", "zenodo", "blenderkit", "github", "huggingface"];
check(ALL.every((p) => seenProviders.has(p)), `all ${ALL.length} providers returned results: ${[...seenProviders.keys()]}`);
for (const [provider, id] of seenProviders) {
  const d = await call("get_asset", { id });
  // Sketchfab downloads need the user's own login, so a model may list no files.
  const needsFiles = provider !== "sketchfab";
  check(d.id === id && (!needsFiles || d.files.length > 0), `get_asset ${provider} ${id} -> ${d.files.length} file(s)${d.files[0] ? `, e.g. ${d.files[0].label}` : ""}`);
}

const any = await call("search_assets", { query: "forest", limit: 6 });
check(new Set(any.assets.map((a) => a.provider)).size >= 2, `kind=any mixes providers: ${any.assets.map((a) => a.id.split(":")[0]).join(",")}`);

const src = await call("list_sources", { kind: "audio" });
check(src.sources.length > 0 && src.notCc0.length > 0 && src.pendingVerification.length > 0, `list_sources audio -> ${src.sources.map((s) => s.id).join(", ")}`);

const fonts = await call("list_sources", { kind: "font" });
check(fonts.sources.length > 0 && fonts.sources.every((s) => s.kinds.includes("font")), `list_sources font -> ${fonts.sources.map((s) => s.id).join(", ")}`);

// download_asset: a Poly Haven glTF must arrive with its .bin and textures, plus a receipt.
const { mkdtemp, readFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dlDir = await mkdtemp(join(tmpdir(), "cc0-smoke-"));
const dl = await call("download_asset", { id: "polyhaven:large_castle_door", dir: dlDir, files: ["gltf / 1k / gltf"] });
const gltf = JSON.parse(await readFile(join(dl.folder, "large_castle_door_1k.gltf"), "utf8"));
const needed = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].map((x) => x.uri);
check(needed.length > 0 && needed.every((u) => dl.saved.some((s) => s.path === u)) && dl.skipped.length === 0,
  `download_asset polyhaven glTF -> ${dl.saved.length} files, every uri the glTF references is saved (${needed.join(", ")})`);
const receipt = JSON.parse(await readFile(dl.receipt, "utf8"));
check(receipt.license.license === "CC0-1.0" && receipt.files.length === dl.saved.length, "download_asset wrote cc0.json with license and files");

const bad = await client.callTool({ name: "get_asset", arguments: { id: "polyhaven:does_not_exist_xyz" } });
check(bad.isError === true, "unknown id returns isError");

await client.close();
console.log("smoke: all checks passed");
