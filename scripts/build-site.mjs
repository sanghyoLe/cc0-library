// Assembles the static gallery into _site/ for GitHub Pages:
//   web/*                      -> _site/
//   dist/{search,risk,http,types}.js, dist/providers/*.js -> _site/lib/
//   catalog/sources.json       -> _site/catalog/sources.json
// Run `npm run build` first (the npm script does both).
// Fails if any copied module imports a relative file that was not copied:
// one missing module stops the whole gallery script from loading.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const OUT = "_site";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/lib/providers`, { recursive: true });
mkdirSync(`${OUT}/catalog`, { recursive: true });
cpSync("web", OUT, { recursive: true });
for (const f of ["search.js", "risk.js", "http.js", "types.js"]) cpSync(`dist/${f}`, `${OUT}/lib/${f}`);
cpSync("dist/providers", `${OUT}/lib/providers`, { recursive: true });
cpSync("catalog/sources.json", `${OUT}/catalog/sources.json`);

const jsFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : [],
  );
const missing = [];
for (const file of jsFiles(OUT)) {
  for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:import|export)\s[^"']*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g).map((m) => [m[0], m[1] ?? m[2]])) {
    const target = join(dirname(file), spec);
    if (!existsSync(target)) missing.push(`${relative(OUT, file)} imports ${spec}`);
  }
}
if (missing.length) {
  console.error(`site build is missing modules:\n  ${missing.join("\n  ")}\nAdd them to the copy list in scripts/build-site.mjs.`);
  process.exit(1);
}
console.log(`site built in ${OUT}/`);
