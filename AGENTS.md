# Clay Scoping Tool — maintainer notes

User-facing install instructions live in [`README.md`](./README.md). This file is for whoever is editing the extension code.

## Two extensions, one source tree

This repo (`qr3naud/scoping`) is the **internal** extension. A stripped-down **public** spin-off lives at [`qr3naud/self-scoping`](https://github.com/qr3naud/self-scoping), produced by `build.js` from this same source tree — never edited directly.

The internal extension uses the source as-is. The public build strips internal-only modules, sentinel-marked blocks, and the `docs/` / `supabase/` / `scripts/` folders, then rewrites a small set of brand strings (toolbar label, repo path).

## Auth model (Phase 1, v3.27+)

Every Supabase request the extension makes is authenticated by a per-Clay-user JWT minted by the `clay-auth-mint` Edge Function. RLS on every table the extension touches gates rows by `workspace_id ∈ jwt.workspaces`. The anon role has no privileges.

Flow (see [`src/auth.js`](./src/auth.js) and [`src/internal-bg.js`](./src/internal-bg.js)):

1. Content script asks the service worker for a JWT via `chrome.runtime.sendMessage({ type: "cb:auth:mint" })`.
2. Service worker reads the user's `api.clay.com` cookies via `chrome.cookies.getAll` (HttpOnly — content script can't) and posts them in the `x-clay-cookie` header to `clay-auth-mint`.
3. `clay-auth-mint` re-validates the cookie by calling `https://api.clay.com/v3/me` server-side; if Clay returns 200, it then asks `/v3/users/:id/workspaces` for the authoritative workspace membership list. Both are forwarded with the cookie; nothing is logged or persisted.
4. The function signs a JWT with `SUPABASE_JWT_SECRET` (HS256, 1h expiry) containing `{ sub, email, role: "authenticated", workspaces, iat, exp }` and returns it.
5. `src/auth.js` caches the JWT in `__cb.supabaseJwt` + `localStorage` and refreshes 5 min before expiry. `src/supabase.js` uses it as the `Authorization: Bearer` header on every PostgREST call; `src/realtime.js` calls `client.realtime.setAuth(jwt)` so realtime sockets get the same auth.

**Attacker model**: a random Clay user installing the public extension can only ever get a JWT containing *their own* workspaces. RLS denies access to any canvas in a workspace not in their JWT. The SFDC + Dust proxies additionally check `INTERNAL_WORKSPACES` (defaults to `4515`) before accepting any request.

## Supabase project layout

Edge Functions and SQL migrations live under [`supabase/`](./supabase/):

- `supabase/functions/clay-auth-mint/` — Phase-1 JWT minter
- `supabase/functions/sfdc-search-opportunities/` — SOSL search
- `supabase/functions/sfdc-get-opportunity/` — single-record fetch
- `supabase/functions/dust-proxy/` — Dust conversation + agent-list proxy
- `supabase/functions/_shared/sfdcAuth.ts` — JWT Bearer Flow helper (copied verbatim from `monorepo/apps/mono-calculator/supabase/functions/_shared/sfdcAuth.ts`)
- `supabase/functions/_shared/requireClayAuth.ts` — verifies the Phase-1 JWT + INTERNAL_WORKSPACES gate
- `supabase/migrations/` — Phase-1 RLS lockdown + Phase-2 `sfdc_opportunity_*` columns

The Supabase project is `hqlrnipieyeyikdyzeqt` (project URL `https://hqlrnipieyeyikdyzeqt.supabase.co`). Link the CLI in this directory before deploying:

```bash
cd apps/clay-brainstorm-extension
supabase link --project-ref hqlrnipieyeyikdyzeqt
```

### Required env vars (set as Supabase secrets, not committed)

| Secret | Used by | Where to get it |
|---|---|---|
| `SUPABASE_JWT_SECRET` | clay-auth-mint, sfdc-*, dust-proxy | Auto-populated by Supabase on every Edge Function — no action needed |
| `INTERNAL_WORKSPACES` | sfdc-*, dust-proxy | Comma-separated workspace IDs (default `4515`) |
| `SFDC_CLIENT_ID` | sfdc-* | Consumer Key of the SFDC External Client App; reuses the calculator's value |
| `SFDC_USERNAME` | sfdc-* | `sfdc_integration@clay.com` |
| `SFDC_LOGIN_URL` | sfdc-* | `https://login.salesforce.com` |
| `SFDC_PRIVATE_KEY` | sfdc-* | PEM-encoded RSA private key (same `.key` file the calculator uses) |
| `DUST_API_KEY` | dust-proxy | Workspace API key for the Clay Dust workspace |
| `DUST_WORKSPACE_ID` | dust-proxy | `5b990f8923` |
| `DUST_AGENT_ALLOWLIST` | dust-proxy | Comma-separated agent IDs (default `4CEcga0fGM`) |

Set with the Supabase CLI:

```bash
supabase secrets set --project-ref hqlrnipieyeyikdyzeqt \
  INTERNAL_WORKSPACES=4515 \
  SFDC_CLIENT_ID=<consumer-key> \
  SFDC_USERNAME=sfdc_integration@clay.com \
  SFDC_LOGIN_URL=https://login.salesforce.com \
  DUST_WORKSPACE_ID=5b990f8923 \
  DUST_AGENT_ALLOWLIST=4CEcga0fGM

supabase secrets set --project-ref hqlrnipieyeyikdyzeqt \
  SFDC_PRIVATE_KEY="$(cat ~/Developer/monorepo/apps/mono-calculator/scripts/sfdc/sfdc_calculator_prod.key)" \
  DUST_API_KEY=<dust-workspace-api-key>
```

The calculator's full SFDC setup runbook (including how to rotate the certificate) is at `~/Developer/monorepo/apps/mono-calculator/docs/setup/SFDC_INTEGRATION.md`. The brainstorm extension reuses the **same External Client App** — if the cert is compromised, both apps lose access until it's rotated in SFDC.

### Deploy commands

```bash
# Apply migrations (Phase 1 RLS lockdown + Phase 2 sfdc_opportunity columns):
supabase db push

# Deploy Edge Functions:
supabase functions deploy clay-auth-mint
supabase functions deploy sfdc-search-opportunities
supabase functions deploy sfdc-get-opportunity
supabase functions deploy dust-proxy
```

### Cutover order (Phase 1)

Existing extension installs that haven't pulled the new version will break the moment RLS becomes restrictive — they have no JWT to present. Per the rollout plan, nobody is using the extension's Supabase storage in production yet, so this is a clean cutover. Order:

1. Deploy `clay-auth-mint` Edge Function.
2. Tell every GTME to `git pull` and reload the extension.
3. Apply the Phase-1 RLS migration (`supabase db push`).
4. Verify with one GTME: canvas load, save, realtime collaborator presence.

### Testing the SFDC connection locally

Before deploying any SFDC function, run the connection tester to confirm the cert + integration user are healthy:

```bash
# Copy/paste the calculator's prod .env values into:
cp scripts/sfdc/.env.example scripts/sfdc/.env.prod
# (or symlink to the calculator's .env.prod — same values)

SFDC_ENV=prod node scripts/sfdc/test-connection.mjs
```

Expected: a successful token exchange + a 3-row Opportunity sample query against `*.my.salesforce.com`.

### Rotating the Supabase JWT secret

If the project JWT secret leaks (it's auto-managed by Supabase, so this would require a Supabase support ticket), every minted JWT becomes invalid and the extension will surface 401s until users reload. There's no rotation playbook beyond Supabase's UI; the extension's auth client will recover automatically on the next page load.

### Rotating the Dust API key

```bash
supabase secrets set --project-ref hqlrnipieyeyikdyzeqt DUST_API_KEY=<new-key>
supabase functions deploy dust-proxy  # evicts the SW's old in-memory state
```

Reps don't need to do anything — the key never lived on the client.

## Setup (per maintainer machine)

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

1. Copies every source file into `$BUILD_OUT` except entries in `build.config.js → exclude` (e.g. `src/sfdc.js`, `src/internal-bg.js`, `src/dust-poc.js`, the entire `supabase/` and `scripts/` directories, `docs/`, this repo's `.git`, the build tooling itself, this file).
2. Strips every `__CB_INTERNAL_ONLY_BEGIN: <name>` … `__CB_INTERNAL_ONLY_END` sentinel block from `.js`/`.css` files. Existing names: `pricingComparison`, `dustPoc`, `sfdc`, `gtmeExport`, `dealopsExport`, `legacyPricing`.
3. Runs the ordered branding substitutions in `build.config.js`. Today that swaps the toolbar label `GTME View` → `Scoping`, the repo URL fragment `qr3naud/scoping` → `qr3naud/self-scoping`, and the install dir `clay-scoping-extension` → `clay-self-scoping-extension`. Manifest name and console log prefix stay `Clay Scoping Tool` / `[Clay Scoping]`.
4. Re-serializes `manifest.json` with `src/sfdc.js`, `src/pricing-comparison.js`, `src/dust-poc.js` filtered out of `content_scripts[].js`, `styles/sfdc.css` + `styles/dust-poc.css` filtered out of `content_scripts[].css`, and the `background` field deleted (the public build has no service worker — no SFDC/Dust/auth-mint proxying to do).
5. Writes a fresh `.gitignore` (`config.publicGitignore`) into the output.
6. Commits + pushes to `qr3naud/self-scoping`.

**Note on the public extension and Phase 1 auth:** the public build ships `src/auth.js` and the JWT flow. Without a service worker (`background` is dropped) it cannot mint JWTs, so the public extension currently cannot read/write any canvases — RLS denies anon. This is acceptable because the public extension is for self-scoping users who can stand up their own Supabase project; full public-extension parity is out of scope for this rollout (see [docs/](./docs/) for the open work).

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

For whole-file removal (like `src/sfdc.js`), add the path to `build.config.js → exclude`. If the file is also injected by the manifest, add it to `excludeFromManifestScripts` (or `excludeFromManifestStyles` for CSS) so the manifest's `content_scripts[].js/css` arrays drop it cleanly.

## Workspace partition (historical)

`popup.js` (`fetchCanvases`) and `src/home.js` (`loadCanvases`) filter the Supabase canvases list by `workspace_id` derived from the URL / active Chrome tab. This used to be a UX boundary only — anyone with the anon key could query other workspaces. **As of v3.27 it's also a security boundary**: RLS enforces `workspace_id ∈ jwt.workspaces` server-side. The client-side filter still runs (for UX), but the server is now the authority.

## Bumping the version

Per repo convention every meaningful change bumps `manifest.json → version` in the same commit. The public build inherits the same number — no separate version field.
