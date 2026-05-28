# Clay Scoping Tool — maintainer notes

User-facing install instructions live in [`README.md`](./README.md). This file is for whoever is editing the extension code.

## Two extensions, one source tree

This repo (`qr3naud/scoping`) is the **internal** extension. A near-identical **public** spin-off lives at [`qr3naud/self-scoping`](https://github.com/qr3naud/self-scoping), produced by `build.js` from this same source tree — never edited directly.

Both builds ship the same JS and CSS. The public build only differs by what it *omits*: `docs/` (genuine internal-only context), `supabase/` and `scripts/` (server-side, deployed separately), `AGENTS.md` and build tooling. The actual feature gating happens at runtime via the `features` claim on the Phase-1 JWT — see the next section.

## Auth model (Phase 1, v3.27+)

Every Supabase request the extension makes is authenticated by a per-Clay-user JWT minted by the `clay-auth-mint` Edge Function. RLS on every table the extension touches gates rows by `workspace_id ∈ jwt.workspaces`. The anon role has no privileges.

Flow (see [`src/auth.js`](./src/auth.js) and [`src/internal-bg.js`](./src/internal-bg.js)):

1. Content script asks the service worker for a JWT via `chrome.runtime.sendMessage({ type: "cb:auth:mint" })`.
2. Service worker reads the user's `api.clay.com` cookies via `chrome.cookies.getAll` (HttpOnly — content script can't) and posts them in the `x-clay-cookie` header to `clay-auth-mint`.
3. `clay-auth-mint` re-validates the cookie by calling `https://api.clay.com/v3/me` server-side; if Clay returns 200, it then asks `/v3/users/:id/workspaces` for the authoritative workspace membership list. Both are forwarded with the cookie; nothing is logged or persisted.
4. The function signs a JWT with `CB_JWT_SECRET` (HS256, 1h expiry — set to the project's JWT secret from the Supabase dashboard) containing `{ sub, email, role: "authenticated", workspaces, iat, exp }` and returns it.
5. `src/auth.js` caches the JWT in `__cb.supabaseJwt` + `localStorage` and refreshes 5 min before expiry. `src/supabase.js` uses it as the `Authorization: Bearer` header on every PostgREST call; `src/realtime.js` calls `client.realtime.setAuth(jwt)` so realtime sockets get the same auth.

**Attacker model**: a random Clay user installing the public extension can only ever get a JWT containing *their own* workspaces. RLS denies access to any canvas in a workspace not in their JWT. The SFDC + Dust proxies additionally check `INTERNAL_WORKSPACES` (defaults to `4515`) before accepting any request.

## Feature flags (Phase 3, v3.28+)

The JWT minted by `clay-auth-mint` carries a `features` claim alongside `workspaces`. Internal-workspace members (anyone whose JWT contains a workspace in `INTERNAL_WORKSPACES`) get the full set; everyone else gets `[]`. Current flags:

| Flag | Gates |
|---|---|
| `internal_branding` | Toolbar button label ("GTME View" vs "Scoping") + branded copy in help text + home empty-state |
| `pricing_comparison` | Old vs New Pricing modal entry point + the modal itself |
| `gtme_export` | "Export to GTME Calculator" + "Export to DealOps" rows in the export menu |
| `dust` | "Generate POC" toolbar button + Dust popover |
| `sfdc` | Salesforce opportunity picker toolbar element + linked-opp pill |

The flag list is computed in [`supabase/functions/clay-auth-mint/index.ts`](./supabase/functions/clay-auth-mint/index.ts) (look for `INTERNAL_FEATURES`). Adding a new internal-only feature is a two-step change:

1. Add the flag name to `INTERNAL_FEATURES` in `clay-auth-mint/index.ts` and redeploy.
2. At the extension call site, gate the UI on `__cb.hasFeature("your_flag")`.

For UI that exposes a public API surface (like `__cb.sfdc = { ... }` in `src/sfdc.js` or `__cb.startDustPoc` in `src/dust-poc.js`), wrap the assignment in a `publishApi()` helper that runs only when the feature is on. Consumers can then use `__cb.thing?.method` and short-circuit naturally when the feature is off.

**This is a UX filter, not a security boundary.** A user who edits `__cb.userFeatures` in DevTools can re-render hidden buttons, but the SFDC/Dust proxies re-verify `INTERNAL_WORKSPACES` server-side via `requireClayAuth`, and the database enforces RLS on `workspace_id ∈ jwt.workspaces`. The flag list just keeps the UI honest.

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
| `CB_JWT_SECRET` | clay-auth-mint, sfdc-*, dust-proxy | Supabase Dashboard → Settings → API → JWT Settings → JWT Secret. **Important:** the obvious name `SUPABASE_JWT_SECRET` is reserved by Supabase (`SUPABASE_*` prefix can't be set as a custom secret), so we use `CB_*` instead. |
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
# Grab the JWT secret value from Supabase Dashboard → Settings → API
# (or use `supabase status` after linking) and paste it as CB_JWT_SECRET:
supabase secrets set --project-ref hqlrnipieyeyikdyzeqt \
  CB_JWT_SECRET=<dashboard-jwt-secret> \
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

> **Critical:** `clay-auth-mint` MUST be deployed with JWT verification **off** at the Supabase gateway, because it is the bootstrap that mints the user's first JWT — it cannot itself require one to be invoked. The `verify_jwt = false` setting in [`supabase/config.toml`](./supabase/config.toml) makes this stick across deploys. If you ever see every Edge Function call from the extension fail with `{"code":"UNAUTHORIZED_NO_AUTH_HEADER"}`, the config wasn't applied — re-deploy with the explicit flag:
>
> ```bash
> supabase functions deploy clay-auth-mint --no-verify-jwt
> ```
>
> The SFDC + Dust proxies stay on the default (verify_jwt = true) so the Supabase gateway does the first-pass signature check before `requireClayAuth` runs.

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

If the project JWT secret is rotated (Supabase Dashboard → Settings → API → JWT Settings → Generate new JWT secret), every minted JWT becomes invalid and the extension will surface 401s. After rotation, update the Edge Function secret too:

```bash
supabase secrets set --project-ref hqlrnipieyeyikdyzeqt CB_JWT_SECRET=<new-value>
supabase functions deploy clay-auth-mint sfdc-search-opportunities sfdc-get-opportunity dust-proxy
```

The extension's auth client will then recover on the next page load.

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

1. Copies every source file into `$BUILD_OUT` except entries in `build.config.js → exclude` (`supabase/`, `scripts/`, `docs/`, this file, `_metadata/`, build tooling, `.git`, `.gitignore`, `node_modules`, `dist`).
2. Writes a fresh `.gitignore` (`config.publicGitignore`) into the output.
3. Commits + pushes to `qr3naud/self-scoping`.

That's it — no sentinel stripping, no branding substitutions, no manifest rewrite. The public build is bit-for-bit identical to the source for every JS/CSS/HTML file the extension actually loads. Internal-only behavior (SFDC, Dust POC, pricing comparison, GTME export, "GTME View" branding) is gated at runtime by the JWT's `features` claim — see the "Feature flags" section above.

**Note on the public extension:** because the JWT mint requires reading the user's Clay session cookie (HttpOnly), the service worker (`src/internal-bg.js`) ships to the public build too. Public users who are logged into Clay get a JWT scoped to their own workspaces and can read/write canvases there — RLS denies cross-workspace access, and the SFDC/Dust proxies deny non-internal users via `INTERNAL_WORKSPACES`. The public extension is, in effect, a fully-functional "self-scoping" tool for any Clay user.

## Adding a new internal-only capability

Add a runtime feature flag:

1. **Pick a flag name** (snake_case, e.g. `my_feature`).
2. **Add it to `INTERNAL_FEATURES`** in [`supabase/functions/clay-auth-mint/index.ts`](./supabase/functions/clay-auth-mint/index.ts) and redeploy:
   ```bash
   supabase functions deploy clay-auth-mint
   ```
3. **Gate the UI** at each call site:
   ```js
   if (__cb.hasFeature("my_feature")) {
     // create button, register handler, etc.
   }
   ```
4. **For modules that expose a public surface** (`__cb.foo = { ... }`), wrap the assignment in a `publishApi()` helper that only runs when the flag is on, and re-evaluates after `__cb.supabaseJwtReady` resolves so first-install users get the API once the mint completes. See `src/sfdc.js` for the canonical pattern.
5. **For server-side gating** (proxy endpoints that should refuse non-internal users), use `requireClayAuth` from [`supabase/functions/_shared/requireClayAuth.ts`](./supabase/functions/_shared/requireClayAuth.ts) — it checks `INTERNAL_WORKSPACES` independently of the JWT's `features` claim, so a user tampering with `__cb.userFeatures` in DevTools still gets a 403.

## Workspace partition (historical)

`popup.js` (`fetchCanvases`) and `src/home.js` (`loadCanvases`) filter the Supabase canvases list by `workspace_id` derived from the URL / active Chrome tab. This used to be a UX boundary only — anyone with the anon key could query other workspaces. **As of v3.27 it's also a security boundary**: RLS enforces `workspace_id ∈ jwt.workspaces` server-side. The client-side filter still runs (for UX), but the server is now the authority.

## Bumping the version

Per repo convention every meaningful change bumps `manifest.json → version` in the same commit. The public build inherits the same number — no separate version field.
