// Unit tests with a fake fetch: no network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { search, getAsset, interleave, rank, relevance, loadCatalog } from "../dist/library.js";
import { resetPolyhavenCache, flattenFiles } from "../dist/providers/polyhaven.js";
import { sanitizeQuery, isPackedFile } from "../dist/providers/archive.js";
import { stripHtml } from "../dist/providers/commons.js";
import { resetIconifyCache } from "../dist/providers/iconify.js";
import { resetPhylopicCache } from "../dist/providers/phylopic.js";

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const body = typeof hit[1] === "function" ? hit[1](url) : hit[1];
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

/** Exact hostname of a recorded request URL (avoids substring matching on URLs). */
const hostOf = (u) => new URL(u).hostname;
/** Recorded calls sent to `host`, optionally filtered to a path prefix. */
const callsTo = (f, host, pathPrefix = "") => f.calls.filter((u) => hostOf(u) === host && new URL(u).pathname.startsWith(pathPrefix));

const ov = (id, license, extra = {}) => ({
  id, title: `t-${id}`, foreign_landing_url: `https://x/${id}`, url: `https://x/${id}.jpg`,
  creator: "c", license, source: "flickr", tags: [{ name: "a" }], ...extra,
});
const UUID = "145e0b37-0577-416b-8d05-27c0b0bdde46";

test("Openverse results keep only items whose own license is cc0", async () => {
  const f = fakeFetch({
    "https://api.openverse.org/v1/images/?": {
      result_count: 4,
      results: [ov("a", "cc0"), ov("b", "pdm"), ov("c", "by"), ov("d", "cc0", { mature: true })],
    },
  });
  const r = await search(f, "cat", "image", 10, 1);
  assert.deepEqual(r.assets.map((a) => a.id), ["openverse:image:a"]);
  assert.equal(r.assets[0].licenseEvidence.license, "CC0-1.0");
  assert.match(f.calls[0], /license=cc0/);
  assert.match(f.calls[0], /mature=false/);
});

test("Openverse page_size is capped at 20 (anonymous API limit)", async () => {
  const f = fakeFetch({ "https://api.openverse.org/v1/audio/?": { result_count: 0, results: [] } });
  await search(f, "rain", "audio", 50, 1);
  assert.match(f.calls[0], /page_size=20/);
});

test("get_asset returns null when the upstream item is no longer cc0", async () => {
  const f = fakeFetch({ [`https://api.openverse.org/v1/images/${UUID}/`]: ov(UUID, "by") });
  assert.equal(await getAsset(f, `openverse:image:${UUID}`), null);
});

test("get_asset rejects malformed ids without calling the network", async () => {
  const f = fakeFetch({});
  for (const id of ["", "nope", "openverse:video:x", `openverse:image:../../etc`, "polyhaven:a/b", "polyhaven:a:b",
    "ambientcg:../x", "cleveland:12a", "met:1/2", "met:", "openverse:image",
    "commons:File", "archive:a/b", "archive:../x", "sketchfab:XYZ", "sketchfab:7c23a1ba438d4306920229c12afcb5f",
    "wpphotos:abc", "wpphotos:1/2", "inaturalist:x", "gbif:1a", "phylopic:nope", "iconify:a", "iconify:A_B:c",
    "zenodo:x", "github:noslash", "github:a/b/c", "huggingface:../x", "blenderkit:123"]) {
    assert.equal(await getAsset(f, id), null, id);
  }
  assert.equal(f.calls.length, 0);
});

const polyIndex = {
  brick_wall: { name: "Brick Wall", type: 1, tags: ["brick"], categories: ["wall"], authors: { Rob: "All" } },
  sky: { name: "Sky", type: 0, tags: ["sky"] },
};

test("Poly Haven search maps slugs to assets in score order and credits Poly Haven", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.polyhaven.com/search?": { total: 3, results: [{ slug: "sky", score: 0.4 }, { slug: "brick_wall", score: 0.9 }, { slug: "gone", score: 0.8 }] },
    "https://api.polyhaven.com/assets": polyIndex,
  });
  const r = await search(f, "brick", "texture", 10, 1);
  assert.deepEqual(r.assets.map((a) => a.id), ["polyhaven:brick_wall", "polyhaven:sky"]);
  assert.equal(r.assets[0].kind, "texture");
  assert.equal(r.assets[1].kind, "hdri");
  assert.match(r.assets[0].servedBy, /Poly Haven/);
  assert.equal(r.assets[0].landingUrl, "https://polyhaven.com/a/brick_wall");
  assert.match(callsTo(f, "api.polyhaven.com", "/search")[0], /t=textures/);
});

test("Poly Haven index is cached between calls", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.polyhaven.com/search?": { total: 0, results: [] },
    "https://api.polyhaven.com/assets": polyIndex,
  });
  await search(f, "a", "model", 5, 1);
  await search(f, "b", "model", 5, 1);
  assert.equal(callsTo(f, "api.polyhaven.com", "/assets").length, 1);
});

test("kind=any queries all 16 provider jobs, interleaves them, and reports failing ones without dropping others", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.openverse.org/v1/images/?": { result_count: 2, results: [ov("i1", "cc0"), ov("i2", "cc0")] },
    // every other provider has no route -> HTTP 404 -> provider errors
    "https://api.polyhaven.com/search?": { total: 1, results: [{ slug: "sky", score: 1 }] },
    "https://api.polyhaven.com/assets": polyIndex,
  });
  const r = await search(f, "x", "any", 10, 1);
  assert.deepEqual(r.assets.map((a) => a.id), ["openverse:image:i1", "polyhaven:sky", "openverse:image:i2"]);
  assert.deepEqual(r.errors.map((e) => e.split(":").slice(0, e.startsWith("openverse") ? 2 : 1).join(":")).sort(),
    ["ambientcg", "archive", "blenderkit", "cleveland", "commons", "gbif", "iconify", "inaturalist", "met", "openverse:audio", "phylopic", "sketchfab", "wpphotos", "zenodo"]);
  assert.match(r.errors.find((e) => e.startsWith("openverse:audio")), /Openverse returned HTTP 404/);
  assert.match(callsTo(f, "ambientcg.com")[0], /type=material%2Chdri%2C3d-model/);
  // one combined query each for Commons and Internet Archive
  assert.equal(callsTo(f, "commons.wikimedia.org").length, 1);
  assert.doesNotMatch(callsTo(f, "commons.wikimedia.org")[0], /filetype/);
  assert.match(new URL(callsTo(f, "archive.org", "/advancedsearch.php")[0]).searchParams.get("q"), /mediatype:\(image OR audio OR movies\)/);
});

test("flattenFiles turns nested Poly Haven files into labeled rows and keeps a model's 'include' on its row", () => {
  const rows = flattenFiles({
    hdri: { "1k": { hdr: { url: "u1", size: 10, md5: "m" } } },
    gltf: { "1k": { gltf: { url: "u2", size: 5, include: { "door.bin": { url: "u3", size: 1 }, "textures/d.jpg": { url: "u4" } } } } },
  });
  assert.deepEqual(rows, [
    { label: "hdri / 1k / hdr", url: "u1", sizeBytes: 10 },
    {
      label: "gltf / 1k / gltf", url: "u2", sizeBytes: 5,
      includes: [{ path: "door.bin", url: "u3", sizeBytes: 1 }, { path: "textures/d.jpg", url: "u4", sizeBytes: null }],
    },
  ]);
});

test("relevance scores title words over tags, handles plurals, prefixes and Korean", () => {
  assert.equal(relevance("footsteps", { title: "footstep on wood foley.wav", tags: [] }), 2);
  assert.equal(relevance("pixel sprite", { title: "Hero sprites", tags: ["pixelart"] }), 1.5);
  assert.equal(relevance("shopping cart", { title: "water oak (Quercus nigra)", tags: [] }), 0);
  assert.equal(relevance("the cat", { title: "Cat", tags: [] }), 2);
  assert.equal(relevance("고양이", { title: "나무 위의 고양이.jpg", tags: [] }), 2);
  assert.equal(relevance("...", { title: "anything", tags: [] }), 0);
});

test("rank puts matching items first and keeps the order of ties", () => {
  const items = [{ id: 1, title: "Pisum sativum", tags: [] }, { id: 2, title: "Cart icon", tags: [] },
    { id: 3, title: "Oak", tags: [] }, { id: 4, title: "Basket", tags: ["cart"] }];
  assert.deepEqual(rank("cart", items).map((a) => a.id), [2, 4, 1, 3]);
});

test("providers option runs only the named providers", async () => {
  const f = fakeFetch({ "https://api.openverse.org/v1/images/?": { result_count: 1, results: [ov("i1", "cc0")] } });
  const r = await search(f, "x", "image", 5, 1, { providers: ["openverse"] });
  assert.deepEqual(r.assets.map((a) => a.id), ["openverse:image:i1"]);
  assert.deepEqual(r.errors, []);
  assert.equal(callsTo(f, "wikimedia.org").length + callsTo(f, "archive.org").length + callsTo(f, "iconify").length, 0);
});

test("PhyloPic 404 for an unknown name is an empty result, not an error", async () => {
  resetPhylopicCache();
  const f = fakeFetch({ "https://api.phylopic.org/": { build: 9 } }); // /images has no route -> 404
  const r = await search(f, "shopping cart", "image", 5, 1, { providers: ["phylopic"] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.assets, []);
});

test("Internet Archive items titled like archive files are dropped", () => {
  assert.equal(isPackedFile({ title: "TRANSCENDANT 9 8 2026.7z" }), true);
  assert.equal(isPackedFile({ title: ["Pack.ZIP"] }), true);
  assert.equal(isPackedFile({ title: "Winter Landscape" }), false);
  assert.equal(isPackedFile({}), false);
});

test("interleave alternates lists of unequal length", () => {
  assert.deepEqual(interleave([[1, 2, 3], ["a"]]), [1, "a", 2, 3]);
  assert.deepEqual(interleave([]), []);
});

test("catalog: every source has a license page, verification and valid kinds", () => {
  const c = loadCatalog();
  const kinds = new Set(["image", "audio", "video", "hdri", "texture", "model", "artwork", "collection", "font"]);
  const ids = new Set();
  for (const s of c.sources) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.match(s.licensePage, /^https:\/\//, s.id);
    assert.match(s.verified.date, /^\d{4}-\d{2}-\d{2}$/, s.id);
    assert.ok(s.verified.evidence.length > 10, s.id);
    assert.ok(["whole-library", "filter-only"].includes(s.scope), s.id);
    for (const k of s.kinds) assert.ok(kinds.has(k), `${s.id}: ${k}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const urls = new Set();
  for (const s of c.sources) {
    assert.ok(s.verified.date <= today, `${s.id}: verified date is in the future`);
    assert.match(s.url, /^https:\/\//, `${s.id}: url must be https`);
    assert.ok(!urls.has(s.url), `${s.id}: duplicate url ${s.url}`);
    urls.add(s.url);
  }
  const listed = new Set(c.sources.map((s) => s.name));
  for (const e of [...c.excluded, ...c.pending]) {
    assert.ok(e.reason.length > 10, e.name);
    assert.match(e.url ?? "", /^https?:\/\//, `${e.name}: excluded/pending entries need a url (used by scripts/discover.mjs)`);
    assert.ok(!listed.has(e.name), `${e.name} is both listed and excluded/pending`);
  }
});

test("ambientCG maps v3 types to kinds and requests the right type filter", async () => {
  const f = fakeFetch({
    "https://ambientcg.com/api/v3/assets?": {
      totalResults: 3,
      assets: [
        { id: "Wood096", type: "material", title: "Wood 096", url: "https://ambientcg.com/a/Wood096", tags: ["wood"], thumbnails: { "256-PNG": "t.png" } },
        { id: "Sky01", type: "hdri", title: "Sky" },
        { id: "3DApple002", type: "3d-model", title: "Apple" },
      ],
    },
  });
  const r = await search(f, "wood", "texture", 3, 2);
  const url = callsTo(f, "ambientcg.com")[0];
  assert.match(url, /type=material&/);
  assert.match(url, /offset=3/);
  const acg = r.assets.filter((a) => a.provider === "ambientcg");
  assert.deepEqual(acg.map((a) => [a.id, a.kind]), [["ambientcg:Wood096", "texture"], ["ambientcg:Sky01", "hdri"], ["ambientcg:3DApple002", "model"]]);
  assert.equal(acg[0].thumbnailUrl, "t.png");
  assert.equal(acg[0].licenseEvidence.method, "whole-library-cc0");
});

const cle = (id, status) => ({
  id, title: `Art ${id}`, url: `https://clevelandart.org/art/${id}`, share_license_status: status,
  creators: [{ description: "Painter (1800)" }], images: { web: { url: `w${id}.jpg` }, print: { url: `p${id}.jpg`, filesize: "100" } },
});

test("Cleveland keeps only share_license_status=CC0 items with an image", async () => {
  const noImage = { ...cle(3, "CC0"), images: null };
  const f = fakeFetch({ "https://openaccess-api.clevelandart.org/api/artworks/?": { info: { total: 3 }, data: [cle(1, "CC0"), cle(2, "Copyrighted"), noImage] } });
  const r = await search(f, "cat", "artwork", 5, 1);
  const c = r.assets.filter((a) => a.provider === "cleveland");
  assert.deepEqual(c.map((a) => a.id), ["cleveland:1"]);
  assert.equal(c[0].creator, "Painter (1800)");
  assert.equal(c[0].fileUrl, "p1.jpg");
  assert.match(callsTo(f, "openaccess-api.clevelandart.org")[0], /cc0=1/);
});

test("Cleveland get_asset returns null for a non-CC0 work", async () => {
  const f = fakeFetch({ "https://openaccess-api.clevelandart.org/api/artworks/2": { data: cle(2, "Copyrighted") } });
  assert.equal(await getAsset(f, "cleveland:2"), null);
});

const metObj = (id, pd, img = true) => ({
  objectID: id, isPublicDomain: pd, title: `Obj ${id}`, objectURL: `https://www.metmuseum.org/art/collection/search/${id}`,
  primaryImage: img ? `o${id}.jpg` : "", primaryImageSmall: img ? `s${id}.jpg` : "", tags: [{ term: "Cats" }],
});

test("The Met keeps only isPublicDomain objects with images and survives a failed object fetch", async () => {
  const f = fakeFetch({
    "https://collectionapi.metmuseum.org/public/collection/v1.1/search?": { total: 4, objectIDs: [1, 2, 3, 4] },
    "https://collectionapi.metmuseum.org/public/collection/v1/objects/1": metObj(1, true),
    "https://collectionapi.metmuseum.org/public/collection/v1/objects/2": metObj(2, false),
    "https://collectionapi.metmuseum.org/public/collection/v1/objects/3": metObj(3, true, false),
    // object 4 has no route -> 404 -> skipped
  });
  const r = await search(f, "cat", "artwork", 5, 1);
  assert.deepEqual(r.assets.filter((a) => a.provider === "met").map((a) => a.id), ["met:1"]);
  assert.ok(!r.errors.some((e) => e.startsWith("met")));
});

test("The Met fetches object details at most 4 at a time", async () => {
  let inFlight = 0, peak = 0;
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const f = async (url) => {
    if (url.includes("/v1.1/search?")) return { ok: true, status: 200, json: async () => ({ total: 12, objectIDs: ids }) };
    if (!url.includes("/objects/")) return { ok: false, status: 404, json: async () => ({}) };
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const id = Number(url.split("/").pop());
    return { ok: true, status: 200, json: async () => metObj(id, true) };
  };
  const r = await search(f, "cat", "artwork", 12, 1);
  assert.equal(peak, 4);
  assert.equal(r.assets.filter((a) => a.provider === "met").length, 12);
});

test("search reports partial results as providers finish, before the slowest one answers", async () => {
  const slow = (body, ms) => async () => { await new Promise((r) => setTimeout(r, ms)); return { ok: true, status: 200, json: async () => body }; };
  const routes = {
    "https://openaccess-api.clevelandart.org/": slow({ info: { total: 0 }, data: [] }, 1),
    "https://collectionapi.metmuseum.org/": slow({ total: 0, objectIDs: [] }, 40),
  };
  const f = async (url) => { const hit = Object.entries(routes).find(([p]) => url.startsWith(p)); return hit ? hit[1]() : { ok: false, status: 404, json: async () => ({}) }; };
  const progress = [];
  const r = await search(f, "cat", "artwork", 5, 1, { onProgress: (partial, pending) => progress.push(pending) });
  assert.deepEqual(progress, [1]);
  assert.deepEqual(r.errors, []);
});

test("settleWithLimit drops items still pending at the deadline", async () => {
  const { settleWithLimit } = await import("../dist/providers/met.js");
  const delays = [1, 1, 500, 1];
  const t0 = Date.now();
  const r = await settleWithLimit(delays, 2, (ms) => new Promise((res) => setTimeout(() => res(ms), ms)), 50);
  assert.ok(Date.now() - t0 < 300);
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "fulfilled", "rejected", "fulfilled"]);
});

test("Openverse Freesound items label the lossy preview and point the original at the Freesound page", async () => {
  const f = fakeFetch({
    [`https://api.openverse.org/v1/audio/${UUID}/`]: {
      id: UUID, title: "Steps", license: "cc0", source: "freesound",
      foreign_landing_url: "https://freesound.org/people/a/sounds/1",
      url: "https://cdn.freesound.org/previews/0/1_2-hq.mp3", filetype: "mp3",
      alt_files: [{ url: "https://freesound.org/apiv2/sounds/1/download/", filesize: 5040736, filetype: "wav" }],
    },
  });
  const d = await getAsset(f, `openverse:audio:${UUID}`);
  assert.deepEqual(d.files, [
    { label: "preview (mp3, lossy)", url: "https://cdn.freesound.org/previews/0/1_2-hq.mp3", sizeBytes: null },
    { label: "original (wav) — download on Freesound (login required)", url: "https://freesound.org/people/a/sounds/1", sizeBytes: 5040736 },
  ]);
});

test("The Met get_asset lists primary and additional images", async () => {
  const f = fakeFetch({ "https://collectionapi.metmuseum.org/public/collection/v1/objects/7": { ...metObj(7, true), additionalImages: ["a.jpg"] } });
  const d = await getAsset(f, "met:7");
  assert.deepEqual(d.files.map((x) => x.label), ["primary", "additional 1"]);
});

test("a gateway error (504) is retried once; a second failure is reported", async () => {
  const OV = "https://api.openverse.org/";
  const statuses = [504, 200];
  const ovCalls = [];
  const flaky = async (url) => {
    if (!url.startsWith(OV)) return { ok: false, status: 404, json: async () => ({}) };
    ovCalls.push(url);
    const status = statuses.shift() ?? 504;
    return { ok: status === 200, status, json: async () => ({ result_count: 1, results: [ov("r1", "cc0")] }) };
  };
  const ok = await search(flaky, "cat", "image", 5, 1);
  assert.deepEqual(ok.assets.map((a) => a.id), ["openverse:image:r1"]);
  assert.equal(ovCalls.length, 2);

  const always504 = async (url) => ({ ok: false, status: url.startsWith(OV) ? 504 : 404, json: async () => ({}) });
  const bad = await search(always504, "cat", "image", 5, 1);
  assert.match(bad.errors.find((e) => e.startsWith("openverse")), /HTTP 504/);
});

test("a client error (404) is not retried", async () => {
  const f = fakeFetch({});
  await search(f, "cat", "image", 5, 1);
  assert.equal(callsTo(f, "api.openverse.org").length, 1);
});

const commonsPage = (pageid, license, mime = "image/jpeg", index = 1) => ({
  pageid, index, title: `File:F${pageid}.jpg`,
  imageinfo: [{ url: `u${pageid}`, descriptionurl: `https://commons.wikimedia.org/wiki/File:F${pageid}.jpg`, thumburl: `t${pageid}`, mime, size: 9,
    extmetadata: { License: { value: license }, Artist: { value: '<a href="//x">Jane&nbsp;Doe</a>' } } }],
});

test("Commons searches Category:CC-Zero with a filetype filter and keeps only License=cc0 files in rank order", async () => {
  const f = fakeFetch({
    "https://commons.wikimedia.org/w/api.php?": {
      query: { searchinfo: { totalhits: 3 }, pages: [commonsPage(2, "cc0", "image/png", 2), commonsPage(1, "cc0", "image/jpeg", 1), commonsPage(3, "cc-by-sa-4.0", "image/jpeg", 3)] },
    },
  });
  const r = await search(f, "rain", "video", 5, 2);
  const url = decodeURIComponent(callsTo(f, "commons.wikimedia.org")[0].replace(/\+/g, " "));
  assert.match(url, /gsrsearch=rain incategory:CC-Zero filetype:video/);
  assert.match(url, /gsroffset=5/);
  const c = r.assets.filter((a) => a.provider === "commons");
  assert.deepEqual(c.map((a) => a.id), ["commons:1", "commons:2"]);
  assert.equal(c[0].creator, "Jane Doe");
});

test("Commons audio results drop the generic file-icon thumbnail", async () => {
  const f = fakeFetch({ "https://commons.wikimedia.org/w/api.php?": { query: { pages: [commonsPage(5, "cc0", "audio/ogg")] } } });
  const r = await search(f, "x", "audio", 5, 1);
  const a = r.assets.find((x) => x.provider === "commons");
  assert.equal(a.kind, "audio");
  assert.equal(a.thumbnailUrl, null);
});

test("stripHtml keeps text only", () => {
  assert.equal(stripHtml('<span>A &amp; <b>B</b></span>'), "A & B");
  assert.equal(stripHtml(""), null);
});

test("Internet Archive: query is sanitized so users cannot bypass the CC0 clause", async () => {
  assert.equal(sanitizeQuery('rain) OR licenseurl:"x" OR (a'), "rain licenseurl x a");
  assert.equal(sanitizeQuery("비 소리"), "비 소리");
  const f = fakeFetch({
    "https://archive.org/advancedsearch.php?": {
      response: { numFound: 3, docs: [
        { identifier: "ok1", title: "Ok", mediatype: "movies", licenseurl: "https://creativecommons.org/publicdomain/zero/1.0/" },
        { identifier: "by1", title: "By", mediatype: "movies", licenseurl: "http://creativecommons.org/licenses/by/4.0/" },
        { identifier: "none", title: "None", mediatype: "movies" },
      ] },
    },
  });
  const r = await search(f, 'rain) OR (licenseurl:*', "video", 5, 1);
  const q = new URL(callsTo(f, "archive.org", "/advancedsearch.php")[0]).searchParams.get("q");
  assert.match(q, /^\(rain licenseurl\) AND mediatype:movies AND \(licenseurl:"http:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/" OR /);
  assert.deepEqual(r.assets.filter((a) => a.provider === "archive").map((a) => [a.id, a.kind]), [["archive:ok1", "video"]]);
});

test("Internet Archive get_asset lists original content files only", async () => {
  const f = fakeFetch({
    "https://archive.org/metadata/vid1": {
      metadata: { identifier: "vid1", title: "V", mediatype: "movies", licenseurl: "http://creativecommons.org/publicdomain/zero/1.0/" },
      files: [
        { name: "v.mpeg", format: "MPEG2", size: "100", source: "original" },
        { name: "v.ogv", format: "Ogg Video", source: "derivative" },
        { name: "__ia_thumb.jpg", format: "Item Tile", source: "original" },
        { name: "v.mpeg_meta.txt", format: "Metadata", source: "original" },
        { name: "sub dir/a b.mp4", format: "MPEG4", source: "original" },
      ],
    },
  });
  const d = await getAsset(f, "archive:vid1");
  assert.deepEqual(d.files.map((x) => x.url), ["https://archive.org/download/vid1/v.mpeg", "https://archive.org/download/vid1/sub%20dir/a%20b.mp4"]);
});

const sfModel = (uid, license, extra = {}) => ({
  uid, name: `M ${uid}`, viewerUrl: `https://sketchfab.com/3d-models/${uid}`, license,
  user: { username: "smithsonian", displayName: "The Smithsonian Institution" },
  thumbnails: { images: [{ url: "big", width: 1024 }, { url: "small", width: 100 }, { url: "mid", width: 256 }] }, ...extra,
});
const UID_A = "a".repeat(32);

test("Sketchfab keeps only CC0 models, skips age-restricted ones, credits the creator", async () => {
  const f = fakeFetch({
    "https://api.sketchfab.com/v3/search?": { results: [
      sfModel(UID_A, { uid: "7c23a1ba438d4306920229c12afcb5f9", label: "CC0 Public Domain" }),
      sfModel("b".repeat(32), { uid: "other", label: "CC Attribution" }),
      sfModel("c".repeat(32), { slug: "cc0" }, { isAgeRestricted: true }),
    ] },
  });
  const r = await search(f, "chair", "model", 4, 3);
  assert.match(callsTo(f, "api.sketchfab.com")[0], /license=cc0.*cursor=8|cursor=8.*license=cc0/);
  const s = r.assets.filter((a) => a.provider === "sketchfab");
  assert.deepEqual(s.map((a) => a.id), [`sketchfab:${UID_A}`]);
  assert.equal(s[0].creator, "The Smithsonian Institution (@smithsonian)");
  assert.equal(s[0].thumbnailUrl, "mid");
});

test("Sketchfab get_asset re-checks the license", async () => {
  const f = fakeFetch({ [`https://api.sketchfab.com/v3/models/${UID_A}`]: sfModel(UID_A, { slug: "cc-by" }) });
  assert.equal(await getAsset(f, `sketchfab:${UID_A}`), null);
});

test("search options.skip leaves providers out (browser gallery skips ambientCG)", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({});
  const r = await search(f, "wood", "texture", 5, 1, { skip: ["ambientcg"] });
  assert.equal(callsTo(f, "ambientcg.com").length, 0);
  assert.ok(!r.errors.some((e) => e.startsWith("ambientcg")));
});

test("Commons tells Ogg video (.ogv) from Ogg audio by extension", async () => {
  const { kindOfMime } = await import("../dist/providers/commons.js");
  assert.equal(kindOfMime("application/ogg", "File:Ocean surface waves.ogv"), "video");
  assert.equal(kindOfMime("application/ogg", "File:Rain.ogg"), "audio");
  assert.equal(kindOfMime("video/webm", "File:x.webm"), "video");
  assert.equal(kindOfMime("image/jpeg", "File:x.jpg"), "image");
});

test("every provider states who declared CC0", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.openverse.org/v1/images/?": { result_count: 1, results: [ov("i1", "cc0")] },
    "https://api.polyhaven.com/search?": { total: 1, results: [{ slug: "sky", score: 1 }] },
    "https://api.polyhaven.com/assets": polyIndex,
    "https://openaccess-api.clevelandart.org/api/artworks/?": { info: { total: 1 }, data: [cle(1, "CC0")] },
    "https://archive.org/advancedsearch.php?": { response: { numFound: 1, docs: [{ identifier: "a1", mediatype: "image", licenseurl: "http://creativecommons.org/publicdomain/zero/1.0/" }] } },
  });
  const r = await search(f, "x", "any", 20, 1);
  const by = Object.fromEntries(r.assets.map((a) => [a.provider, a.licenseEvidence.declaredBy]));
  assert.deepEqual(by, { openverse: "uploader", polyhaven: "library", cleveland: "institution", archive: "uploader" });
});

const wpPhoto = (id, alt) => ({
  id, link: `https://wordpress.org/photos/photo/${id}/`, title: { rendered: "Photo detail" }, content: { rendered: `<p>${alt}</p>` },
  "photo-thumbnail-url": `t${id}.jpg`,
  _embedded: { author: [{ name: "jane" }], "wp:featuredmedia": [{ source_url: `o${id}.jpg`, media_details: { width: 2000, height: 1000, filesize: 5, sizes: { medium: { source_url: `m${id}.jpg`, width: 300, height: 150 }, full: { source_url: `o${id}.jpg`, width: 2000, height: 1000 } } } }] },
});

test("WordPress Photo Directory: alt text becomes the title, whole-library CC0 declared by the uploader", async () => {
  const long = "A ".repeat(80) + "end";
  const f = fakeFetch({ "https://wordpress.org/photos/wp-json/wp/v2/photos?": [wpPhoto(7, "Red barn &amp; field"), wpPhoto(8, long)] });
  const r = await search(f, "barn", "image", 5, 2);
  const q = new URL(callsTo(f, "wordpress.org", "/photos/wp-json")[0]).searchParams;
  assert.equal(q.get("search"), "barn");
  assert.equal(q.get("page"), "2");
  const w = r.assets.filter((a) => a.provider === "wpphotos");
  assert.deepEqual(w.map((a) => a.id), ["wpphotos:7", "wpphotos:8"]);
  assert.equal(w[0].title, "Red barn & field");
  assert.ok(w[1].title.length <= 90 && w[1].title.endsWith("…"));
  assert.equal(w[0].creator, "jane");
  assert.deepEqual([w[0].licenseEvidence.method, w[0].licenseEvidence.declaredBy], ["whole-library-cc0", "uploader"]);
});

test("WordPress Photo Directory get_asset lists the original and resized files once", async () => {
  const f = fakeFetch({ "https://wordpress.org/photos/wp-json/wp/v2/photos/7": wpPhoto(7, "Barn") });
  const d = await getAsset(f, "wpphotos:7");
  assert.deepEqual(d.files.map((x) => x.url), ["o7.jpg", "m7.jpg"]);
});

test("list_sources output matches its declared output schema (catalog fields stay in sync)", async () => {
  const { createServer } = await import("../dist/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(fakeFetch({}));
  const client = new Client({ name: "schema-check", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  // The client validates structuredContent against outputSchema and throws on mismatch.
  const r = await client.callTool({ name: "list_sources", arguments: {} });
  assert.ok(r.structuredContent.sources.length > 0);
  await client.close();
});

const CC0 = "http://creativecommons.org/publicdomain/zero/1.0/";

test("iNaturalist uses only cc0 photos and requests photo_license=cc0", async () => {
  const obs = (id, codes) => ({ id, uri: `https://www.inaturalist.org/observations/${id}`, taxon: { name: "Vulpes vulpes", preferred_common_name: "Red Fox" },
    user: { login: "u" }, photos: codes.map((c, i) => ({ id: i, license_code: c, url: `https://x/photos/${id}${i}/square.jpg` })) });
  const f = fakeFetch({ "https://api.inaturalist.org/v1/observations?": { total_results: 2, results: [obs(1, ["cc-by", "cc0"]), obs(2, ["cc-by"])] } });
  const r = await search(f, "fox", "image", 20, 1);
  const a = r.assets.filter((x) => x.provider === "inaturalist");
  assert.deepEqual(a.map((x) => x.id), ["inaturalist:1"]);
  assert.equal(a[0].fileUrl, "https://x/photos/11/original.jpg");
  assert.equal(a[0].title, "Red Fox (Vulpes vulpes)");
  assert.equal(new URL(callsTo(f, "api.inaturalist.org")[0]).searchParams.get("photo_license"), "cc0");
});

test("GBIF needs a CC0 record and a CC0 (or unstated) image license", async () => {
  const occ = (key, lic, mlic) => ({ key, scientificName: "Vulpes", license: lic, media: [{ type: "StillImage", identifier: `https://img/${key}.jpg`, ...(mlic ? { license: mlic } : {}) }] });
  const f = fakeFetch({ "https://api.gbif.org/v1/occurrence/search?": { count: 4, results: [
    occ(1, CC0 + "legalcode", CC0), occ(2, CC0 + "legalcode"), occ(3, CC0 + "legalcode", "http://creativecommons.org/licenses/by/4.0/"), occ(4, "http://creativecommons.org/licenses/by/4.0/legalcode", CC0),
  ] } });
  const r = await search(f, "fox", "image", 20, 1);
  assert.deepEqual(r.assets.filter((x) => x.provider === "gbif").map((x) => x.id), ["gbif:1", "gbif:2"]);
});

test("PhyloPic keeps only images whose license link is CC0", async () => {
  resetPhylopicCache();
  const img = (uuid, lic) => ({ uuid, _links: { license: { href: lic }, self: { href: "", title: "Vulpes" }, rasterFiles: [{ href: `r-${uuid}`, sizes: "512x512" }], thumbnailFiles: [{ href: `t-${uuid}`, sizes: "64x64" }] } });
  const u1 = "11111111-1111-1111-1111-111111111111", u2 = "22222222-2222-2222-2222-222222222222";
  const f = fakeFetch({
    "https://api.phylopic.org/images?": { _embedded: { items: [img(u1, "https://creativecommons.org/publicdomain/zero/1.0/"), img(u2, "https://creativecommons.org/publicdomain/mark/1.0/")] } },
    "https://api.phylopic.org/": { build: 9 },
  });
  const r = await search(f, "Vulpes!", "image", 20, 1);
  assert.deepEqual(r.assets.filter((x) => x.provider === "phylopic").map((x) => x.id), [`phylopic:${u1}`]);
  const q = new URL(callsTo(f, "api.phylopic.org", "/images")[0]).searchParams;
  assert.deepEqual([q.get("build"), q.get("filter_name")], ["9", "vulpes"]);
});

test("Iconify searches only icon sets whose license is CC0-1.0", async () => {
  resetIconifyCache();
  const f = fakeFetch({
    "https://api.iconify.design/collections": { maki: { name: "Maki", license: { spdx: "CC0-1.0" } }, mdi: { name: "MDI", license: { spdx: "Apache-2.0" } } },
    "https://api.iconify.design/search?": { icons: ["maki:heart", "mdi:heart"], total: 2 },
  });
  const r = await search(f, "heart", "image", 20, 1);
  assert.equal(new URL(callsTo(f, "api.iconify.design", "/search")[0]).searchParams.get("prefixes"), "maki");
  assert.deepEqual(r.assets.filter((x) => x.provider === "iconify").map((x) => x.id), ["iconify:maki:heart"]);
  assert.equal((await getAsset(f, "iconify:mdi:heart")), null);
});

test("Zenodo requires the CC0 rights clause and a cc-zero record license", async () => {
  const rec = (id, lic) => ({ id, links: {}, metadata: { title: `R${id}`, license: { id: lic }, resource_type: { type: "image" } }, files: [{ key: "a.png", links: { self: `f${id}` } }] });
  const f = fakeFetch({ "https://zenodo.org/api/records?": { hits: { total: 2, hits: [rec(1, "cc-zero"), rec(2, "cc-by-4.0")] } } });
  const r = await search(f, 'bird) OR (x', "image", 20, 1);
  assert.equal(new URL(callsTo(f, "zenodo.org")[0]).searchParams.get("q"), "(bird x) AND metadata.rights.id:cc0-1.0");
  assert.deepEqual(r.assets.filter((x) => x.provider === "zenodo").map((x) => x.id), ["zenodo:1"]);
});

test("BlenderKit keeps only cc_zero public assets and maps asset types to kinds", async () => {
  const bk = (id, lic, type, priv = false) => ({ id, name: id, assetType: type, license: lic, isPrivate: priv });
  const ids = ["a", "b", "c", "d"].map((c) => c.repeat(8) + "-0000-0000-0000-000000000000");
  const f = fakeFetch({ "https://www.blenderkit.com/api/v1/search/?": { count: 4, results: [bk(ids[0], "cc_zero", "material"), bk(ids[1], "royalty_free", "model"), bk(ids[2], "cc_zero", "model", true), bk(ids[3], "cc_zero", "hdr")] } });
  const r = await search(f, "wood", "texture", 20, 1);
  assert.match(new URL(callsTo(f, "www.blenderkit.com")[0]).searchParams.get("query"), /^wood license:cc_zero asset_type:material$/);
  assert.deepEqual(r.assets.filter((x) => x.provider === "blenderkit").map((x) => [x.id.slice(11, 12), x.kind]), [["a", "texture"], ["d", "hdri"]]);
});

test("collections: only kind=collection queries GitHub and Hugging Face, and both re-check CC0", async () => {
  const f = fakeFetch({
    "https://api.github.com/search/repositories?": { total_count: 2, items: [
      { full_name: "a/x", html_url: "https://github.com/a/x", description: "", license: { spdx_id: "CC0-1.0" } },
      { full_name: "b/y", html_url: "https://github.com/b/y", description: "", license: { spdx_id: "MIT" } },
    ] },
    "https://huggingface.co/api/datasets?": [{ id: "o/d1", tags: ["license:cc0-1.0", "modality:image"] }, { id: "o/d2", tags: ["license:mit"] }],
  });
  const any = await search(f, "sprites", "any", 20, 1);
  assert.ok(!any.assets.some((a) => a.kind === "collection"));
  assert.equal(callsTo(f, "api.github.com").length, 0);
  const r = await search(f, "sprites license:mit", "collection", 20, 1);
  assert.equal(new URL(callsTo(f, "api.github.com")[0]).searchParams.get("q"), "sprites license mit license:cc0-1.0");
  assert.deepEqual(r.assets.map((a) => a.id).sort(), ["github:a/x", "huggingface:o/d1"]);
});
