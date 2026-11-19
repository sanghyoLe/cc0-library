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
  for (const id of ["", "nope", "openverse:video:x", `openverse:image:../../etc`, "polyhaven:a/b", "polyhaven:a:b"]) {
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
  assert.equal(f.calls.filter((u) => u.includes("/assets")).length, 1);
});

test("kind=any interleaves providers and reports a failing provider without dropping others", async () => {
  resetPolyhavenCache();
  const f = fakeFetch({
    "https://api.openverse.org/v1/images/?": { result_count: 2, results: [ov("i1", "cc0"), ov("i2", "cc0")] },
    // audio route missing -> 404 -> provider error
    "https://api.polyhaven.com/search?": { total: 1, results: [{ slug: "sky", score: 1 }] },
    "https://api.polyhaven.com/assets": polyIndex,
  });
  const r = await search(f, "x", "any", 10, 1);
  assert.deepEqual(r.assets.map((a) => a.id), ["openverse:image:i1", "polyhaven:sky", "openverse:image:i2"]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /openverse:audio: Openverse returned HTTP 404/);
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
  const kinds = new Set(["image", "audio", "hdri", "texture", "model"]);
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
});
