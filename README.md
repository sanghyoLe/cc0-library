# cc0-library

Search **CC0-only** images, audio, HDRIs, textures, 3D models, and museum artworks from any MCP client (Claude Code, Claude Desktop, Cursor, and others).

The repo has two parts:

1. **MCP server** (`src/`): live search over 5 providers (Openverse, Poly Haven, ambientCG, Cleveland Museum of Art, The Met). It returns only items confirmed as CC0 1.0.
2. **Curated catalog** (`catalog/sources.json`): 14 CC0 asset sources, each with license evidence and a verification date. It also lists popular "free" sources that are **not** CC0, and candidates still pending verification.

[한국어 안내는 아래에 있습니다.](#한국어)

## Why "CC0 only"

Most "free" asset sites use custom licenses (Unsplash, Pixabay, Pexels) or mix licenses on one site. This library returns an item only after it passes a CC0 check:

| Provider | Asset kinds | How CC0 is checked |
|---|---|---|
| [Openverse](https://openverse.org) | image, audio | The query uses `license=cc0`. Each item must also have `license === "cc0"` in its own record. Public Domain Mark (`pdm`) and mature items are dropped. |
| [Poly Haven](https://polyhaven.com) | hdri, texture, model | Every asset in the library is CC0 ([license](https://polyhaven.com/license)). |
| [ambientCG](https://ambientcg.com) | hdri, texture, model | Every asset in the library is CC0 ([license](https://docs.ambientcg.com/license/)). |
| [Cleveland Museum of Art](https://www.clevelandart.org/open-access) | artwork | The query uses `cc0=1`. Each item must also have `share_license_status === "CC0"`. |
| [The Met](https://github.com/metmuseum/openaccess) | artwork | Each object must have `isPublicDomain === true` (Open Access works are CC0) and an image. |

Every result carries `licenseEvidence` (method plus source URL) so you can check it again yourself. `get_asset` checks the CC0 status again at the source before it returns download URLs.

> This library is not legal advice. Upstream sites can change or remove items. Check the `landingUrl` before you use an item in a product.

## Quick start

Requires Node.js 20 or later.

### Claude Code

```sh
claude mcp add cc0-library -- npx -y github:sanghyoLe/cc0-library
```

### Claude Desktop / other clients (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "cc0-library": {
      "command": "npx",
      "args": ["-y", "github:sanghyoLe/cc0-library"]
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
| `search_assets` | `query`, `kind` (`image`·`audio`·`hdri`·`texture`·`model`·`artwork`·`any`, default `any`), `limit` 1–20, `page` 1–12 | CC0 assets, per-provider totals, per-provider errors |
| `get_asset` | `id` from `search_assets` (`openverse:image:<uuid>`, `openverse:audio:<uuid>`, `polyhaven:<slug>`, `ambientcg:<assetId>`, `cleveland:<number>`, `met:<number>`) | Details plus download URLs (Poly Haven: up to 60 map/resolution/format files) |
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
    "source": "https://polyhaven.com/license"
  },
  "servedBy": "Powered by Poly Haven (https://polyhaven.com)"
}
```

## Upstream API terms

- **Poly Haven** requires a User-Agent that names the app. This server sends `cc0-library-mcp/<version>`. If you show live API results to people, credit Poly Haven. Each result's `servedBy` field holds that credit. Downloaded assets need no attribution. See the [API ToS](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md).
- **Openverse** anonymous access allows at most 20 items per page, so `limit` is capped at 20. Credit Openverse when you show its search results.
- **ambientCG** is run by one person, and its docs say the API is not built for enterprise loads. Keep request volume low. The API sends no CORS headers, so it works from servers only, not from browsers.
- **Cleveland Museum of Art** and **The Met** need no API key. Each result's `servedBy` names the museum.

## Development

```sh
npm install
npm test          # unit tests with a fake fetch (no network)
npm run smoke     # end-to-end: starts the server over stdio and calls every tool against the live APIs
```

Layout:

```
src/
  index.ts              stdio entry point (bin)
  server.ts             MCP tool definitions
  library.ts            search fan-out, id routing, catalog loader
  providers/openverse.ts
  providers/polyhaven.ts
  providers/ambientcg.ts
  providers/cleveland.ts
  providers/met.ts
catalog/sources.json    curated CC0 source list (CC0 data)
test/                   node:test unit tests
scripts/smoke.mjs       live end-to-end check
```

## Contributing a source

1. Confirm on the source's **own** license page that its assets (or a filterable subset) are CC0 1.0.
2. Add an entry to `catalog/sources.json`. Fill in `licensePage`, `scope` (`whole-library` or `filter-only`), and `verified.date` / `verified.evidence` (quote the text you checked).
3. Run `npm test`. The catalog test checks required fields.
4. Open a pull request.

If a source is free but not CC0, add it to `excluded` with the reason. If you could not verify a source, add it to `pending` with the reason.

To add a searchable provider, add a module under `src/providers/` that returns `Asset` objects (`src/types.ts`) only after a per-item or whole-library CC0 check. Then wire it into `search()` and `getAsset()` in `src/library.ts`, and add unit tests.

## License

- Code: [MIT](LICENSE)
- Catalog data (`catalog/`): [CC0 1.0](catalog/LICENSE)
- Assets found through this tool: each one is CC0 per its own source. This repo does not host any asset files.

---

## 한국어

**cc0-library**는 CC0 1.0 자료만 찾아 주는 오픈소스 MCP 서버이자 CC0 자료원 목록입니다.

- `search_assets`는 이미지와 오디오를 Openverse에서 찾습니다. HDRI, 텍스처, 3D 모델은 Poly Haven과 ambientCG에서 찾습니다. 미술품(`artwork`)은 Cleveland Museum of Art와 The Met에서 찾습니다.
- 모든 결과에는 CC0 확인 근거(`licenseEvidence`)가 붙습니다.
- `get_asset`은 다운로드 URL을 주기 전에 원본에서 CC0 여부를 다시 확인합니다.
- `list_sources`는 검증한 CC0 자료원 14곳의 목록을 줍니다. CC0가 아닌 무료 사이트(Unsplash, Pixabay, Pexels, SMK)와 그 이유도 줍니다. 아직 검증하지 못한 후보도 따로 줍니다.

설치 (Claude Code):

```sh
claude mcp add cc0-library -- npx -y github:sanghyoLe/cc0-library
```

코드는 MIT, 카탈로그 데이터는 CC0입니다. 자료원 추가는 위 "Contributing a source" 절차를 따릅니다.
