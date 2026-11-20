# Contributing to cc0-library

Thanks for helping. The project's promise is **CC0 only, with receipts**: every source and every search result must carry evidence that a reader can check. Contributions are judged against that promise first.

## Ways to contribute

| You want to… | Do this |
|---|---|
| Suggest a CC0 source but not edit files | Open a [**New CC0 source** issue](https://github.com/sanghyoLe/cc0-library/issues/new?template=new-source.yml). |
| Add a source to the catalog | Open a pull request that edits `catalog/sources.json` (steps below). |
| Report a non-CC0 result or a wrong license | Open a [**Wrong license** issue](https://github.com/sanghyoLe/cc0-library/issues/new?template=wrong-license.yml). This is the most valuable report we get. |
| Add a searchable provider or fix code | Open a pull request with tests (steps below). |
| Pick up candidates found automatically | See the open issue labeled [`source-check`](https://github.com/sanghyoLe/cc0-library/issues?q=is%3Aissue+label%3Asource-check). |

## How sources are collected

1. **Automatic discovery.** Every Monday, `.github/workflows/discover.yml` runs `scripts/discover.mjs`. It:
   - re-checks that every catalog license page is reachable and still mentions CC0, and
   - lists sources that Openverse indexes with CC0-labeled items but that the catalog does not list yet.

   It posts the report to the open `source-check` issue. You can run it locally with `node scripts/discover.mjs`.
2. **Human verification.** A candidate enters the catalog only after a person checks the source's **own** license page and quotes the evidence. Automated hints are never enough on their own.

## Adding a source to the catalog

1. Open the source's own license or terms page. Do not rely on a third-party summary.
2. Decide the scope:
   - `whole-library`: everything on the site is CC0 1.0.
   - `filter-only`: the site mixes licenses, and only items labeled CC0 qualify.
3. Add an entry to `sources` in `catalog/sources.json`:

   ```json
   {
     "id": "example",
     "name": "Example Assets",
     "url": "https://example.org",
     "kinds": ["texture"],
     "scope": "whole-library",
     "searchable": false,
     "licensePage": "https://example.org/license",
     "notes": "What the source offers and anything a user must know.",
     "verified": { "date": "YYYY-MM-DD", "evidence": "Quote the exact sentence you read, e.g. 'All assets are released under CC0'" }
   }
   ```

   Allowed `kinds`: `image`, `audio`, `video`, `hdri`, `texture`, `model`, `artwork`.
4. If the site is free but **not** CC0 (its own license, CC BY, Public Domain Mark, "no known restrictions"), add it to `excluded` with `name`, `url` and `reason`.
5. If you cannot verify the license (the page blocks you, the wording is unclear), add it to `pending` with `name`, `url` and `reason`.
6. Run `npm test`. The catalog test checks required fields, ids, dates, kinds and duplicates.

Public Domain Mark (PDM), "no known copyright restrictions" and "public domain" without a CC0 dedication are **not** CC0. List those under `excluded`.

A repository's declared license is not enough when its README or files say otherwise. For example, a repository can declare CC0-1.0 while its README says the photos are CC BY-SA. The content's own license wins.

## Adding a searchable provider

1. Add `src/providers/<name>.ts`. Return `Asset` objects (`src/types.ts`) only after a CC0 check:
   - per item: the item's own license field says CC0, or
   - whole library: the site publishes everything as CC0.
2. Fill `licenseEvidence` honestly, including `declaredBy`:
   - `library`: the studio that made the assets.
   - `institution`: a museum or archive for works in its own collection.
   - `uploader`: any site where users choose the license.
3. Send a User-Agent that names the app (`src/http.ts`). Follow the source's API terms and credit it in `servedBy`.
4. Never spoof a browser or bypass a site's bot protection. If a site blocks automated access, list it in the catalog instead.
5. Wire the provider into `search()` and `getAsset()` in `src/search.ts`.
6. Add unit tests with a fake fetch in `test/library.test.mjs`. Cover: non-CC0 items are dropped, malformed ids are rejected, and `get_asset` re-checks the license.
7. Run `npm test` and `npm run smoke` (the smoke test calls the live APIs).

## Pull request rules

The `main` branch is protected:

- Changes go in through pull requests.
- The `ci` checks (unit tests on Node 20, 22 and 24) must pass.
- A code owner (see `.github/CODEOWNERS`) must approve.
- Force pushes and branch deletion are blocked.

Keep each pull request to one source or one change. Write commit messages that say what changed and why.

## Code of conduct

Be kind and assume good faith. License mistakes happen; point to the evidence, not the person.
