// Unit tests with a fake fetch: no network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { search, getAsset, interleave, loadCatalog } from "../dist/library.js";
import { resetPolyhavenCache, flattenFiles } from "../dist/providers/polyhaven.js";

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
    "ambientcg:../x", "cleveland:12a", "met:1/2", "met:", "openverse:image"]) {
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

test("kind=any queries all 7 provider jobs, interleaves them, and reports failing ones without dropping others", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.openverse.org/v1/images/?": { result_count: 2, results: [ov("i1", "cc0"), ov("i2", "cc0")] },
    // Openverse audio, ambientCG, Cleveland and Met have no route -> HTTP 404 -> provider errors
    "https://api.polyhaven.com/search?": { total: 1, results: [{ slug: "sky", score: 1 }] },
    "https://api.polyhaven.com/assets": polyIndex,
  });
  const r = await search(f, "x", "any", 10, 1);
  assert.deepEqual(r.assets.map((a) => a.id), ["openverse:image:i1", "polyhaven:sky", "openverse:image:i2"]);
  assert.deepEqual(r.errors.map((e) => e.split(":").slice(0, e.startsWith("openverse") ? 2 : 1).join(":")).sort(),
    ["ambientcg", "cleveland", "met", "openverse:audio"]);
  assert.match(r.errors.find((e) => e.startsWith("openverse:audio")), /Openverse returned HTTP 404/);
  assert.match(f.calls.find((u) => u.includes("ambientcg")), /type=material%2Chdri%2C3d-model/);
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
  const kinds = new Set(["image", "audio", "hdri", "texture", "model", "artwork"]);
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
  const statuses = [504, 200];
  const calls = [];
  const flaky = async (url) => {
    calls.push(url);
    const status = statuses.shift() ?? 504;
    return { ok: status === 200, status, json: async () => ({ result_count: 1, results: [ov("r1", "cc0")] }) };
  };
  const ok = await search(flaky, "cat", "image", 5, 1);
  assert.deepEqual(ok.assets.map((a) => a.id), ["openverse:image:r1"]);
  assert.equal(calls.length, 2);

  const always504 = async () => ({ ok: false, status: 504, json: async () => ({}) });
  const bad = await search(always504, "cat", "image", 5, 1);
  assert.match(bad.errors[0], /HTTP 504/);
});

test("a client error (404) is not retried", async () => {
  const f = fakeFetch({});
  await search(f, "cat", "image", 5, 1);
  assert.equal(f.calls.length, 1);
});
