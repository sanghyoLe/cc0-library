// Browser gallery. Uses the same search code as the MCP server (src/search.ts,
// copied to ./lib at build time by scripts/build-site.mjs).
import { search, getAsset } from "./lib/search.js";

const PAGE_SIZE = 12;
/** ambientCG sends no CORS headers; Cleveland's detail endpoint does not either. */
const SKIP = ["ambientcg"];
/** Providers whose CC0 label is set by whoever uploaded the item. */
const UPLOADER_PROVIDERS = ["openverse", "commons", "archive", "sketchfab", "wpphotos"];
const DECLARED = {
  library: "Declared CC0 by the studio that made it.",
  institution: "Declared CC0 by the museum that holds the work.",
  uploader: "Declared CC0 by the uploader. Nobody reviewed this claim: make sure the uploader actually owns the work before you ship it.",
};
const NO_DETAIL_FETCH = new Set(["cleveland"]);

const KINDS = [
  ["any", "All"], ["image", "Images"], ["audio", "Audio"], ["video", "Video"],
  ["hdri", "HDRIs"], ["texture", "Textures"], ["model", "3D models"], ["artwork", "Artworks"],
];
const PROVIDER_NAMES = {
  openverse: "Openverse", polyhaven: "Poly Haven", ambientcg: "ambientCG", cleveland: "Cleveland Museum",
  met: "The Met", commons: "Wikimedia Commons", archive: "Internet Archive", sketchfab: "Sketchfab", wpphotos: "WordPress Photos",
};

// Browsers may not send a custom User-Agent; Accept is CORS-safelisted.
const browserFetch = (url) => fetch(url, { headers: { Accept: "application/json" } });

const $ = (sel) => document.querySelector(sel);
const state = { q: "", kind: "any", page: 1, seen: new Set(), loading: false, strict: false };

/** Only http(s) URLs from upstream data may reach href/src. */
function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "href" || k === "src") {
      const u = safeUrl(v);
      if (u) node.setAttribute(k, u);
    } else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${name}`;
  if (name === "sources") loadSources();
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ---------- kinds ----------
function renderKinds() {
  const box = $("#kinds");
  box.replaceChildren(
    ...KINDS.map(([value, label]) =>
      el("button", {
        type: "button", role: "radio", "aria-checked": String(state.kind === value),
        onclick: () => { state.kind = value; renderKinds(); if (state.q) runSearch(true); },
      }, label),
    ),
  );
}

// ---------- search ----------
async function runSearch(reset) {
  if (state.loading) return;
  if (reset) {
    state.page = 1;
    state.seen.clear();
    $("#grid").replaceChildren();
    const params = new URLSearchParams({ q: state.q });
    if (state.kind !== "any") params.set("kind", state.kind);
    if (state.strict) params.set("strict", "1");
    history.replaceState(null, "", `?${params}`);
  }
  state.loading = true;
  $("#more").hidden = true;
  $("#status").textContent = reset ? `Searching for “${state.q}”…` : "Loading more…";
  try {
    const r = await search(browserFetch, state.q, state.kind, PAGE_SIZE, state.page, { skip: state.strict ? [...SKIP, ...UPLOADER_PROVIDERS] : SKIP });
    const fresh = r.assets.filter((a) => !state.seen.has(a.id));
    fresh.forEach((a) => state.seen.add(a.id));
    $("#grid").append(...fresh.map(card));
    const shown = state.seen.size;
    const sources = new Set([...state.seen].map((id) => id.split(":")[0])).size;
    $("#status").textContent = shown
      ? `${shown} CC0 result${shown === 1 ? "" : "s"} from ${sources} source${sources === 1 ? "" : "s"}.`
      : "No CC0 results. Try a broader word or another type.";
    $("#more").hidden = r.assets.length === 0 || state.page >= 12;
    renderErrors(r.errors);
  } catch (e) {
    $("#status").textContent = `Search failed: ${e.message}`;
  } finally {
    state.loading = false;
  }
}

function renderErrors(errors) {
  const box = $("#errors");
  box.hidden = errors.length === 0;
  box.querySelector("ul").replaceChildren(...errors.map((e) => el("li", {}, e)));
}

function card(a) {
  let media;
  if (a.kind === "audio") {
    media = el("div", { class: "thumb" }, el("span", { class: "ph" }, "audio"));
  } else if (a.thumbnailUrl) {
    media = el("button", { class: "thumb", type: "button", "aria-label": `Details: ${a.title}`, onclick: () => openDetail(a) },
      el("img", { src: a.thumbnailUrl, alt: a.title, loading: "lazy", referrerpolicy: "no-referrer" }));
  } else {
    media = el("button", { class: "thumb", type: "button", onclick: () => openDetail(a) }, el("span", { class: "ph" }, a.kind));
  }
  return el("article", { class: "card" },
    media,
    a.kind === "audio" && a.fileUrl ? el("audio", { controls: true, preload: "none", src: a.fileUrl }) : null,
    el("div", { class: "meta" },
      el("div", { class: "title", title: a.title }, a.title),
      a.creator ? el("div", { class: "by" }, a.creator) : null,
      el("div", { class: "row" },
        el("a", {
          class: a.licenseEvidence.declaredBy === "uploader" ? "cc0 uploader" : "cc0",
          href: "#", title: DECLARED[a.licenseEvidence.declaredBy],
          onclick: (e) => { e.preventDefault(); openDetail(a); },
        }, a.licenseEvidence.declaredBy === "uploader" ? "CC0 · uploader" : "CC0 ✓"),
        el("span", { class: "badge" }, PROVIDER_NAMES[a.provider] ?? a.provider),
        el("span", { class: "badge" }, a.kind),
      ),
    ),
  );
}

// ---------- detail ----------
async function openDetail(a) {
  const body = $("#detail-body");
  const evidence = el("div", { class: "evidence" },
    el("strong", {}, "CC0 1.0 evidence: "), a.licenseEvidence.method === "whole-library-cc0" ? "the whole library is CC0. " : "this item's own license field says CC0. ",
    el("br"), "Checked against: ", a.licenseEvidence.source,
    el("br"), el("span", { class: a.licenseEvidence.declaredBy === "uploader" ? "warn" : "" }, DECLARED[a.licenseEvidence.declaredBy]));
  let preview = null;
  if (a.kind === "video" && a.fileUrl) preview = el("video", { controls: true, preload: "metadata", src: a.fileUrl });
  else if (a.kind === "audio" && a.fileUrl) preview = el("audio", { controls: true, src: a.fileUrl });
  else if (a.thumbnailUrl) preview = el("img", { src: a.thumbnailUrl, alt: a.title, referrerpolicy: "no-referrer" });
  const files = el("ul", { class: "files" }, el("li", { class: "muted" }, "Loading files…"));
  body.replaceChildren(
    el("h3", {}, a.title),
    a.creator ? el("p", { class: "muted" }, a.creator) : null,
    preview,
    evidence,
    el("p", {}, el("a", { href: a.landingUrl, target: "_blank", rel: "noopener" }, "Open source page ↗"), " · ", el("span", { class: "muted" }, a.servedBy)),
    el("h4", {}, "Files"),
    files,
  );
  $("#detail").showModal();

  let list = [];
  try {
    if (NO_DETAIL_FETCH.has(a.provider)) {
      list = a.fileUrl ? [{ label: "image", url: a.fileUrl, sizeBytes: null }] : [];
    } else {
      const d = await getAsset(browserFetch, a.id);
      list = d ? d.files : [];
      if (!d) files.replaceChildren(el("li", {}, "The source no longer reports this item as CC0."));
    }
  } catch (e) {
    files.replaceChildren(el("li", {}, `Could not load files (${e.message}). Use the source page.`));
    return;
  }
  if (list.length) {
    files.replaceChildren(...list.slice(0, 40).map((f) =>
      el("li", {}, el("a", { href: f.url, target: "_blank", rel: "noopener" }, f.label), f.sizeBytes ? ` — ${formatBytes(f.sizeBytes)}` : "")));
  } else if (files.textContent.startsWith("Loading")) {
    files.replaceChildren(el("li", {}, "No direct files. Download from the source page."));
  }
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

// ---------- sources tab ----------
let sourcesLoaded = false;
async function loadSources() {
  if (sourcesLoaded) return;
  sourcesLoaded = true;
  const c = await (await fetch("catalog/sources.json")).json();
  $("#sources-table tbody").replaceChildren(...c.sources.map((s) =>
    el("tr", {},
      el("td", {}, el("a", { href: s.url, target: "_blank", rel: "noopener" }, s.name)),
      el("td", {}, s.kinds.join(", ")),
      el("td", {}, s.scope === "whole-library" ? "Whole library" : "Filter only"),
      el("td", {}, s.searchable ? "Yes" : "—"),
      el("td", {}, el("a", { href: s.licensePage, target: "_blank", rel: "noopener" }, "license"), ` · ${s.verified.date} · ${s.verified.evidence}`),
    )));
  $("#excluded").replaceChildren(...c.excluded.map((e) => el("li", {}, el("strong", {}, e.name), ` — ${e.reason}`)));
  $("#pending").replaceChildren(...c.pending.map((e) => el("li", {}, el("strong", {}, e.name), ` — ${e.reason}`)));
}

// ---------- copy buttons ----------
for (const b of document.querySelectorAll(".copy")) {
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select & copy";
    }
    setTimeout(() => (b.textContent = "Copy"), 1500);
  });
}

// ---------- boot ----------
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.q = $("#q").value.trim();
  if (state.q) runSearch(true);
});
$("#strict").addEventListener("change", (e) => { state.strict = e.target.checked; if (state.q) runSearch(true); });
$("#more").addEventListener("click", () => { state.page += 1; runSearch(false); });

const params = new URLSearchParams(location.search);
const k = params.get("kind");
if (KINDS.some(([v]) => v === k)) state.kind = k;
state.strict = params.get("strict") === "1";
$("#strict").checked = state.strict;
renderKinds();
if (params.get("q")) {
  state.q = params.get("q").slice(0, 200);
  $("#q").value = state.q;
  runSearch(true);
}
