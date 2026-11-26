import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetDetail, AssetFile } from "./types.js";

/** Fetches one file. Returns a WHATWG Response so the body can be streamed to disk. */
export type DownloadLike = (url: string) => Promise<Response>;

/** Largest single file saved; Poly Haven 16K HDRIs are about 700 MB. */
export const MAX_FILE_BYTES = 1024 ** 3;
/** Most files one call may pick; a glTF's companions do not count. */
export const MAX_FILES_PER_CALL = 10;
export const RECEIPT_NAME = "cc0.json";

export interface SavedFile {
  label: string;
  /** Path relative to the asset folder. */
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface SkippedFile {
  label: string;
  url: string;
  reason: string;
}

export interface DownloadResult {
  /** Absolute path of the folder created for this asset. */
  folder: string;
  saved: SavedFile[];
  skipped: SkippedFile[];
  /** Absolute path of the provenance receipt written next to the files. */
  receipt: string;
}

/** Thrown when the request cannot be served as asked; the message says what to change. */
export class DownloadRequestError extends Error {}

/** Folder and file names: keep letters, digits, dot, dash and underscore. */
export function safeName(s: string): string {
  const name = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120);
  return name || "file";
}

/** A companion path from the source (e.g. "textures/door_diff_1k.jpg"), or null if it would leave the folder. */
export function safeRelativePath(p: string): string | null {
  if (!p || p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((x) => x === "" || x === "." || x === "..")) return null;
  return parts.map(safeName).join("/");
}

function fileNameFor(file: AssetFile): string {
  try {
    const base = decodeURIComponent(new URL(file.url).pathname.split("/").pop() ?? "");
    // ambientCG serves zips from /get?file=<name>.zip
    const fromQuery = new URL(file.url).searchParams.get("file");
    const name = /\.[A-Za-z0-9]{1,6}$/.test(base) ? base : fromQuery ?? "";
    if (name) return safeName(name);
  } catch {
    // fall through to the label
  }
  return safeName(file.label);
}

/**
 * Picks files by exact label. With no labels, an asset with exactly one file
 * gets that file; otherwise the caller must choose, because sources like Poly
 * Haven list dozens of resolutions and formats.
 */
export function pickFiles(asset: AssetDetail, labels?: string[]): AssetFile[] {
  const list = (asset.files ?? []).map((f) => f.label);
  const show = () => `Available files: ${list.slice(0, 40).map((l) => JSON.stringify(l)).join(", ")}${list.length > 40 ? `, … (${list.length} total)` : ""}`;
  if (!asset.files?.length) throw new DownloadRequestError(`${asset.id} lists no downloadable files. Use its landingUrl: ${asset.landingUrl}`);
  if (!labels?.length) {
    if (asset.files.length === 1) return asset.files;
    throw new DownloadRequestError(`${asset.id} has ${asset.files.length} files; pass \`files\` with one or more exact labels. ${show()}`);
  }
  if (labels.length > MAX_FILES_PER_CALL) throw new DownloadRequestError(`Pick at most ${MAX_FILES_PER_CALL} files per call.`);
  const unknown = labels.filter((l) => !list.includes(l));
  if (unknown.length) throw new DownloadRequestError(`Unknown file label(s): ${unknown.map((l) => JSON.stringify(l)).join(", ")}. ${show()}`);
  return asset.files.filter((f) => labels.includes(f.label));
}

async function saveOne(download: DownloadLike, url: string, target: string): Promise<{ bytes: number; sha256: string } | string> {
  let res: Response;
  try {
    res = await download(url);
  } catch (e) {
    return `request failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!res.ok) return `HTTP ${res.status}`;
  const type = res.headers.get("content-type") ?? "";
  if (/^text\/html/i.test(type)) {
    await res.body?.cancel();
    return "the URL is a web page, not a file (the source needs a login or a browser download); open it from landingUrl";
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_FILE_BYTES) {
    await res.body?.cancel();
    return `file is ${declared} bytes, over the ${MAX_FILE_BYTES}-byte limit`;
  }
  if (!res.body) return "empty response";

  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) return cb(new Error(`over the ${MAX_FILE_BYTES}-byte limit`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(target));
  } catch (e) {
    await rm(target, { force: true });
    return `download failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * Saves the chosen files of an already CC0-checked asset into `<dir>/<asset id>/`,
 * with each file's companions (`includes`) at their relative paths, and writes a
 * `cc0.json` receipt recording where each file came from and the license evidence
 * at download time. Files that cannot be fetched are listed in `skipped`.
 */
export async function downloadAsset(
  download: DownloadLike,
  asset: AssetDetail,
  dir: string,
  labels?: string[],
  now: () => Date = () => new Date(),
): Promise<DownloadResult> {
  const chosen = pickFiles(asset, labels);
  const folder = path.resolve(dir, safeName(asset.id.replace(/:/g, "_")));
  await mkdir(folder, { recursive: true });

  const saved: SavedFile[] = [];
  const skipped: SkippedFile[] = [];
  const used = new Set<string>();
  const unique = (rel: string) => {
    let out = rel;
    for (let n = 2; used.has(out); n++) out = rel.replace(/(\.[^./]+)?$/, `-${n}$1`);
    used.add(out);
    return out;
  };

  for (const file of chosen) {
    const rel = unique(fileNameFor(file));
    const r = await saveOne(download, file.url, path.join(folder, rel));
    if (typeof r === "string") {
      skipped.push({ label: file.label, url: file.url, reason: r });
      continue;
    }
    saved.push({ label: file.label, path: rel, url: file.url, ...r });
    for (const inc of file.includes ?? []) {
      const incRel = safeRelativePath(inc.path);
      const label = `${file.label} + ${inc.path}`;
      if (!incRel) {
        skipped.push({ label, url: inc.url, reason: "companion path would leave the asset folder" });
        continue;
      }
      // Companions are shared between variants of one model (e.g. the .bin); save each path once.
      if (used.has(incRel)) continue;
      used.add(incRel);
      const ri = await saveOne(download, inc.url, path.join(folder, incRel));
      if (typeof ri === "string") skipped.push({ label, url: inc.url, reason: ri });
      else saved.push({ label, path: incRel, url: inc.url, ...ri });
    }
  }

  const receipt = path.join(folder, RECEIPT_NAME);
  // A second call for the same asset adds to the receipt instead of replacing it.
  const earlier = await readFile(receipt, "utf8").then(
    (t) => JSON.parse(t) as { id?: string; files?: SavedFile[] },
    () => null,
  );
  const merged = new Map<string, SavedFile>();
  if (earlier?.id === asset.id) for (const f of earlier.files ?? []) merged.set(f.path, f);
  for (const f of saved) merged.set(f.path, f);
  await writeFile(
    receipt,
    JSON.stringify(
      {
        id: asset.id,
        title: asset.title,
        creator: asset.creator,
        landingUrl: asset.landingUrl,
        provider: asset.provider,
        origin: asset.origin,
        license: asset.licenseEvidence,
        ...(asset.riskFlags && { riskFlags: asset.riskFlags }),
        servedBy: asset.servedBy,
        checkedAt: now().toISOString(),
        files: [...merged.values()],
        ...(skipped.length && { skipped }),
      },
      null,
      2,
    ) + "\n",
  );
  return { folder, saved, skipped, receipt };
}
