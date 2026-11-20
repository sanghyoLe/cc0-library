// CC0 Museum: a walkable 3D gallery generated from CC0 assets at runtime, rendered with
// three.js WebGPURenderer (WebGPU, with an automatic WebGL2 fallback).
//
// Paintings: Wikimedia Commons files whose own license is CC0 (lib/providers/commons.js).
// Floor texture, lighting HDRI and sculptures: Poly Haven (whole library CC0).
// Ambient sound: an Openverse audio result whose own license is CC0.
// Every asset placed in the room is listed in the Credits panel with its license evidence.
//
// Loading: the engine loads with dynamic imports so failures can be shown. Each exhibition
// runs as a numbered "generation"; starting a new one makes stale loads discard their
// results. Paintings appear as empty frames first and fade in as their images arrive.
import { searchCommons } from "./lib/providers/commons.js";
import { searchPolyhaven, getPolyhaven } from "./lib/providers/polyhaven.js";
import { searchOpenverse } from "./lib/providers/openverse.js";

const browserFetch = (url, init) => fetch(url, { headers: { Accept: "application/json", ...init?.headers } });

// Room size in meters. Paintings hang on the two long walls.
const ROOM = { width: 14, length: 36, height: 6 };
const SLOTS_PER_WALL = 8;
const SLOTS = SLOTS_PER_WALL * 2;
const EYE_HEIGHT = 1.65;
const PAINTING_MAX = { w: 3, h: 2.2 };
const SCULPTURES = 3;
/** Per-asset time limits; a slow asset leaves its slot empty instead of stalling the room. */
const TIMEOUT = { image: 15000, model: 25000, hdri: 20000, search: 15000 };
const FADE_SECONDS = 0.6;

const $ = (s) => document.querySelector(s);
const isTouch = matchMedia("(hover: none) and (pointer: coarse)").matches;
/** ?joystick=1 shows the joystick on desktop too (for testing). */
const showJoystick = isTouch || new URLSearchParams(location.search).get("joystick") === "1";

let THREE, GLTFLoader, RGBELoader, renderer, scene, camera, exhibit, floorMat;
const look = { yaw: 0, pitch: 0 };
const clickable = [];
const fading = []; // { material, t }
let credits = [];
let generation = 0;

// ---------------- small utilities ----------------
function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
}

/** Wikimedia serves thumbnails only at standard widths (330, 500, 960, 1280); use 960px for the walls. */
const largerThumb = (u) => (u ? u.replace(/\/(\d+)px-/, "/960px-") : u);
const fileByLabel = (detail, re) => detail?.files.find((f) => re.test(f.label))?.url;

function engineMessage(text, isError = false) {
  const el = $("#engine");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// ---------------- loading overlay ----------------
const progress = { done: 0, total: 1, paintings: [0, 0], sculptures: [0, 0] };

function resetProgress() {
  Object.assign(progress, { done: 0, total: 1 + 2 + SLOTS + SCULPTURES, paintings: [0, 0], sculptures: [0, 0] });
  for (const li of document.querySelectorAll("#steps li")) {
    li.className = "";
    const c = li.querySelector(".count");
    if (c) c.textContent = "";
  }
  $("#enter").hidden = true;
  renderProgress();
}

function step(name, state) {
  const li = $(`#steps li[data-step="${name}"]`);
  if (li) li.className = state;
}

function tickProgress(units = 1) {
  progress.done = Math.min(progress.total, progress.done + units);
  renderProgress();
}

function renderProgress() {
  const pct = Math.round((progress.done / progress.total) * 100);
  $("#bar-fill").style.width = `${pct}%`;
  $("#loading-pct").textContent = `${pct}%`;
  const [pd, pt] = progress.paintings;
  const [sd, st] = progress.sculptures;
  $('#steps li[data-step="paintings"] .count').textContent = pt ? `${pd}/${pt}` : "";
  $('#steps li[data-step="sculptures"] .count').textContent = st ? `${sd}/${st}` : "";
  const hud = $("#hud-loading");
  const pending = pt - pd + (st - sd);
  hud.hidden = pending <= 0 || $("#hud").hidden;
  hud.textContent = `Loading ${pending} more…`;
}

// ---------------- engine ----------------
async function bootEngine() {
  try {
    engineMessage("Loading three.js…");
    THREE = await import("three/webgpu");
    ({ GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"));
    ({ RGBELoader } = await import("three/addons/loaders/RGBELoader.js"));
  } catch (e) {
    engineMessage(`Could not load the 3D engine (${e.message}). Check your connection and reload.`, true);
    return false;
  }
  try {
    engineMessage(navigator.gpu ? "Starting WebGPU…" : "WebGPU is not available here; starting WebGL2…");
    // ?renderer=webgl forces the WebGL2 backend (used to test the fallback path).
    const forceWebGL = new URLSearchParams(location.search).get("renderer") === "webgl";
    renderer = new THREE.WebGPURenderer({ canvas: $("#scene"), antialias: true, forceWebGL });
    await renderer.init();
  } catch (e) {
    engineMessage(`This browser could not start WebGPU or WebGL2 (${e.message}).`, true);
    return false;
  }
  const backend = renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2 fallback";
  $("#backend").textContent = backend;
  engineMessage(`Engine ready · ${backend}${backend === "WebGPU" ? "" : " (this browser has no WebGPU)"}`);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1f);
  camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
  resetCamera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(4, 10, 6);
  scene.add(sun);
  exhibit = new THREE.Group();
  scene.add(exhibit);
  buildRoom();
  window.addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(tick);
  return true;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function resetCamera() {
  camera.position.set(0, EYE_HEIGHT, ROOM.length / 2 - 2);
  look.yaw = look.pitch = 0;
  view.yaw = view.pitch = 0;
  view.targetFov = view.fov = CAM.fov;
  velocity.x = velocity.z = 0;
}

function buildRoom() {
  const { width: W, length: L, height: H } = ROOM;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xefeae2, roughness: 0.9 });
  floorMat = new THREE.MeshStandardMaterial({ color: 0x8a6d4b, roughness: 0.7 });
  // Basic material: the ceiling stays white regardless of the HDRI's tint.
  const ceilingMat = new THREE.MeshBasicMaterial({ color: 0xe9e7e2 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, L), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H;
  scene.add(ceiling);
  for (const [w, h, x, y, z, ry] of [
    [W, H, 0, H / 2, -L / 2, 0],
    [W, H, 0, H / 2, L / 2, Math.PI],
    [L, H, -W / 2, H / 2, 0, Math.PI / 2],
    [L, H, W / 2, H / 2, 0, -Math.PI / 2],
  ]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    scene.add(m);
  }
  for (let z = -L / 2 + 4; z < L / 2; z += 8) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.6, 0.4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    strip.rotation.x = Math.PI / 2;
    strip.position.set(0, H - 0.01, z);
    scene.add(strip);
    const light = new THREE.PointLight(0xfff4e0, 18, 14, 1.6);
    light.position.set(0, H - 0.4, z);
    scene.add(light);
  }
}

// ---------------- textures and labels ----------------
function loadTexture(url) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  return withTimeout(new Promise((resolve, reject) => loader.load(url, resolve, undefined, () => reject(new Error("image failed")))), TIMEOUT.image, "image");
}

function wrapText(g, text, maxWidth) {
  const out = [];
  let line = "";
  for (const w of String(text).split(/\s+/)) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = w;
    } else line = test;
  }
  if (line) out.push(line);
  return out;
}

function labelTexture(lines) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#fbfaf7";
  g.fillRect(0, 0, c.width, c.height);
  let y = 46;
  lines.forEach(([text, size, color], i) => {
    g.font = `${i === 0 ? "600" : "400"} ${size}px system-ui, sans-serif`;
    g.fillStyle = color ?? "#222";
    for (const line of wrapText(g, text, c.width - 48).slice(0, i === 0 ? 2 : 1)) {
      g.fillText(line, 24, y);
      y += size + 10;
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function disposeObject(obj) {
  obj.traverse?.((o) => {
    o.geometry?.dispose?.();
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      m.map?.dispose?.();
      m.dispose?.();
    }
  });
}

function clearExhibit() {
  for (const obj of [...exhibit.children]) removeAndDispose(obj);
  clickable.length = 0;
  fading.length = 0;
  obstacles.length = 0;
  credits = [];
}

// ---------------- paintings ----------------
async function findPaintings(theme) {
  const seen = new Map();
  for (const query of [theme, `${theme} painting`, `${theme} art`, "painting"]) {
    if (seen.size >= SLOTS * 2) break;
    try {
      const r = await withTimeout(searchCommons(browserFetch, "image", { query, limit: 20, page: 1 }), TIMEOUT.search, "search");
      for (const a of r.assets) if (a.thumbnailUrl && !seen.has(a.id)) seen.set(a.id, a);
    } catch {
      /* try the next query */
    }
  }
  // Variety: at most two works per creator, so one uploader's photo series cannot fill the room.
  const perCreator = new Map();
  const varied = [];
  for (const a of seen.values()) {
    const key = (a.creator ?? "").toLowerCase();
    const n = perCreator.get(key) ?? 0;
    if (key && n >= 2) continue;
    perCreator.set(key, n + 1);
    varied.push(a);
  }
  return varied.slice(0, SLOTS);
}

/** Creates an empty frame for each slot right away; returns the slot groups. */
function placeFrames(assets) {
  const { width: W, length: L } = ROOM;
  const stepZ = (L - 6) / (SLOTS_PER_WALL - 1);
  return assets.map((asset, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const slot = Math.floor(i / 2);
    const group = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.06), new THREE.MeshStandardMaterial({ color: 0x3b2a1a, roughness: 0.5 }));
    const art = new THREE.Mesh(new THREE.PlaneGeometry(2.04, 1.44), new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 0.9 }));
    art.position.z = 0.032;
    group.add(frame, art);
    group.position.set(side * (W / 2 - 0.04), 2.1, -L / 2 + 3 + slot * stepZ);
    group.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
    group.userData = { pending: { asset, frame, art } };
    exhibit.add(group);
    return group;
  });
}

/**
 * Replaces a placeholder frame with the finished painting. WebGPURenderer keeps GPU buffers per
 * mesh, so a rendered mesh's geometry is never swapped or disposed in place: a new group is
 * built and the placeholder group is removed first, then disposed.
 */
async function fillFrame(placeholder, gen) {
  const { asset } = placeholder.userData.pending;
  let tex;
  try {
    tex = await loadTexture(largerThumb(asset.thumbnailUrl));
  } catch {
    if (gen === generation) removeAndDispose(placeholder);
    return false;
  }
  if (gen !== generation) {
    tex.dispose();
    return false;
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  const aspect = tex.image.width / tex.image.height;
  let h = PAINTING_MAX.h, w = h * aspect;
  if (w > PAINTING_MAX.w) {
    w = PAINTING_MAX.w;
    h = w / aspect;
  }
  const group = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.06), new THREE.MeshStandardMaterial({ color: 0x3b2a1a, roughness: 0.5 }));
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, transparent: true, opacity: 0 });
  const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  art.position.z = 0.032;
  art.userData.asset = asset;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(0.62, 0.31),
    new THREE.MeshBasicMaterial({
      map: labelTexture([
        [asset.title.replace(/\.(jpe?g|png|tiff?|gif|webp)$/i, ""), 30],
        [asset.creator ?? "Unknown creator", 22, "#555"],
        [asset.licenseEvidence.declaredBy === "uploader" ? "CC0 · declared by uploader" : "CC0", 22, "#0b6e4f"],
      ]),
    }),
  );
  label.position.set(w / 2 + 0.55, -h / 2 + 0.2, 0.01);
  group.add(frame, art, label);
  group.position.copy(placeholder.position);
  group.rotation.copy(placeholder.rotation);
  removeAndDispose(placeholder);
  exhibit.add(group);
  fading.push({ material: mat, t: 0 });
  clickable.push(art);
  credits.push({ role: "Painting", asset });
  return true;
}

/** Removes an object from the scene, then frees its GPU resources on the next frame. */
function removeAndDispose(obj) {
  exhibit.remove(obj);
  requestAnimationFrame(() => disposeObject(obj));
}

// ---------------- Poly Haven: floor, lighting, sculptures ----------------
async function loadFloor(gen) {
  const r = await withTimeout(searchPolyhaven(browserFetch, "texture", { query: "wood floor", limit: 3, page: 1 }), TIMEOUT.search, "search");
  const d = r.assets[0] && (await getPolyhaven(browserFetch, r.assets[0].id.split(":")[1]));
  const url = fileByLabel(d, /^Diffuse \/ 1k \/ jpg$/i) ?? fileByLabel(d, /diff.* \/ 1k \/ jpg$/i);
  if (!url) throw new Error("no floor texture");
  const tex = await loadTexture(url);
  if (gen !== generation) return tex.dispose();
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(ROOM.width / 2, ROOM.length / 2);
  floorMat.map?.dispose?.();
  floorMat.map = tex;
  floorMat.color.set(0xffffff);
  floorMat.needsUpdate = true;
  credits.push({ role: "Floor texture", asset: d });
}

async function loadLighting(gen) {
  const r = await withTimeout(searchPolyhaven(browserFetch, "hdri", { query: "museum interior", limit: 3, page: 1 }), TIMEOUT.search, "search");
  const d = r.assets[0] && (await getPolyhaven(browserFetch, r.assets[0].id.split(":")[1]));
  const url = fileByLabel(d, /^hdri \/ 1k \/ hdr$/i);
  if (!url) throw new Error("no HDRI");
  const hdr = await withTimeout(new RGBELoader().loadAsync(url), TIMEOUT.hdri, "HDRI");
  if (gen !== generation) return hdr.dispose();
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  // WebGPURenderer turns an equirectangular environment into a filtered environment map itself.
  scene.environment?.dispose?.();
  scene.environment = hdr;
  credits.push({ role: "Lighting (HDRI)", asset: d });
}

async function findSculptures(theme) {
  let r = await withTimeout(searchPolyhaven(browserFetch, "model", { query: theme, limit: SCULPTURES, page: 1 }), TIMEOUT.search, "search");
  if (r.assets.length < SCULPTURES) {
    const more = await withTimeout(searchPolyhaven(browserFetch, "model", { query: "statue", limit: SCULPTURES, page: 1 }), TIMEOUT.search, "search");
    r = { assets: [...r.assets, ...more.assets.filter((a) => !r.assets.some((b) => b.id === a.id))] };
  }
  return r.assets.slice(0, SCULPTURES);
}

/**
 * Poly Haven's glTF files reference textures by relative path (textures/x.jpg), but the files
 * live elsewhere; the /files API lists each one under "include" with its real URL.
 */
async function polyhavenGltf(slug) {
  const files = await (await browserFetch(`https://api.polyhaven.com/files/${encodeURIComponent(slug)}`)).json();
  const entry = files?.gltf?.["1k"]?.gltf;
  if (!entry?.url) throw new Error("no glTF");
  const include = Object.fromEntries(Object.entries(entry.include ?? {}).map(([path, f]) => [path, f.url]));
  return { url: entry.url, include };
}

async function placeSculpture(asset, index, gen) {
  const slug = asset.id.split(":")[1];
  const [d, gltfFiles] = await Promise.all([getPolyhaven(browserFetch, slug), polyhavenGltf(slug)]);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => {
    for (const [path, real] of Object.entries(gltfFiles.include)) if (u.endsWith(path)) return real;
    return u;
  });
  const gltf = await withTimeout(new GLTFLoader(manager).loadAsync(gltfFiles.url), TIMEOUT.model, "model");
  if (gen !== generation) return disposeObject(gltf.scene);
  const model = gltf.scene;
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  model.scale.setScalar(1.3 / Math.max(size.x, size.y, size.z));
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(center.x, box.min.y - 1, center.z));
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xf6f4ef, roughness: 0.6 }));
  pedestal.position.y = 0.5;
  const holder = new THREE.Group();
  holder.add(pedestal, model);
  holder.position.set(0, 0, [-ROOM.length / 4, 0, ROOM.length / 4][index]);
  obstacles.push({ x: holder.position.x, z: holder.position.z });
  holder.userData.asset = d;
  exhibit.add(holder);
  clickable.push(holder);
  credits.push({ role: "Sculpture (3D model)", asset: d });
}

// ---------------- ambient sound ----------------
let audio = null;
let audioAsset = null;
async function prepareAudio() {
  if (audio) return;
  try {
    const r = await withTimeout(searchOpenverse(browserFetch, "audio", { query: "ambience room tone", limit: 5, page: 1 }), TIMEOUT.search, "search");
    audioAsset = r.assets.find((x) => x.fileUrl) ?? null;
    if (!audioAsset) return;
    audio = new Audio(audioAsset.fileUrl);
    audio.loop = true;
    audio.volume = 0.35;
    audio.preload = "none";
    $("#btn-audio").hidden = false;
  } catch {
    /* sound is optional */
  }
}

// ---------------- exhibition flow ----------------
function showRoom() {
  $("#loading").hidden = true;
  $("#intro").hidden = true;
  $("#hud").hidden = false;
  $("#crosshair").hidden = isTouch;
  $("#joystick").hidden = !showJoystick;
  renderProgress();
}

async function openExhibition(rawTheme) {
  const theme = rawTheme.trim().slice(0, 60) || "art";
  const gen = ++generation;
  const params = new URLSearchParams(location.search);
  params.set("theme", theme);
  history.replaceState(null, "", `?${params}`);
  clearExhibit();
  resetCamera();
  resetProgress();
  $("#intro").hidden = true;
  $("#hud").hidden = true;
  $("#loading").hidden = false;
  $("#loading-title").textContent = `Preparing “${theme}”…`;
  $("#hud-title").textContent = `“${theme}”`;
  prepareAudio();

  // 1. Find works and lay out empty frames.
  step("search", "active");
  const [paintings, sculptures] = await Promise.all([findPaintings(theme), findSculptures(theme).catch(() => [])]);
  if (gen !== generation) return;
  if (!paintings.length) {
    step("search", "failed");
    $("#loading").hidden = true;
    $("#intro").hidden = false;
    engineMessage(`No CC0 images found for “${theme}”. Try another word.`, true);
    return;
  }
  step("search", "done");
  progress.total = 1 + 2 + paintings.length + sculptures.length;
  progress.paintings = [0, paintings.length];
  progress.sculptures = [0, sculptures.length];
  tickProgress();
  const frames = placeFrames(paintings);

  // 2. Floor and lighting.
  step("room", "active");
  const room = Promise.allSettled([loadFloor(gen), loadLighting(gen)]).then((rs) => {
    if (gen !== generation) return;
    tickProgress(2);
    step("room", rs.every((r) => r.status === "fulfilled") ? "done" : "failed");
    // The room is walkable now; offer to enter while paintings keep loading.
    if (!$("#loading").hidden) $("#enter").hidden = false;
  });

  // 3. Paintings fade in as they arrive.
  step("paintings", "active");
  let hung = 0;
  const hanging = Promise.all(
    frames.map((g) =>
      fillFrame(g, gen).then((ok) => {
        if (gen !== generation) return;
        if (ok) hung++;
        progress.paintings[0]++;
        tickProgress();
        $("#hud-title").textContent = `“${theme}” — ${hung} CC0 works`;
      }),
    ),
  ).then(() => gen === generation && step("paintings", hung ? "done" : "failed"));

  // 4. Sculptures.
  step("sculptures", sculptures.length ? "active" : "done");
  const placing = Promise.all(
    sculptures.map((a, i) =>
      placeSculpture(a, i, gen)
        .catch(() => {})
        .finally(() => {
          if (gen !== generation) return;
          progress.sculptures[0]++;
          tickProgress();
        }),
    ),
  ).then(() => gen === generation && sculptures.length && step("sculptures", "done"));

  await Promise.all([room, hanging, placing]);
  if (gen !== generation) return;
  renderProgress();
  if (!$("#loading").hidden) showRoom();
}

// ---------------- UI ----------------
function showInfo(asset) {
  const ev = asset.licenseEvidence;
  const body = $("#info-body");
  body.replaceChildren();
  const add = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    body.append(n);
    return n;
  };
  if (asset.thumbnailUrl) add("img", { src: largerThumb(asset.thumbnailUrl), alt: asset.title, referrerpolicy: "no-referrer", loading: "lazy" });
  add("h3", {}, asset.title);
  if (asset.creator) add("p", { class: "muted" }, asset.creator);
  add("div", { class: "evidence" }, `CC0 1.0 — ${ev.method === "whole-library-cc0" ? "the whole library is CC0" : "this item's own license field says CC0"}. Checked against: ${ev.source}`);
  if (ev.declaredBy === "uploader") add("p", { class: "warn" }, "Declared CC0 by the uploader; nobody reviewed it. Confirm the uploader owns the work before reusing it.");
  const p = add("p");
  const a = document.createElement("a");
  a.href = asset.landingUrl;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = "Open the source page ↗";
  p.append(a, ` · ${asset.servedBy}`);
  $("#info").hidden = false;
}

function renderCredits() {
  const list = $("#credits-list");
  list.replaceChildren();
  const all = [...credits, ...(audioAsset ? [{ role: "Ambient sound", asset: audioAsset }] : [])];
  for (const { role, asset } of all) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = asset.landingUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = asset.title;
    li.append(`${role}: `, a, ` — ${asset.creator ?? "unknown creator"} · ${asset.servedBy} · evidence: ${asset.licenseEvidence.source}`);
    list.append(li);
  }
}

for (const btn of document.querySelectorAll(".panel .close")) btn.addEventListener("click", () => (btn.closest(".panel").hidden = true));
$("#btn-credits").addEventListener("click", () => {
  renderCredits();
  $("#credits").hidden = false;
  document.exitPointerLock?.();
});
$("#btn-audio").addEventListener("click", () => {
  if (!audio) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});
$("#btn-menu").addEventListener("click", () => {
  document.exitPointerLock?.();
  $("#intro").hidden = false;
});
$("#enter").addEventListener("click", showRoom);
$("#theme-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (renderer) openExhibition($("#theme").value);
});

// ---------------- controls ----------------
// Input only moves a *target*; the frame loop eases the camera toward it, so mouse, touch and
// keyboard all feel smooth. Movement accelerates and decelerates instead of starting and
// stopping instantly.
const CAM = {
  mouseSensitivity: 0.0019, // radians per pixel
  touchSensitivity: 0.0045,
  dragSensitivity: 0.0032, // desktop drag-to-look without pointer lock
  maxEventDelta: 120, // px; pointer lock occasionally reports huge spikes
  lookEase: 24, // 1/s; higher = snappier
  pitchLimit: 1.35,
  walkSpeed: 3.0, // m/s
  sprintFactor: 1.8, // Shift
  accel: 12, // 1/s toward the wanted velocity
  decel: 9,
  touchInertiaDecay: 6, // 1/s
  bobHeight: 0.028, // m
  bobStride: 1.5, // m per bob cycle
  fov: 70,
  fovMin: 35,
  fovMax: 80,
  fovEase: 10,
  wallMargin: 0.6,
  pedestalRadius: 1.1,
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const canvas = $("#scene");
const keys = new Set();
/** Joystick deflection: x = strafe right, y = forward; each in [-1, 1]. */
const joy = { x: 0, y: 0 };
const view = { yaw: 0, pitch: 0, fov: CAM.fov, targetFov: CAM.fov };
const velocity = { x: 0, z: 0 };
const touchInertia = { yaw: 0, pitch: 0 };
let walked = 0;
/** Pedestal centers (x, z) the camera must not walk through; filled as sculptures are placed. */
const obstacles = [];

const clampDelta = (d) => Math.max(-CAM.maxEventDelta, Math.min(CAM.maxEventDelta, d));
function turn(dx, dy, sensitivity) {
  look.yaw -= clampDelta(dx) * sensitivity;
  look.pitch = Math.max(-CAM.pitchLimit, Math.min(CAM.pitchLimit, look.pitch - clampDelta(dy) * sensitivity));
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

const roomActive = () => renderer && $("#intro").hidden && $("#loading").hidden;

// Desktop: drag to look without locking the mouse; a click that did not drag picks or locks.
let drag = null;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !roomActive() || document.pointerLockElement === canvas) return;
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
});
window.addEventListener("mouseup", () => setTimeout(() => (drag = null), 0));
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement === canvas) return turn(e.movementX, e.movementY, CAM.mouseSensitivity);
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  // Dragging moves the scene with the pointer (like Street View): the opposite of mouse-look.
  turn(-dx, -dy, CAM.dragSensitivity);
});

canvas.addEventListener("click", (e) => {
  if (!roomActive()) return;
  if (drag && drag.moved > 6) return; // that was a drag, not a click
  const locked = document.pointerLockElement === canvas;
  // Locked: pick what the crosshair points at. Unlocked or touch: pick under the pointer,
  // and on desktop lock the mouse when the click hits no artwork.
  if (pick(locked ? null : e)) return;
  if (!isTouch && !locked) canvas.requestPointerLock?.();
});

// Mouse wheel / trackpad: zoom by narrowing the field of view, to look closer at a painting.
canvas.addEventListener("wheel", (e) => {
  if (!roomActive()) return;
  e.preventDefault();
  view.targetFov = Math.max(CAM.fovMin, Math.min(CAM.fovMax, view.targetFov + e.deltaY * 0.03));
}, { passive: false });

// Touch: drag to look, with a little inertia after the finger lifts. Only the finger that
// started on the canvas turns the view, so a second finger on the joystick does not.
let lastTouch = null;
canvas.addEventListener("touchstart", (e) => {
  if (lastTouch) return;
  const t = e.changedTouches[0];
  lastTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
  touchInertia.yaw = touchInertia.pitch = 0;
}, { passive: true });
canvas.addEventListener("touchmove", (e) => {
  if (!lastTouch) return;
  const t = [...e.touches].find((x) => x.identifier === lastTouch.id);
  if (!t) return;
  const dx = t.clientX - lastTouch.x, dy = t.clientY - lastTouch.y;
  // The scene follows the finger, as with drag on desktop.
  turn(-dx, -dy, CAM.touchSensitivity);
  touchInertia.yaw = clampDelta(dx) * CAM.touchSensitivity * 30;
  touchInertia.pitch = clampDelta(dy) * CAM.touchSensitivity * 30;
  lastTouch.x = t.clientX;
  lastTouch.y = t.clientY;
}, { passive: true });
const endTouch = (e) => {
  if (lastTouch && [...e.changedTouches].some((t) => t.identifier === lastTouch.id)) lastTouch = null;
};
canvas.addEventListener("touchend", endTouch, { passive: true });
canvas.addEventListener("touchcancel", endTouch, { passive: true });

// Virtual joystick (pointer events, so it also works with a mouse when forced on).
// Deflection is analog: a small push walks slowly, a full push walks at full speed.
const JOYSTICK = { radius: 46, deadZone: 0.12 };
const stick = $("#joystick");
const knob = $("#joystick-knob");
let joyPointer = null;
function setJoystick(clientX, clientY) {
  const r = stick.getBoundingClientRect();
  let dx = clientX - (r.left + r.width / 2), dy = clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy);
  if (d > JOYSTICK.radius) {
    dx *= JOYSTICK.radius / d;
    dy *= JOYSTICK.radius / d;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const nx = dx / JOYSTICK.radius, ny = -dy / JOYSTICK.radius;
  const m = Math.hypot(nx, ny);
  // Rescale past the dead zone so movement starts smoothly from zero.
  const scale = m < JOYSTICK.deadZone ? 0 : (m - JOYSTICK.deadZone) / (1 - JOYSTICK.deadZone) / m;
  joy.x = nx * scale;
  joy.y = ny * scale;
}
function releaseJoystick() {
  joyPointer = null;
  joy.x = joy.y = 0;
  knob.style.transform = "";
  stick.classList.remove("active");
}
stick.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  joyPointer = e.pointerId;
  try {
    stick.setPointerCapture(e.pointerId); // keep receiving moves when the finger leaves the circle
  } catch {
    /* capture can fail for synthetic or already-released pointers; moves on the stick still work */
  }
  stick.classList.add("active");
  setJoystick(e.clientX, e.clientY);
});
stick.addEventListener("pointermove", (e) => {
  if (e.pointerId === joyPointer) setJoystick(e.clientX, e.clientY);
});
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
  stick.addEventListener(ev, (e) => {
    if (e.pointerId === joyPointer) releaseJoystick();
  });
}
window.addEventListener("blur", releaseJoystick);

let raycaster;
function pick(e) {
  raycaster ??= new THREE.Raycaster();
  const ndc = e ? new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1) : new THREE.Vector2(0, 0);
  raycaster.setFromCamera(ndc, camera);
  let o = raycaster.intersectObjects(clickable, true)[0]?.object;
  while (o && !o.userData.asset) o = o.parent;
  if (!o?.userData.asset) return false;
  document.exitPointerLock?.();
  showInfo(o.userData.asset);
  return true;
}

// ---------------- frame loop ----------------
/** Frame-rate independent easing factor for a rate in 1/s. */
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

function updateCamera(dt) {
  // Touch inertia keeps turning briefly after the finger lifts.
  if (!lastTouch && (touchInertia.yaw || touchInertia.pitch)) {
    look.yaw += touchInertia.yaw * dt;
    look.pitch = Math.max(-CAM.pitchLimit, Math.min(CAM.pitchLimit, look.pitch + touchInertia.pitch * dt));
    const k = Math.exp(-CAM.touchInertiaDecay * dt);
    touchInertia.yaw = Math.abs(touchInertia.yaw * k) < 1e-3 ? 0 : touchInertia.yaw * k;
    touchInertia.pitch = Math.abs(touchInertia.pitch * k) < 1e-3 ? 0 : touchInertia.pitch * k;
  }
  // Ease the view toward the look target.
  const a = ease(CAM.lookEase, dt);
  view.yaw += (look.yaw - view.yaw) * a;
  view.pitch += (look.pitch - view.pitch) * a;
  view.fov += (view.targetFov - view.fov) * ease(CAM.fovEase, dt);
  if (Math.abs(camera.fov - view.fov) > 0.01) {
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }

  // Wanted velocity from input, relative to where the camera faces.
  let f = joy.y, s = joy.x;
  if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) s += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) s -= 1;
  // Direction from input, magnitude capped at 1: keys walk at full speed, the joystick is analog.
  const mag = Math.hypot(f, s);
  const amount = Math.min(1, mag) / (mag || 1);
  const speed = CAM.walkSpeed * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? CAM.sprintFactor : 1);
  const sin = Math.sin(view.yaw), cos = Math.cos(view.yaw);
  const wantX = (-sin * f + cos * s) * amount * speed;
  const wantZ = (-cos * f - sin * s) * amount * speed;
  const k = ease(f || s ? CAM.accel : CAM.decel, dt);
  velocity.x += (wantX - velocity.x) * k;
  velocity.z += (wantZ - velocity.z) * k;
  if (Math.hypot(velocity.x, velocity.z) < 0.01) velocity.x = velocity.z = 0;

  const p = camera.position;
  p.x += velocity.x * dt;
  p.z += velocity.z * dt;
  // Slide along walls and around pedestals instead of stopping dead.
  p.x = Math.max(-ROOM.width / 2 + CAM.wallMargin, Math.min(ROOM.width / 2 - CAM.wallMargin, p.x));
  p.z = Math.max(-ROOM.length / 2 + CAM.wallMargin, Math.min(ROOM.length / 2 - CAM.wallMargin, p.z));
  for (const o of obstacles) {
    const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
    if (d < CAM.pedestalRadius) {
      const push = (CAM.pedestalRadius - d) / (d || 1);
      p.x += dx * push;
      p.z += dz * push;
    }
  }

  // Gentle head bob while walking (off for reduced motion).
  const moving = Math.hypot(velocity.x, velocity.z);
  walked += moving * dt;
  const bob = reducedMotion ? 0 : Math.sin((walked / CAM.bobStride) * Math.PI * 2) * CAM.bobHeight * Math.min(1, moving / CAM.walkSpeed);
  p.y = EYE_HEIGHT + bob;
  camera.rotation.set(view.pitch, view.yaw, 0, "YXZ");
}

let last = performance.now();
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  updateCamera(dt);
  for (let i = fading.length - 1; i >= 0; i--) {
    const item = fading[i];
    item.t += dt / FADE_SECONDS;
    item.material.opacity = Math.min(1, item.t);
    if (item.t >= 1) {
      item.material.transparent = false;
      item.material.needsUpdate = true;
      fading.splice(i, 1);
    }
  }
  renderer.render(scene, camera);
}

// ---------------- boot ----------------
(async () => {
  const ok = await bootEngine();
  const open = $("#open");
  open.textContent = ok ? "Open exhibition" : "Unavailable";
  open.disabled = !ok;
  if (!ok) return;
  const initial = new URLSearchParams(location.search).get("theme");
  if (initial) {
    $("#theme").value = initial;
    openExhibition(initial);
  }
})();
