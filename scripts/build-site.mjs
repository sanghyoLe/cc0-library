// Assembles the static gallery into _site/ for GitHub Pages:
//   web/*                      -> _site/
//   dist/{search,http,types}.js, dist/providers/*.js -> _site/lib/
//   catalog/sources.json       -> _site/catalog/sources.json
// Run `npm run build` first (the npm script does both).
import { cpSync, mkdirSync, rmSync } from "node:fs";

const OUT = "_site";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/lib/providers`, { recursive: true });
mkdirSync(`${OUT}/catalog`, { recursive: true });
cpSync("web", OUT, { recursive: true });
for (const f of ["search.js", "http.js", "types.js"]) cpSync(`dist/${f}`, `${OUT}/lib/${f}`);
cpSync("dist/providers", `${OUT}/lib/providers`, { recursive: true });
cpSync("catalog/sources.json", `${OUT}/catalog/sources.json`);
console.log(`site built in ${OUT}/`);
