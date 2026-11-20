// CC0 Museum: a walkable 3D gallery generated from CC0 assets at runtime.
// Paintings: Wikimedia Commons files whose own license is CC0 (via lib/providers/commons.js).
// Floor texture, lighting HDRI and sculptures: Poly Haven (whole library CC0).
// Ambient sound: an Openverse audio result whose own license is CC0.
// Every asset placed in the room is listed in the Credits panel with its license evidence.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { searchCommons } from "./lib/providers/commons.js";
import { searchPolyhaven, getPolyhaven } from "./lib/providers/polyhaven.js";
import { searchOpenverse } from "./lib/providers/openverse.js";

const browserFetch = (url, init) => fetch(url, { headers: { Accept: "application/json", ...init?.headers } });

// Room size in meters. Paintings hang on the two long walls.
const ROOM = { width: 14, length: 36, height: 6 };
const SLOTS_PER_WALL = 8;
const EYE_HEIGHT = 1.65;
const WALK_SPEED = 3.2; // m/s
const PAINTING_MAX = { w: 3, h: 2.2 };

const $ = (s) => document.querySelector(s);
const status = (t) => ($("#status").textContent = t);

// ---------------- renderer, scene, camera ----------------
const canvas = $("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1f);
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
camera.position.set(0, EYE_HEIGHT, ROOM.length / 2 - 2);
const look = { yaw: 0, pitch: 0 };

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(4, 10, 6);
scene.add(sun);

const exhibit = new THREE.Group(); // everything that changes with the theme
scene.add(exhibit);
const clickable = [];
let credits = [];

// ---------------- static room ----------------
const wallMat = new THREE.MeshStandardMaterial({ color: 0xefeae2, roughness: 0.9 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x8a6d4b, roughness: 0.7 });
// Basic material: the ceiling should stay white regardless of the HDRI's tint.
const ceilingMat = new THREE.MeshBasicMaterial({ color: 0xe9e7e2 });

function buildRoom() {
  const { width: W, length: L, height: H } = ROOM;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, L), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = H;
  scene.add(ceiling);
  const walls = [
    [W, H, 0, H / 2, -L / 2, 0],
    [W, H, 0, H / 2, L / 2, Math.PI],
    [L, H, -W / 2, H / 2, 0, Math.PI / 2],
    [L, H, W / 2, H / 2, 0, -Math.PI / 2],
  ];
  for (const [w, h, x, y, z, ry] of walls) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    scene.add(m);
  }
  // Ceiling light strips: emissive panels plus soft point lights.
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
buildRoom();

// ---------------- helpers ----------------
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin("anonymous");

function loadTexture(url) {
  return new Promise((resolve, reject) => texLoader.load(url, resolve, undefined, reject));
}

/** Wikimedia serves thumbnails only at standard widths (330, 500, 960, 1280); use 960px for the walls. */
const largerThumb = (u) => (u ? u.replace(/\/(\d+)px-/, "/960px-") : u);

function labelTexture(lines) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#fbfaf7";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#222";
  let y = 46;
  lines.forEach(([text, size, color], i) => {
    g.font = `${i === 0 ? "600" : "400"} ${size}px system-ui, sans-serif`;
    g.fillStyle = color ?? "#222";
    for (const line of wrap(g, text, c.width - 48).slice(0, i === 0 ? 2 : 1)) {
      g.fillText(line, 24, y);
      y += size + 10;
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function wrap(g, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = w;
    } else line = test;
  }
  if (line) out.push(line);
  return out;
}

function addCredit(role, asset) {
  credits.push({ role, asset });
}

function clearExhibit() {
  for (const obj of [...exhibit.children]) {
    exhibit.remove(obj);
    obj.traverse?.((o) => {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
  }
  clickable.length = 0;
  credits = [];
}

// ---------------- paintings ----------------
async function findPaintings(theme) {
  const seen = new Map();
  for (const query of [theme, `${theme} painting`, `${theme} art`, "painting"]) {
    if (seen.size >= SLOTS_PER_WALL * 4) break;
    try {
      const r = await searchCommons(browserFetch, "image", { query, limit: 20, page: 1 });
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
  return varied.slice(0, SLOTS_PER_WALL * 2);
}

async function hangPaintings(assets) {
  const { width: W, length: L } = ROOM;
  const step = (L - 6) / (SLOTS_PER_WALL - 1);
  let placed = 0;
  await Promise.all(
    assets.map(async (asset, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const slot = Math.floor(i / 2);
      let tex;
      try {
        tex = await loadTexture(largerThumb(asset.thumbnailUrl));
      } catch {
        return; // image failed to load; leave the slot empty
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
      const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
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
      const z = -L / 2 + 3 + slot * step;
      group.position.set(side * (W / 2 - 0.04), 2.1, z);
      group.rotation.y = side === -1 ? Math.PI / 2 : -Math.PI / 2;
      exhibit.add(group);
      clickable.push(art);
      addCredit("Painting", asset);
      placed++;
    }),
  );
  return placed;
}

// ---------------- Poly Haven floor, HDRI, sculptures ----------------
const fileByLabel = (detail, re) => detail?.files.find((f) => re.test(f.label))?.url;

async function dressRoom(theme) {
  const tasks = [];
  // Floor texture
  tasks.push(
    (async () => {
      const r = await searchPolyhaven(browserFetch, "texture", { query: "wood floor", limit: 3, page: 1 });
      const d = r.assets[0] && (await getPolyhaven(browserFetch, r.assets[0].id.split(":")[1]));
      const url = fileByLabel(d, /^Diffuse \/ 1k \/ jpg$/i) ?? fileByLabel(d, /diff.* \/ 1k \/ jpg$/i);
      if (!url) return;
      const tex = await loadTexture(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(ROOM.width / 2, ROOM.length / 2);
      floorMat.map = tex;
      floorMat.color.set(0xffffff);
      floorMat.needsUpdate = true;
      addCredit("Floor texture", d);
    })(),
  );
  // Lighting HDRI
  tasks.push(
    (async () => {
      const r = await searchPolyhaven(browserFetch, "hdri", { query: "museum interior", limit: 3, page: 1 });
      const d = r.assets[0] && (await getPolyhaven(browserFetch, r.assets[0].id.split(":")[1]));
      const url = fileByLabel(d, /^hdri \/ 1k \/ hdr$/i);
      if (!url) return;
      const hdr = await new RGBELoader().loadAsync(url);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      pmrem.dispose();
      addCredit("Lighting (HDRI)", d);
    })(),
  );
  // Sculptures on pedestals along the center line
  tasks.push(
    (async () => {
      let r = await searchPolyhaven(browserFetch, "model", { query: theme, limit: 3, page: 1 });
      if (r.assets.length < 3) {
        const more = await searchPolyhaven(browserFetch, "model", { query: "statue", limit: 3, page: 1 });
        r = { assets: [...r.assets, ...more.assets.filter((a) => !r.assets.some((b) => b.id === a.id))] };
      }
      const loader = new GLTFLoader();
      const zs = [-ROOM.length / 4, 0, ROOM.length / 4];
      await Promise.all(
        r.assets.slice(0, 3).map(async (asset, i) => {
          const d = await getPolyhaven(browserFetch, asset.id.split(":")[1]);
          const url = fileByLabel(d, /^gltf \/ 1k \/ gltf$/i);
          if (!url) return;
          const gltf = await loader.loadAsync(url);
          const model = gltf.scene;
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const scale = 1.3 / Math.max(size.x, size.y, size.z);
          model.scale.setScalar(scale);
          const box2 = new THREE.Box3().setFromObject(model);
          const center = box2.getCenter(new THREE.Vector3());
          model.position.sub(new THREE.Vector3(center.x, box2.min.y, center.z));
          const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xf6f4ef, roughness: 0.6 }));
          pedestal.position.y = 0.5;
          const holder = new THREE.Group();
          model.position.y += 1;
          holder.add(pedestal, model);
          holder.position.set(0, 0, zs[i]);
          model.traverse((o) => {
            if (o.isMesh) o.userData.asset = d;
          });
          pedestal.userData.asset = d;
          clickable.push(pedestal, ...model.children);
          exhibit.add(holder);
          addCredit("Sculpture (3D model)", d);
        }),
      );
    })(),
  );
  await Promise.allSettled(tasks);
}

// ---------------- ambient sound ----------------
let audio = null;
async function prepareAudio() {
  if (audio) return;
  try {
    const r = await searchOpenverse(browserFetch, "audio", { query: "ambience room tone", limit: 5, page: 1 });
    const a = r.assets.find((x) => x.fileUrl);
    if (!a) return;
    audio = new Audio(a.fileUrl);
    audio.loop = true;
    audio.volume = 0.35;
    audio.dataset.asset = JSON.stringify(a);
    $("#btn-audio").hidden = false;
  } catch {
    /* sound is optional */
  }
}

// ---------------- UI panels ----------------
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
  if (asset.thumbnailUrl) add("img", { src: largerThumb(asset.thumbnailUrl), alt: asset.title, referrerpolicy: "no-referrer" });
  add("h3", {}, asset.title);
  if (asset.creator) add("p", { class: "muted" }, asset.creator);
  const evidence = add("div", { class: "evidence" });
  evidence.textContent = `CC0 1.0 — ${ev.method === "whole-library-cc0" ? "the whole library is CC0" : "this item's own license field says CC0"}. Checked against: ${ev.source}`;
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
  const all = [...credits];
  if (audio?.dataset.asset) all.push({ role: "Ambient sound", asset: JSON.parse(audio.dataset.asset) });
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

// ---------------- open an exhibition ----------------
let busy = false;
async function openExhibition(theme) {
  if (busy) return;
  busy = true;
  theme = theme.trim().slice(0, 60) || "art";
  history.replaceState(null, "", `?theme=${encodeURIComponent(theme)}`);
  clearExhibit();
  status(`Collecting CC0 works for “${theme}”…`);
  const [paintings] = await Promise.all([findPaintings(theme), dressRoom(theme), prepareAudio()]);
  status(`Hanging ${paintings.length} paintings…`);
  const placed = await hangPaintings(paintings);
  $("#hud-title").textContent = `“${theme}” — ${placed} CC0 paintings`;
  status(placed ? "" : "No CC0 paintings found for this theme. Try another word.");
  camera.position.set(0, EYE_HEIGHT, ROOM.length / 2 - 2);
  look.yaw = 0;
  look.pitch = 0;
  busy = false;
  if (placed) {
    $("#intro").hidden = true;
    $("#hud").hidden = false;
    $("#crosshair").hidden = isTouch;
    $("#touch-move").hidden = !isTouch;
  }
}

$("#theme-form").addEventListener("submit", (e) => {
  e.preventDefault();
  openExhibition($("#theme").value);
});

// ---------------- controls ----------------
const isTouch = matchMedia("(hover: none) and (pointer: coarse)").matches;
const keys = new Set();
let touchMove = 0;
window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));

canvas.addEventListener("click", (e) => {
  if (!$("#intro").hidden) return;
  const locked = document.pointerLockElement === canvas;
  // Locked: pick what the crosshair points at. Unlocked or touch: pick under the pointer,
  // and on desktop lock the mouse when the click hits no artwork.
  if (pick(locked ? null : e)) return;
  if (!isTouch && !locked) canvas.requestPointerLock();
});

document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  look.yaw -= e.movementX * 0.0022;
  look.pitch = THREE.MathUtils.clamp(look.pitch - e.movementY * 0.0022, -1.2, 1.2);
});

let lastTouch = null;
canvas.addEventListener("touchstart", (e) => (lastTouch = e.touches[0]), { passive: true });
canvas.addEventListener("touchmove", (e) => {
  const t = e.touches[0];
  if (lastTouch) {
    look.yaw -= (t.clientX - lastTouch.clientX) * 0.005;
    look.pitch = THREE.MathUtils.clamp(look.pitch - (t.clientY - lastTouch.clientY) * 0.005, -1.2, 1.2);
  }
  lastTouch = t;
}, { passive: true });
for (const [id, dir] of [["#fwd", 1], ["#back", -1]]) {
  const b = $(id);
  b.addEventListener("pointerdown", () => (touchMove = dir));
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => (touchMove = 0));
}

const raycaster = new THREE.Raycaster();
function pick(e) {
  const ndc = e ? new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1) : new THREE.Vector2(0, 0);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(clickable, true)[0];
  let o = hit?.object;
  while (o && !o.userData.asset) o = o.parent;
  if (!o?.userData.asset) return false;
  document.exitPointerLock?.();
  showInfo(o.userData.asset);
  return true;
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  camera.rotation.set(look.pitch, look.yaw, 0, "YXZ");
  let f = touchMove, s = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) s += 1;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) s -= 1;
  if (f || s) {
    forward.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
    right.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));
    camera.position.addScaledVector(forward, f * WALK_SPEED * dt).addScaledVector(right, s * WALK_SPEED * dt);
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -ROOM.width / 2 + 0.6, ROOM.width / 2 - 0.6);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -ROOM.length / 2 + 0.6, ROOM.length / 2 - 0.6);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

const initial = new URLSearchParams(location.search).get("theme");
if (initial) {
  $("#theme").value = initial;
  openExhibition(initial);
}
