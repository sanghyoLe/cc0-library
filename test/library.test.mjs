// Unit tests with a fake fetch: no network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { search, getAsset, interleave, loadCatalog } from "../dist/library.js";
import { resetPolyhavenCache, flattenFiles } from "../dist/providers/polyhaven.js";
import { sanitizeQuery } from "../dist/providers/archive.js";
import { stripHtml } from "../dist/providers/commons.js";

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
    "commons:File", "archive:a/b", "archive:../x", "sketchfab:XYZ", "sketchfab:7c23a1ba438d4306920229c12afcb5f"]) {
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
  assert.match(f.calls.find((u) => u.includes("/search")), /t=textures/);
});

test("Poly Haven index is cached between calls", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.polyhaven.com/search?": { total: 0, results: [] },
    "https://api.polyhaven.com/assets": polyIndex,
  });
  await search(f, "a", "model", 5, 1);
  await search(f, "b", "model", 5, 1);
  assert.equal(f.calls.filter((u) => u.startsWith("https://api.polyhaven.com/assets")).length, 1);
});

test("kind=any queries all 9 provider jobs, interleaves them, and reports failing ones without dropping others", async () => {
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
    ["ambientcg", "archive", "cleveland", "commons", "met", "openverse:audio", "sketchfab"]);
  assert.match(r.errors.find((e) => e.startsWith("openverse:audio")), /Openverse returned HTTP 404/);
  assert.match(f.calls.find((u) => u.includes("ambientcg")), /type=material%2Chdri%2C3d-model/);
  // one combined query each for Commons and Internet Archive
  assert.equal(f.calls.filter((u) => u.includes("commons.wikimedia.org")).length, 1);
  assert.doesNotMatch(f.calls.find((u) => u.includes("commons.wikimedia.org")), /filetype/);
  assert.match(new URL(f.calls.find((u) => u.includes("advancedsearch"))).searchParams.get("q"), /mediatype:\(image OR audio OR movies\)/);
});

test("flattenFiles turns nested Poly Haven files into labeled rows and skips 'include'", () => {
  const rows = flattenFiles({
    hdri: { "1k": { hdr: { url: "u1", size: 10, md5: "m" } } },
    gltf: { "1k": { gltf: { url: "u2", size: 5, include: { "tex.jpg": { url: "u3", size: 1 } } } } },
  });
  assert.deepEqual(rows, [
    { label: "hdri / 1k / hdr", url: "u1", sizeBytes: 10 },
    { label: "gltf / 1k / gltf", url: "u2", sizeBytes: 5 },
  ]);
});

test("interleave alternates lists of unequal length", () => {
  assert.deepEqual(interleave([[1, 2, 3], ["a"]]), [1, "a", 2, 3]);
  assert.deepEqual(interleave([]), []);
});

test("catalog: every source has a license page, verification and valid kinds", () => {
  const c = loadCatalog();
  const kinds = new Set(["image", "audio", "video", "hdri", "texture", "model", "artwork"]);
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
  const listed = new Set(c.sources.map((s) => s.name));
  for (const e of [...c.excluded, ...c.pending]) {
    assert.ok(e.reason.length > 10, e.name);
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
  const url = f.calls.find((u) => u.includes("ambientcg"));
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
  assert.match(f.calls.find((u) => u.includes("clevelandart")), /cc0=1/);
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
  assert.equal(f.calls.filter((u) => u.startsWith("https://api.openverse.org/")).length, 1);
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
  const url = decodeURIComponent(f.calls.find((u) => u.includes("commons")).replace(/\+/g, " "));
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
  const q = new URL(f.calls.find((u) => u.includes("advancedsearch"))).searchParams.get("q");
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
  assert.match(f.calls.find((u) => u.includes("sketchfab")), /license=cc0.*cursor=8|cursor=8.*license=cc0/);
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
  assert.equal(f.calls.filter((u) => u.includes("ambientcg")).length, 0);
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
