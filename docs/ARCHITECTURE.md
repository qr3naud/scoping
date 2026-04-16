# Clay Brainstorm Extension — Technical Architecture

Living document of everything we've learned about how this extension interacts with Clay's codebase.
Last verified against codebase: 2026-04-14.

> **Start with [`BUSINESS-CONTEXT.md`](./BUSINESS-CONTEXT.md)** for the "why" — who uses these extensions, what problems they solve, and how they fit into the Quote-to-Cash pipeline.

---

## What This Extension Does

A Chrome extension (Manifest V3) that injects a **visual brainstorming canvas** into `app.clay.com`. Users can:

- Browse and multi-select enrichments from Clay's native picker
- Place them as draggable cards on an infinite canvas
- Connect cards with arrows (bezier curves)
- Group cards into "waterfall" groups (and nest groups into super-groups)
- Pick AI models on AI-type cards and see credit cost changes
- Import enrichment columns from an existing Clay table
- Estimate total credit usage (credits/row × record count)
- Manage multiple named canvas tabs per workbook, persisted in localStorage

---

## File Structure

Content scripts share a single execution context — Chrome injects them into the page in `manifest.json` order. No ES module imports; files communicate through the shared `window.__cb` namespace (see below).

```
manifest.json          Extension identity, permissions, content script injection
icons/                 Extension icons (16, 32, 48, 128px)
src/
  config.js            Namespace init, constants, AI model lists, shared utilities
  api.js               Clay API fetch calls (enrichments, pricing, tables)
  canvas/              Canvas package (loaded in manifest order)
    svg.js             SVG element helper(s)
    geometry.js        Bezier/line and card-edge geometry helpers
    graph-queries.js   Card/link query helpers
    groups.js          Group theme helpers and palette options
    credits.js         Credit calculation helpers (DP + group badge)
    connections.js     Connection module placeholder for extraction
    connect-flow.js    Click-to-connect module placeholder for extraction
    ui.js              Canvas UI module placeholder for extraction
    index.js           Canvas orchestrator/entrypoint, exposes __cb.initCanvas
  tabs.js              Tab persistence (localStorage) + tab bar UI
  picker.js            Picker mode — dialog detection, checkbox injection, selection banner
  table-import.js      Import enrichment columns from a Clay table + table picker dropdown
  overlay.js           Canvas overlay UI — topbar, summary bar, toolbox, open/close
  toolbar.js           Toolbar button injection + DOM observer (entry point)
styles/
  button.css           Toolbar button, float fallback
  picker.css           Checkboxes, selection banner
  overlay.css          Overlay, topbar, tabs, toolbar buttons, summary bar
  canvas.css           Canvas area, SVG layer, connections, selection box
  cards.css            Enrichment cards, data point cards, handles, badges
  groups.css           Waterfall groups, super groups
  pickers.css          Model picker, table picker, toolbox, bulk input
docs/
  ARCHITECTURE.md      This file — technical reference, API shapes, DOM injection, bugs
  BUSINESS-CONTEXT.md  Why this exists — personas, problems, strategic context
```

### Cross-file communication (`window.__cb`)

`config.js` creates the `window.__cb` namespace. Every other file reads from and writes to it:

- **Shared state** — `__cb.enrichmentLookup`, `__cb.actionByIdLookup`, `__cb.livePricingByModel`, `__cb.overlayEl`, `__cb.tabStore`, `__cb.canvas`
- **Shared functions** — `__cb.fetchEnrichments()`, `__cb.openCanvas()`, `__cb.startPickerMode()`, `__cb.saveTabs()`, etc.
- **Cross-file callbacks** — `__cb.onCanvasStateChange`, `__cb.updateCreditTotal`, `__cb.updateGroupButtonVisibility`, `__cb.onEnrichmentToolClick` (set by overlay.js, called by the canvas package entrypoint)

Anything declared with `const`/`let` inside a file's IIFE stays private to that file. Only things explicitly assigned to `__cb` are visible to other files.

### Load order

`manifest.json` lists scripts in dependency order:

1. `config.js` — creates `window.__cb`, defines constants and utility functions
2. `api.js` — adds fetch functions to `__cb`
3. `canvas/svg.js`
4. `canvas/geometry.js`
5. `canvas/graph-queries.js`
6. `canvas/groups.js`
7. `canvas/credits.js`
8. `canvas/connections.js`
9. `canvas/connect-flow.js`
10. `canvas/ui.js`
11. `canvas/index.js` — canvas package entrypoint, exposes `__cb.initCanvas`
12. `tabs.js` — tab persistence and UI, uses canvas + config
13. `picker.js` — enrichment picker mode, uses api + config
14. `table-import.js` — table import logic, uses api + canvas
15. `overlay.js` — overlay UI, uses everything above
16. `toolbar.js` — entry point, injects button and starts the observer

---

## API Endpoints Used

### 1. `GET /v3/actions?workspaceId={id}`

**What it does:** Fetches all available enrichment actions for a workspace.

**Called from:** `src/api.js` → `__cb.fetchEnrichments()`

**Backend handler:** `apps/api/v3/tables/routes/action.routes.ts` lines 47–118, class `GetActions`

**Response shape:** `{ actions: Action[] }` (top-level object, no `data` wrapper)

Each action is filtered through `_.pick` with this whitelist:
`key`, `version`, `package`, `displayName`, `description`, `categories`,
`inputParameterSchema`, `outputParameterSchema`, `suggestedOutputParams`,
`auth`, `isPublic`, `batchSettings`, `forceVisibleForWorkspaceIds`, `isSource`,
`requiredInputCombinations`, `supportsCustomRateLimitRules`, `publicKeyRateLimitRules`,
`rateLimitRules`, `canPreview`, `actionLabels`, `iconUri`, `documentationUri`,
`pricing`, `isPaginationAvailable`, `actionEnablementInfo`, `semanticSearchEmbeddings`

**Type definitions:**
- `Action`: `libs/shared/src/actions/base-types.ts` lines 129–195
- `ActionPackage`: same file lines 32–42
- `ActionPricing`: same file lines 71–98

**Frontend fetch:** `apps/frontend/src/services/ClayAPI/api-routes.ts` lines 568–572, consumed by `useInitActions.ts`

**How the extension uses it:** Builds two lookup maps:
- `__cb.enrichmentLookup` — keyed by lowercase `displayName`, for matching picker rows to API data
- `__cb.actionByIdLookup` — keyed by `{packageId}-{actionKey}`, for matching table fields to actions

#### NOTE: Credit structure

`ActionPricing.credits` is `{ [creditType in CreditType]?: number }` where `CreditType` includes `'basic'`, `'longExpiry'`, `'actionExecution'`. So `pricing.credits.basic` is valid *when credits exist*, but:
- Credits are optional at every level
- There's also `prePricingChange2026` / `postPricingChange2026` pricing buckets (extension reads `post` first, falls back to root)
- AI action costs are **model-dependent**, resolved via `calculateCreditCostForModel(model, useCase)` in `libs/shared/src/ai/models.ts`

#### VERIFIED: `actionExecution` is binary (0 or 1)

Confirmed via live API (1,218 actions, 572 with non-null value):
- Every action's `pricing.credits.actionExecution` is **exactly 0 or 1** — never fractional
- 0 = no execution credit charged; 1 = one execution credit charged
- `null` = field not present (extension treats as 0)

**Waterfall execution costs:**
- No API endpoint provides a pre-computed execution cost for waterfalls
- The `/v3/attributes` waterfall data has `actionIds[]` but no pricing fields
- In practice, waterfalls cost **1 execution** (most common) or **2 executions** (some waterfalls)
- The extension defaults all waterfalls to **1 execution** (`fetchWaterfallExecCosts()` and table import both hardcode this). If specific waterfalls are known to cost 2, add overrides as needed

### 2. `GET /v3/model-pricing/{workspaceId}/base-costs`

**What it does:** Fetches live credit costs per AI model for a workspace.

**Called from:** `src/api.js` → `__cb.fetchModelPricing()`

**How the extension uses it:** Populates `__cb.livePricingByModel` (keyed by model name), which overrides the hardcoded defaults in `DEFAULT_AI_MODELS` when available.

### 3. `GET /v3/workbooks/{workbookId}/tables`

**What it does:** Fetches all tables in a workbook with their fields, views, and field groups.

**Called from:** `src/api.js` → `__cb.fetchTableList()`

**Backend handler:** `apps/api/v3/workbooks/routes/workbook.routes.ts` lines 109–139

**Response shape:** Direct array (not wrapped in an object):
```
[
  {
    id: string,
    name: string,              // human-readable table name
    fields: SerializedField[], // array of columns
    views: SerializedView[],
    fieldGroupMap: Record<groupId, FieldGroup> | null,
    owner: LightweightUser,
    workspaceId: number,
    workbookId: string,
    description: string,
    type: TableType | null,
    icon: Icon | null,
    tableSettings: TableSettings,
    createdAt: string,
    updatedAt: string,
    ...abilities, ...other props
  }
]
```

**Type definitions:**
- `SerializedTableDetails`: `apps/api/v3/tables/domain/tables/table-serializer.ts` lines 30–33
- `SerializedTable` / `Table`: `libs/shared/src/tables/base-types.ts` lines 510–544
- `SerializedField`: `libs/api-contract/src/tables/fields/interfaces.ts` lines 84–85 (union of Action, Basic, Source)

**NOTE:** `recordCount` does not exist on this response. Row counts come from view-level APIs (e.g. `useGetViewRecordCount`).

---

## Key Data Structures

### Fields (columns in a Clay table)

```
enum FieldType {
  BASIC = 'basic',    // raw/formula column
  ACTION = 'action',  // enrichment-backed column
  SOURCE = 'source',  // source column
}
```

Defined in: `libs/shared/src/fields/field.ts` lines 27–31

**Action fields** (`SerializedActionField`, `libs/shared/src/fields/action-field.ts` lines 68–97):
- `type: "action"`
- `typeSettings.actionKey` — which enrichment action this column runs (kebab-case, e.g. `"use-ai"`)
- `typeSettings.actionPackageId` — which package/provider it belongs to
- Also: `actionVersion`, `authAccountId`, `inputsBinding`, `batchRunSettings`, etc.

### Field Groups (waterfall grouping)

`fieldGroupMap`: `Record<string, FieldGroup>` — lives on the table object.

Defined in: `libs/shared/src/tables/base-types.ts` line 314

**Group types** (`FieldGroupType`):
- `basic` — simple column grouping (type name in code: `GenericGroup`)
- `waterfall` — sequential enrichment fallback chain
- `message` — messaging-related
- `clay_sequencer` — campaigns/sequencer

**Waterfall groups** (`WaterfallGroup`, lines 274–290):
- `type: "waterfall"`
- `name` — optional string (the ONLY name field; `displayName` does NOT exist on groups)
- `groupDetails.sequenceSteps[]` — ordered array of steps
- `groupDetails.mergeField` — `{ fieldId, fieldName? }`
- `groupDetails.dataProviderField` — optional `{ fieldId }`
- `settings` — `WaterfallSettings`

**Waterfall steps** (`WaterfallSequenceStep`, discriminated union on `type`):
- **Action step** (lines 206–216): `{ type: "action", fieldId, actionPackageId, actionKey, attributePath, authAccountId, inputsBinding, isSkipped?, validation }`
- **Formula step** (lines 218–222): `{ type: "formula", fieldId, formulaText }`

**Basic groups** (`GenericGroup`, lines 185–191):
- `type: "basic"`
- `groupDetails.fields[]` — array of `{ id: string, isOutputField?: boolean }`

### AI Action Detection

The extension detects AI actions by checking **package ID UUIDs** and **kebab-case action keys** (defined in `src/config.js`):

```js
const AI_PACKAGE_IDS = new Set([
  "67ba01e9-...",  // AI (use-ai, claygent)
  "3b5e83c7-...",  // GPT_3 (chat-gpt-schema-mapper, chat-gpt-vision)
  "f3d610ac-...",  // ANTHROPIC (claude-ai)
  "3504dfb7-...",  // GOOGLE_GEMINI (google-gemini)
]);

const AI_ACTION_KEYS = new Set([
  "use-ai", "claygent", "chat-gpt-schema-mapper",
  "chat-gpt-vision", "claude-ai", "google-gemini",
]);
```

The authoritative model list is in `libs/shared/src/ai/models.ts` → `modelOptions` array + `MODEL_NAMES` enum. Credit costs are **per-model AND per-use-case**, resolved via `calculateCreditCostForModel()`.

---

## DOM Injection Points

### Toolbar button ("Brainstorm")

**Target selector** (defined in `src/config.js`):
```
#clay-app > div > main > div > div > div > div > div >
div.flex.min-h-0.flex-1.flex-col > div > div > div >
div.relative.flex.size-full.shrink.grow.flex-col.overflow-hidden >
div.flex.flex-none.flex-row.items-center.justify-between.px-3.py-2 >
div.flex.flex-row.items-center.gap-x-2
```

VERIFIED: The last two segments match `TableToolbar.tsx`:
- Outer: `className="flex flex-none flex-row items-center justify-between px-3 py-2"` (line 96)
- Inner (right group): `className="flex flex-row items-center gap-x-2"` (line 131)

RISK: The intermediate path (`#clay-app > div > main > ...`) depends on parent layout wrappers NOT defined in `TableToolbar.tsx`. Any layout restructuring breaks this.

RISK: When `isBulkEnrichmentTable` is true, `BigSourceTableToolbar` renders instead — this selector won't match.

**Fallback:** If the toolbar isn't found within 30 seconds (60 attempts x 500ms), a floating button is placed at bottom-right.

**Frontend components involved:**
- `apps/frontend/src/components/TableToolbar/TableToolbar.tsx` — main toolbar
- `apps/frontend/src/components/CallToActionButtons/index.tsx` — "Add enrichment", etc.

### Enrichment picker hijacking

The extension watches for Clay's enrichment picker dialog (logic in `src/picker.js`):
- Detects `[role="dialog"]` elements with an `<h2>` containing "add enrichment"
- Injects checkboxes into rows identified by `p[data-slot="text"]` (reliable, source-level attribute)
- Intercepts clicks to toggle selection instead of adding enrichments directly

**Frontend components involved:**
- `apps/frontend/src/components/EnrichmentPanel/index.tsx` — the modal, header "Add enrichment"
- `apps/frontend/src/components/EnrichmentPanel/EnrichmentRows.tsx` — `ActionRow`, `PresetRow`, `WaterfallRow`
- `apps/frontend/src/glaze-components/explore-panel.tsx` — `RowWrapper` component (line 77)

### Canvas overlay positioning

The overlay (built in `src/overlay.js`) positions itself below Clay's header using:

```js
document.querySelector("#clay-app header") ??
document.querySelector("#clay-app nav") ??
document.querySelector("#clay-app > div > div:first-child");
```

**Frontend components involved:**
- `apps/frontend/src/glaze-components/stacked-layout.tsx` — `StackedLayoutNavbar` wraps navbar in `<header>`
- `apps/frontend/src/glaze-components/navbar.tsx` — `Navbar` renders `<nav>`

---

## URL Parsing

The extension extracts IDs from the browser URL (in `src/config.js` → `__cb.parseIdsFromUrl()`):

```
https://app.clay.com/workspaces/{workspaceId}/workbooks/{workbookId}/...
```

VERIFIED: This matches the frontend routing:
- `buildWorkbookUri`: `apps/frontend/src/routes/ui-routes.ts` lines 405–407
- Route component: `apps/frontend/src/routes/Workspace.tsx` lines 385–391 → `WorkbookProvider` → `Workbook`
- Nested routes: `.../tables/{tableId}`, `.../views/{viewId}`

---

## Persistence

Canvas state is stored in **localStorage** per workbook (managed by `src/tabs.js`):

- **Key format:** `cb-tabs-{workbookId}`
- **Value:** `{ activeId, tabs: [{ id, name, hidden, state }] }`
- **Tab state:** `{ cards, connections, groups, view: { panX, panY, scale }, nextCardId, nextConnId, nextGroupId, records }`

Migration from old single-canvas format: `cb-canvas-{workbookId}` → multi-tab format.

Save is debounced (500ms) and also triggered on `beforeunload`.

---

## Authentication

All API calls use `{ credentials: "include" }` — they piggyback on the user's existing Clay session cookies. No separate auth is needed. Any endpoint the logged-in user can access from `app.clay.com`, the extension can also call.

The extension only has `activeTab` permission and `host_permissions` for `https://api.clay.com/*`.

---

## Open Issues

| # | Category | Issue | Risk |
|---|----------|-------|------|
| 1 | DOM | Toolbar CSS selector depends on deep DOM path that can change | Medium — has floating button fallback |
| 2 | DOM | `data-sentry-component` attributes are build-injected, not in source | Medium — extension uses `p[data-slot="text"]` instead |
| 3 | API | `recordCount` read from table response — field doesn't exist | Low — gracefully null |

---

## Key Codebase References

| Topic | Path |
|-------|------|
| GET /v3/actions handler | `apps/api/v3/tables/routes/action.routes.ts` (47–118) |
| GET /workbook/tables handler | `apps/api/v3/workbooks/routes/workbook.routes.ts` (109–139) |
| Action, ActionPackage, ActionPricing types | `libs/shared/src/actions/base-types.ts` |
| AI action detection (isAIAction) | `libs/shared/src/ActionDefinitions.ts` (663–669) |
| AI model list & credit costs | `libs/shared/src/ai/models.ts` (modelOptions, MODEL_NAMES) |
| Credit cost calculation | `libs/shared/src/credits/credit-cost-utils.ts` |
| Table / FieldGroupMap / Waterfall schemas | `libs/shared/src/tables/base-types.ts` |
| SerializedField union | `libs/api-contract/src/tables/fields/interfaces.ts` (84–85) |
| SerializedActionField | `libs/shared/src/fields/action-field.ts` (68–97) |
| FieldType enum | `libs/shared/src/fields/field.ts` (27–31) |
| Table serializer | `apps/api/v3/tables/domain/tables/table-serializer.ts` |
| Frontend actions/tables URLs | `apps/frontend/src/services/ClayAPI/api-routes.ts` |
| Frontend routing | `apps/frontend/src/routes/ui-routes.ts`, `Workbook.tsx`, `Workspace.tsx` |
| Enrichment modal + rows | `EnrichmentPanel/index.tsx`, `EnrichmentRows.tsx` |
| RowWrapper component | `glaze-components/explore-panel.tsx` (77) |
| Text component (data-slot) | `glaze-components/text.tsx` |
| Table toolbar | `TableToolbar/TableToolbar.tsx`, `CallToActionButtons/index.tsx` |
| Stacked layout / navbar | `glaze-components/stacked-layout.tsx`, `glaze-components/navbar.tsx` |
| Dialog/modal primitives | `glaze-components/dialog.tsx`, `glaze-components/modal.tsx` |
| ClientAction transform | `libs/shared/src/actions/base-types.ts` (303–310) |
