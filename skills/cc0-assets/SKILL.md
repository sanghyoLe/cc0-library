---
name: cc0-assets
description: Find and download CC0 (public domain) images, icons, sounds, music, video, HDRIs, textures, 3D models and museum art with the cc0-library MCP server, keeping license evidence for each file. Use when a project needs assets that can be used, changed and shipped without attribution or license fees — game sprites and models, placeholder art, UI icons, sound effects, background music, skyboxes, materials, reference photos — or when the user asks whether an asset is really free to use.
---

# CC0 assets with cc0-library

The `cc0-library` MCP server searches 17 sources and returns only items whose own
record says CC0 1.0. Its tools: `search_assets`, `get_asset`, `download_asset`,
`list_sources`. If they are missing, install the server:

```sh
claude mcp add cc0-library -- npx -y cc0-library-mcp
```

## Workflow

1. **Search.** `search_assets` with a short English query (2–3 nouns: `stone wall`,
   `footsteps gravel`, `low poly tree`) and the narrowest `kind`:
   - `image` photos, illustrations, icons · `audio` sound effects, music · `video`
   - `hdri` skies and lighting · `texture` PBR materials · `model` 3D models
   - `artwork` museum paintings and objects · `collection` whole CC0 repos and datasets
   - Icons: `kind: "image"`, `providers: ["iconify"]`.
   - Species photos and silhouettes match Latin names best (`vulpes`, `felis catus`).
   - Sources in `pending` did not answer within 10 s. Search again or ask for `page: 2`
     only if the results so far are not enough.
2. **Choose.** Prefer items in this order of `licenseEvidence.declaredBy`:
   `library` (the studio that made it, e.g. Poly Haven, ambientCG) →
   `institution` (a museum's own collection) → `uploader` (a site user set the label;
   nobody reviewed it). Skip any item with `riskFlags`: its title or tags name a
   game, film or brand, or say it is fan-made, so the franchise owner likely still
   holds rights in it whatever the CC0 label says.
3. **Inspect.** `get_asset` with the chosen `id`. It re-checks CC0 at the source and
   lists the files with exact labels, sizes and companions (`includes`).
4. **Download.** `download_asset` with `id`, `dir` (inside the user's project, e.g.
   `assets/cc0`) and `files` set to exact labels from step 3. Pick one resolution and
   format the project can use (for Poly Haven, `1k` or `2k` and `gltf` for models,
   `hdr` or `exr` for HDRIs) instead of every variant. Files land in
   `<dir>/<asset id>/` next to a `cc0.json` receipt; keep that receipt in the repo.
5. **Report.** Tell the user what was saved, from where, who declared CC0, and any
   entries in `skipped`.

## Things the tools cannot do

- **Login-only downloads.** Sketchfab, BlenderKit and Freesound originals need the
  user's own account. `download_asset` lists them in `skipped`; give the user the
  `landingUrl` instead of trying to fetch the file another way.
- **Sites outside the search.** For a source that is not searched live (Kenney,
  Quaternius, OpenGameArt CC0 packs and others), call `list_sources` and give the
  user the catalog link. `list_sources` also lists free-looking sites that are not
  CC0 (Unsplash, Pixabay, Pexels, NASA and others): do not present their files as CC0.

## Rules

- Call an asset CC0 only if it came back from these tools. A CC0 tag on a web page
  found some other way is not checked.
- Do not drop `riskFlags` or `declaredBy` from what you tell the user, and do not
  describe an uploader-declared item as verified.
- CC0 needs no credit, but when showing live search results to people, show each
  result's `servedBy` line (Poly Haven and Openverse ask for it).
