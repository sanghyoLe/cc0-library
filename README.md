# cc0-library

**CC0 assets only. With receipts.**
One search across 9 sources for images, audio, video, HDRIs, textures, 3D models, and museum artworks. Every result shows *how* its CC0 status was verified and *who* declared it.

[![ci](https://github.com/sanghyoLe/cc0-library/actions/workflows/ci.yml/badge.svg)](https://github.com/sanghyoLe/cc0-library/actions/workflows/ci.yml)
![license: MIT](https://img.shields.io/badge/code-MIT-blue)
![catalog: CC0](https://img.shields.io/badge/catalog-CC0-green)
[![npm](https://img.shields.io/npm/v/cc0-library-mcp)](https://www.npmjs.com/package/cc0-library-mcp)

- **Try it in the browser:** https://sanghyole.github.io/cc0-library/
- **Use it from Claude, Cursor, or any MCP client:** `claude mcp add cc0-library -- npx -y cc0-library-mcp`

[![cc0-library web gallery: CC0 search results for "cat" from Poly Haven, Cleveland Museum of Art and The Met](docs/screenshot.jpg)](https://sanghyole.github.io/cc0-library/?q=cat&strict=1)

[한국어 안내는 아래에 있습니다.](#한국어)

## Why

"Free" is not "CC0". Unsplash, Pixabay, and Pexels use their own licenses. Openverse, Flickr, Commons, and Sketchfab mix licenses on one site, and the license on an item is whatever the uploader picked. If you ship a game, a product, or AI training data, you need to know which items are really CC0 and why.

| | Openverse search alone | cc0-library |
|---|---|---|
| Sources | Openverse index (Flickr, Freesound, Commons, museums…) | Openverse **plus** Commons, Internet Archive, WordPress Photo Directory, Poly Haven, ambientCG, Sketchfab, Cleveland, The Met |
| CC0 filter | `license=cc0` query parameter | Query filter **and** a check of each item's own license field |
| Who declared CC0 | Not shown | `declaredBy`: studio, museum, or uploader |
| Re-check before download | — | `get_asset` re-checks CC0 at the source |
| "Looks free but isn't" list | — | Unsplash, Pixabay, Pexels, SMK (Public Domain Mark), NASA |
| Asset types | Images, audio | Images, audio, video, HDRIs, textures, 3D models, artworks |
| AI assistant access | REST API | MCP server (`search_assets`, `get_asset`, `list_sources`) |

### Who declared CC0?

Every result has `licenseEvidence.declaredBy`:

| Value | Meaning | Providers |
|---|---|---|
| `library` | The studio that made the asset publishes everything as CC0. | Poly Haven, ambientCG |
| `institution` | A museum marks a work in its own collection as CC0. | Cleveland Museum of Art, The Met |
| `uploader` | A site user set the CC0 label. Nobody reviewed it, and it can be wrong (for example, someone else's work uploaded as CC0). | Openverse, Wikimedia Commons, Internet Archive, Sketchfab, WordPress Photo Directory |

The web gallery has a "rights holder only" switch that drops `uploader` results. MCP clients can filter on the field.

## How each provider is checked

| Provider | Asset kinds | How CC0 is checked |
|---|---|---|
| [Openverse](https://openverse.org) | image, audio | The query uses `license=cc0`. Each item must also have `license === "cc0"` in its own record. Public Domain Mark (`pdm`) and mature items are dropped. |
| [Poly Haven](https://polyhaven.com) | hdri, texture, model | Every asset in the library is CC0 ([license](https://polyhaven.com/license)). |
| [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:CC-Zero) | image, audio, video | Search is limited to Category:CC-Zero. Each file must also have `extmetadata.License === "cc0"`. |
| [Internet Archive](https://archive.org) | video, audio, image | The query requires a CC0 `licenseurl`. Each item's own `licenseurl` must be the CC0 1.0 deed. User text is stripped of query operators so it cannot bypass this clause. |
| [WordPress Photo Directory](https://wordpress.org/photos/) | image | Every photo in the directory is CC0 ("All photos are CC0 licensed"). |
| [Sketchfab](https://sketchfab.com) | model | The query uses `license=cc0`. Each model's own license must be "CC0 Public Domain". Age-restricted models are dropped. |
| [ambientCG](https://ambientcg.com) | hdri, texture, model | Every asset in the library is CC0 ([license](https://docs.ambientcg.com/license/)). |
| [Cleveland Museum of Art](https://www.clevelandart.org/open-access) | artwork | The query uses `cc0=1`. Each item must also have `share_license_status === "CC0"`. |
| [The Met](https://github.com/metmuseum/openaccess) | artwork | Each object must have `isPublicDomain === true` (Open Access works are CC0) and an image. |

Every result carries `licenseEvidence` so you can check it again yourself. `get_asset` checks the CC0 status again at the source before it returns download URLs.

> This library is not legal advice. Upstream sites can change or remove items. Check the `landingUrl` before you use an item in a product.

## Quick start

Requires Node.js 20 or later.

### Claude Code

```sh
claude mcp add cc0-library -- npx -y cc0-library-mcp
```

### Claude Desktop / other clients (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "cc0-library": {
      "command": "npx",
      "args": ["-y", "cc0-library-mcp"]
    }
  }
}
```

### From a local clone

```sh
git clone https://github.com/sanghyoLe/cc0-library.git
cd cc0-library
npm install        # also builds dist/ via the prepare script
claude mcp add cc0-library -- node "$PWD/dist/index.js"
```

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_assets` | `query`, `kind` (`image`·`audio`·`video`·`hdri`·`texture`·`model`·`artwork`·`any`, default `any`), `limit` 1–20, `page` 1–12 | CC0 assets, per-provider totals, per-provider errors |
| `get_asset` | `id` from `search_assets` (`openverse:image:<uuid>`, `openverse:audio:<uuid>`, `polyhaven:<slug>`, `ambientcg:<assetId>`, `cleveland:<number>`, `met:<number>`, `commons:<pageid>`, `archive:<identifier>`, `sketchfab:<uid>`, `wpphotos:<number>`) | Details plus download URLs (Poly Haven: up to 60 map/resolution/format files; Sketchfab: model page only, because downloads need the user's own login) |
| `list_sources` | `kind` (optional) | Curated catalog, the non-CC0 list, and the pending-verification list |

If one provider fails, `search_assets` still returns results from the other providers and lists the failure in `errors`. Gateway errors (HTTP 502/503/504) are retried once.

The Met's search returns object IDs only, so the server fetches each object and drops non-public-domain ones. A Met page can therefore hold fewer items than `limit`.

Example result item:

```json
{
  "id": "polyhaven:red_bricks_04",
  "kind": "texture",
  "title": "Red Bricks 04",
  "landingUrl": "https://polyhaven.com/a/red_bricks_04",
  "licenseEvidence": {
    "license": "CC0-1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "method": "whole-library-cc0",
    "source": "https://polyhaven.com/license",
    "declaredBy": "library"
  },
  "servedBy": "Powered by Poly Haven (https://polyhaven.com)"
}
```

## Upstream API terms

- **Poly Haven** requires a User-Agent that names the app. This server sends `cc0-library-mcp/<version>`. If you show live API results to people, credit Poly Haven. Each result's `servedBy` field holds that credit. Downloaded assets need no attribution. See the [API ToS](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md).
- **Openverse** anonymous access allows at most 20 items per page, so `limit` is capped at 20. Credit Openverse when you show its search results.
- **ambientCG** is run by one person, and its docs say the API is not built for enterprise loads. Keep request volume low. The API sends no CORS headers, so it works from servers only, not from browsers.
- **Cleveland Museum of Art** and **The Met** need no API key. Each result's `servedBy` names the museum.
- **Wikimedia Commons** asks API clients to send an identifying User-Agent. This server sends one.
- **Sketchfab** API terms ask apps that use its download API to show the license and credit the creator (username and model link). This server does not use the download API, but each result still carries `creator` and `landingUrl`.

## Development

```sh
npm install
npm test          # unit tests with a fake fetch (no network)
npm run smoke     # end-to-end: starts the server over stdio and calls every tool against the live APIs
npm run build:site && python3 -m http.server -d _site 8765   # web gallery at http://127.0.0.1:8765
```

Layout:

```
src/
  index.ts              stdio entry point (bin)
  server.ts             MCP tool definitions
  search.ts             search fan-out and id routing (no Node-only imports; also runs in the browser)
  library.ts            catalog loader, re-exports search
  providers/openverse.ts
  providers/polyhaven.ts
  providers/ambientcg.ts
  providers/cleveland.ts
  providers/met.ts
  providers/commons.ts
  providers/archive.ts
  providers/sketchfab.ts
  providers/wpphotos.ts
web/                    browser gallery (GitHub Pages); scripts/build-site.mjs assembles it into _site/
catalog/sources.json    curated CC0 source list (CC0 data)
test/                   node:test unit tests
scripts/smoke.mjs       live end-to-end check
scripts/discover.mjs    weekly catalog re-check and Openverse candidate discovery
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

- **Suggest a source:** open a [New CC0 source](https://github.com/sanghyoLe/cc0-library/issues/new?template=new-source.yml) issue with a quote from the source's own license page.
- **Report a wrong license:** open a [Wrong license](https://github.com/sanghyoLe/cc0-library/issues/new?template=wrong-license.yml) issue.
- **Automatic discovery:** a weekly workflow re-checks every catalog license page and lists new CC0 candidates from Openverse in the [`source-check`](https://github.com/sanghyoLe/cc0-library/issues?q=label%3Asource-check) issue. A person verifies each candidate before it enters the catalog.
- **Pull requests:** `main` is protected. Changes need a pull request, passing tests, and maintainer approval.

## License

- Code: [MIT](LICENSE)
- Catalog data (`catalog/`): [CC0 1.0](catalog/LICENSE)
- Assets found through this tool: each one is CC0 per its own source. This repo does not host any asset files.

---

## 한국어

**cc0-library**는 CC0 1.0 자료만 찾아 주는 오픈소스 MCP 서버이자 CC0 자료원 목록입니다.

- `search_assets`는 이미지, 오디오, 영상을 Openverse, 위키미디어 공용, 인터넷 아카이브, WordPress 사진 디렉터리에서 찾습니다. HDRI, 텍스처, 3D 모델은 Poly Haven, ambientCG, Sketchfab에서 찾습니다. 미술품(`artwork`)은 Cleveland Museum of Art와 The Met에서 찾습니다.
- 모든 결과에는 CC0 확인 근거(`licenseEvidence`)가 붙습니다. 근거에는 CC0를 누가 선언했는지(`declaredBy`)도 들어 있습니다. 제작사(`library`), 미술관(`institution`), 업로더(`uploader`) 중 하나입니다. 업로더가 선언한 CC0는 아무도 검토하지 않았으므로 직접 확인해야 합니다.
- 웹에서 바로 검색할 수 있습니다: https://sanghyole.github.io/cc0-library/
- `get_asset`은 다운로드 URL을 주기 전에 원본에서 CC0 여부를 다시 확인합니다.
- `list_sources`는 검증한 CC0 자료원 89곳의 목록을 줍니다. CC0가 아닌 무료 사이트(Unsplash, Pixabay, Pexels, Pixnio, SMK, NASA)와 그 이유도 줍니다. 아직 검증하지 못한 후보도 따로 줍니다.

설치 (Claude Code):

```sh
claude mcp add cc0-library -- npx -y cc0-library-mcp
```

코드는 MIT, 카탈로그 데이터는 CC0입니다. 자료원 제안과 기여 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다. 매주 자동 점검이 새 CC0 후보를 찾아 `source-check` 이슈에 올립니다. 후보는 사람이 원본 라이선스 페이지를 확인한 뒤에 목록에 들어갑니다.
