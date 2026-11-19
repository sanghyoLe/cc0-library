// End-to-end check against the live APIs: starts dist/index.js over stdio
// and calls every tool through a real MCP client. Needs network access.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "cc0-library-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const check = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
check(tools.join() === "get_asset,list_sources,search_assets", `tools listed: ${tools}`);

for (const kind of ["image", "audio", "hdri", "texture", "model"]) {
  const q = { image: "cat", audio: "rain", hdri: "sunset", texture: "brick", model: "chair" }[kind];
  const r = await call("search_assets", { query: q, kind, limit: 3 });
  check(r.assets.length > 0 && r.errors.length === 0, `search ${kind} "${q}" -> ${r.assets.length} results`);
  check(r.assets.every((a) => a.kind === kind && a.licenseEvidence.license === "CC0-1.0"), `${kind} results are all CC0 ${kind}`);
  const d = await call("get_asset", { id: r.assets[0].id });
  check(d.id === r.assets[0].id && d.files.length > 0, `get_asset ${d.id} -> ${d.files.length} file(s), e.g. ${d.files[0].label}`);
}

const any = await call("search_assets", { query: "forest", limit: 6 });
check(new Set(any.assets.map((a) => a.provider)).size >= 2, `kind=any mixes providers: ${any.assets.map((a) => a.id.split(":")[0]).join(",")}`);

const src = await call("list_sources", { kind: "audio" });
check(src.sources.length > 0 && src.notCc0.length > 0, `list_sources audio -> ${src.sources.map((s) => s.id).join(", ")}`);

const bad = await client.callTool({ name: "get_asset", arguments: { id: "polyhaven:does_not_exist_xyz" } });
check(bad.isError === true, "unknown id returns isError");

await client.close();
console.log("smoke: all checks passed");
