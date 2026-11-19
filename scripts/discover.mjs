// Weekly source check. Prints a Markdown report to stdout; the workflow
// .github/workflows/discover.yml posts it to a GitHub issue.
//
// 1. Re-check: fetch every catalog licensePage and report pages that are
//    unreachable or no longer mention CC0. A human decides what to do.
// 2. Discover: list the sources Openverse indexes, count CC0 items per source,
//    and report sources with CC0 items that the catalog does not list yet.
//    These are candidates only: CC0 status still has to be verified on each
//    source's own license page before it enters catalog/sources.json.
//
// Usage: node scripts/discover.mjs [--skip-discover] [--skip-recheck]
import { readFileSync } from "node:fs";

const UA = "cc0-library-discover (+https://github.com/sanghyoLe/cc0-library)";
const CC0_TEXT = /CC0|CC-0|Creative Commons Zero|publicdomain\/zero/i;
/** Openverse anonymous clients are rate limited; stop discovery after this many calls. */
const MAX_OPENVERSE_CALLS = 60;
const TIMEOUT_MS = 20_000;

const args = new Set(process.argv.slice(2));
const catalog = JSON.parse(readFileSync(new URL("../catalog/sources.json", import.meta.url), "utf8"));

async function get(url, accept = "*/*") {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
    return { status: res.status, text: res.ok ? await res.text() : "" };
  } catch (e) {
    return { status: 0, text: "", error: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

/** Parses JSON; returns null when a site answers with HTML (e.g. a bot-protection page). */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
/** Last two labels of a host ("americanart.si.edu" -> "si.edu"), so subdomains of a listed site match it. */
const baseDomain = (u) => host(u).split(".").slice(-2).join(".");
/** Openverse caps anonymous result counts at 240. */
const OPENVERSE_COUNT_CAP = 240;

async function recheck() {
  const rows = [];
  for (const s of catalog.sources) {
    const r = await get(s.licensePage, "text/html,*/*");
    let state;
    if (r.status === 200) state = CC0_TEXT.test(r.text) ? "ok" : "no-cc0-text";
    else state = `unreachable (${r.status || r.error})`;
    rows.push({ id: s.id, page: s.licensePage, state, verified: s.verified.date });
  }
  return rows;
}

async function discover() {
  const known = new Set(
    [...catalog.sources, ...catalog.excluded, ...catalog.pending]
      .flatMap((s) => [s.id, s.name, host(s.url ?? ""), baseDomain(s.url ?? "")])
      .filter(Boolean)
      .map((x) => x.toLowerCase()),
  );
  // Openverse itself is in the catalog; its upstream sources are separate candidates.
  const candidates = [];
  let calls = 0;
  let stoppedEarly = false;
  for (const media of ["images", "audio"]) {
    calls++;
    const stats = await get(`https://api.openverse.org/v1/${media}/stats/`, "application/json");
    const list = stats.status === 200 ? parseJson(stats.text) : null;
    if (!Array.isArray(list)) {
      const why = stats.status !== 200 ? `HTTP ${stats.status || stats.error}` : "non-JSON response (likely bot protection on this network)";
      candidates.push({ media, error: `Openverse ${media} stats: ${why}` });
      continue;
    }
    for (const src of list) {
      const ids = [src.source_name, src.display_name, host(src.source_url), baseDomain(src.source_url)].map((x) => String(x).toLowerCase());
      if (ids.some((x) => known.has(x))) continue;
      if (calls >= MAX_OPENVERSE_CALLS) {
        stoppedEarly = true;
        break;
      }
      calls++;
      const q = new URLSearchParams({ source: src.source_name, license: "cc0", page_size: "1" });
      const r = await get(`https://api.openverse.org/v1/${media}/?${q}`, "application/json");
      if (r.status === 429) {
        stoppedEarly = true;
        break;
      }
      const body = r.status === 200 ? parseJson(r.text) : null;
      if (!body) continue;
      const cc0Count = body.result_count ?? 0;
      if (cc0Count > 0) candidates.push({ media, name: src.display_name, url: src.source_url, cc0Count, total: src.media_count });
    }
  }
  return { candidates, stoppedEarly };
}

const lines = [`# Weekly CC0 source check — ${new Date().toISOString().slice(0, 10)}`, ""];

if (!args.has("--skip-recheck")) {
  const rows = await recheck();
  const problems = rows.filter((r) => r.state !== "ok");
  lines.push("## Catalog re-check", "");
  lines.push(`${rows.length - problems.length} of ${rows.length} license pages still mention CC0.`, "");
  if (problems.length) {
    lines.push("Pages that need a human look (bot blocks show up as `unreachable (403)` and are usually fine):", "");
    lines.push("| Source | State | Last verified | License page |", "|---|---|---|---|");
    for (const p of problems) lines.push(`| ${p.id} | ${p.state} | ${p.verified} | ${p.page} |`);
    lines.push("");
  }
}

if (!args.has("--skip-discover")) {
  const { candidates, stoppedEarly } = await discover();
  const found = candidates.filter((c) => !c.error).sort((a, b) => b.cc0Count - a.cc0Count);
  lines.push("## New candidates from Openverse", "");
  lines.push(
    "Sources Openverse indexes that have CC0-labeled items but are not in the catalog yet. " +
      "Their CC0 items are already reachable through search_assets (via Openverse). " +
      "To list a source in the catalog, verify it on its own license page first (see CONTRIBUTING.md).",
    "",
  );
  if (found.length) {
    lines.push("| Source | Media | CC0 items | All items | URL |", "|---|---|---|---|---|");
    for (const c of found) lines.push(`| ${c.name} | ${c.media} | ${c.cc0Count >= OPENVERSE_COUNT_CAP ? `${OPENVERSE_COUNT_CAP}+` : c.cc0Count} | ${c.total} | ${c.url} |`);
  } else {
    lines.push("No new candidates this week.");
  }
  for (const c of candidates.filter((c) => c.error)) lines.push("", `- ${c.media}: ${c.error}`);
  if (stoppedEarly) lines.push("", "_Stopped early to stay under the Openverse anonymous rate limit; the rest is checked next week._");
  lines.push("");
}

process.stdout.write(lines.join("\n") + "\n");
