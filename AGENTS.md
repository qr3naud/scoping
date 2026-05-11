# Clay Scoping Tool — maintainer notes

User-facing install instructions live in [`README.md`](./README.md). This file is for whoever is editing the extension code.

## Two extensions, one source tree

This repo (`qr3naud/scoping`) is the **internal** extension. A stripped-down **public** spin-off lives at [`qr3naud/self-scoping`](https://github.com/qr3naud/self-scoping), produced by `build.js` from this same source tree — never edited directly.

The internal extension uses the source as-is. The public build strips internal-only modules, sentinel-marked blocks, and the `docs/` folder, then rewrites a small set of brand strings (toolbar label, repo path).

## One-time setup (per maintainer machine)

Clone the public repo somewhere `build.js` can write to. The default `BUILD_OUT` is `../../../self-scoping` (a sibling of `clay-base`):

```bash
git clone git@github.com:qr3naud/self-scoping.git ~/Developer/self-scoping
```

If you cloned somewhere else, export `BUILD_OUT` so it points at your clone. There are no npm dependencies — `build.js` runs on plain Node.

## Releasing the public extension

```bash
./release.sh "feat: short description of the change"
```

That runs `node build.js`, which:

1. Copies every source file into `$BUILD_OUT` except entries in `build.config.js → exclude` (`src/pricing-comparison.js`, `docs/`, this repo's `.git`, the build tooling itself, this file).
2. Strips every `__CB_INTERNAL_ONLY_BEGIN: <name>` … `__CB_INTERNAL_ONLY_END` sentinel block from `.js`/`.css` files. Existing names: `pricingComparison`, `gtmeExport`, `dealopsExport`, `legacyPricing`.
3. Runs the ordered branding substitutions in `build.config.js`. Today that swaps the toolbar label `GTME View` → `Scoping`, the repo URL fragment `qr3naud/scoping` → `qr3naud/self-scoping`, and the install dir `clay-scoping-extension` → `clay-self-scoping-extension`. Manifest name and console log prefix stay `Clay Scoping Tool` / `[Clay Scoping]`.
4. Re-serializes `manifest.json` with `src/pricing-comparison.js` filtered out of `content_scripts[].js`.
5. Writes a fresh `.gitignore` (`config.publicGitignore`) into the output.
6. Commits + pushes to `qr3naud/self-scoping`.

The internal extension is untouched. Push the source-repo changes to `qr3naud/scoping` with the usual `git push`.

## Adding a new internal-only block

Wrap it in sentinels — they look like comments in the source, so the internal extension runs them as-is:

```js
// __CB_INTERNAL_ONLY_BEGIN: <feature-name>
const internalThing = ...
// __CB_INTERNAL_ONLY_END
```

CSS uses the `/* … */` form:

```css
/* __CB_INTERNAL_ONLY_BEGIN: <feature-name> */
.cb-internal-thing { ... }
/* __CB_INTERNAL_ONLY_END */
```

For whole-file removal (like `src/pricing-comparison.js`), add the path to `build.config.js → exclude`. If the file is also injected by the manifest, add it to `excludeFromManifestScripts` so the manifest's `content_scripts[].js` array drops it cleanly.

## Workspace partition

`popup.js` (`fetchCanvases`) and `src/home.js` (`loadCanvases`) filter the Supabase canvases list by `workspace_id` derived from the URL / active Chrome tab. This is the UX boundary that keeps customers in workspace X from seeing canvases owned by workspace Y. It is **not** a security boundary — anyone with the anon key could craft a different query. If we ever need real per-workspace isolation, the path forward is per-Clay-user signed JWTs gating RLS on `canvases.workspace_id`.

## Bumping the version

Per repo convention every meaningful change bumps `manifest.json → version` in the same commit. The public build inherits the same number — no separate version field.
