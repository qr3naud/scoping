# Clay Extensions — Business Value Context

> **Read this first.** This document explains *why* these extensions exist, who they serve, and what problems they solve. For technical architecture (API shapes, DOM selectors, data structures), see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## The Organizational Context

The **end users** of these extensions are **GTMEs (Go-to-Market Engineers)** and **SEs (Sales Engineers)** at Clay. Quentin's role on GTM Ops is to build tools that make their day-to-day work faster and less painful — specifically the scoping and POC phases of the sales process, which are full of manual steps and fragile handoffs today.

These Chrome extensions exist because of a specific bottleneck in Clay's **Quote-to-Cash (QTC) pipeline**. They are not generic utilities — they address the gap between how Clay sells and the tooling available.

**The QTC stack:** Salesforce → **DealOps** (scoping/pricing) → MonetizeNow (quoting/CPQ) → Stripe (billing) → Clay Admin (provisioning)

**DealOps** is an external vendor tool (founded by ex-Stripe engineers) that Clay bought to replace Google Sheets for credit scoping and pricing. It was designed to be the place where GTMEs configure use cases, calculate credit costs, and generate pricing proposals with waterfall charts and breakdowns.

**The problem:** DealOps sits *downstream* of the actual bottleneck. The hardest part of the QTC process isn't *"how do I turn a scope into a pricing slide"* — it's *"how do I turn a customer conversation into a good scope."* After talking to 10+ GTMEs and SEs, the finding was clear: **DealOps could be used but currently will not help anyone save time.** It doesn't add more value than the spreadsheets + GTME calculator it was meant to replace.

---

## Who uses these extensions and why

### GTMEs (Go-to-Market Engineers) — Brainstorm Extension

GTMEs are the reps who scope deals. Today, they calculate credits and price across **multiple Google Sheets, Google Slides, and Slack**. The brainstorm extension lets them **scope directly from the product** — connecting data points and enrichments and estimating credit cost visually, instead of switching between Clay's table view and external spreadsheets.

> *"I want to get rid of the table view, and create something a lot softer — just little cards that can be dragged, where I could also drag from an edge to connect, where I could select waterfalls and it would sort of group the different providers, but no set-up required. It's a brainstorming tool that would be connected to all the enrichments available."*

The canvas provides a spatial, freeform mode for the *planning* phase that Clay's grid UI doesn't support. GTMEs can arrange enrichments, group waterfalls, see credit cost summaries, and estimate total spend for N records — all before committing anything to a table.

### SEs (Sales Engineers) — Export Extension

SEs build the actual Clay tables during POCs. They are **managing 8+ Google Sheets per POC**. The POC maximizes coverage (all enrichments turned on), but production scoping uses fewer credits — so POC output doesn't directly translate into a usable scope. The export extension lets SEs **automatically export POC results** as structured JSON. Today it's a download; in the future it connects to DealOps.

> *"For the SE to automatically export POC results — for now it downloads a JSON, in the future it will connect to DealOps."*

The export gives a single structured snapshot of a workbook's enrichments, waterfalls, credit costs, fill rates, and record counts — replacing manual copy-paste from Clay's UI into spreadsheets.

### The Collaboration Gap

DealOps was designed **only with GTMEs in mind**. Avi (DealOps head of tech) said they've *never thought about sales engineers as an end-user of DealOps*, and that collaborative features between reps and SEs have been "out of scope" historically. But the reality is:

1. **GTME** fills the technical scoping doc
2. **SE** builds a Clay table, then uploads results back to the scoping doc
3. **SE** manually fills POC results in a spreadsheet
4. **GTME** manually copies the results to DealOps

**The bottleneck is steps 1–3** (the upstream scoping and POC work), **not step 4** (entering data into DealOps). These extensions attack the bottleneck directly — the brainstorm canvas helps GTMEs scope, and the export extension helps SEs extract results — so the handoff to DealOps becomes trivial.

The biggest change DealOps needs: **from a rep tool to a collaborative tool** where GTMEs, SEs, Deal Desk, and Finance all participate.

---

## What problems do these solve?

### 1. The scoping bottleneck is upstream of DealOps

DealOps handles *"scope → pricing slide."* But the pain is *"customer conversation → scope."* That requires understanding Clay's enrichment catalog, connecting data points to enrichments (which are different things — vocabulary matters), estimating credit costs, and figuring out waterfall sequences. The brainstorm canvas is purpose-built for exactly this stage.

### 2. Data points ≠ enrichments, and both matter

Customers care about **data points** (the individual fields they get back). Pricing is about **enrichments** (the provider call that returns those data points). A single enrichment can produce multiple data points. The scoping tools need to bridge both views — what the customer wants (data points) and what it actually costs (enrichments). This distinction is a core design constraint.

### 3. SEs have no way to extract POC results programmatically

Before the export extension, getting workbook metadata out of Clay required browser console `fetch` snippets — fragile, unrepeatable, and inaccessible to non-technical users. SEs were manually copying enrichment results, fill rates, and credit costs into spreadsheets. The extension productizes this into a toolbar button.

### 4. Credit cost estimates are unreliable and scattered

Reps need to estimate credit spend before committing at volume. But cost data is scattered across Clay's UI, and there's an open question about how reliable pre-run costs are as estimates. The extensions surface credit information in context — per-card on the brainstorm canvas, per-enrichment in the export — and support both old and new pricing models (Clay's pricing changed in 2026, splitting into data/action-execution/private-key credits).

### 5. Manual handoffs between too many surfaces

The current workflow spans Clay's product UI, 8+ Google Sheets, Google Slides, Slack, DealOps, and Salesforce. Every boundary is a manual copy-paste. The extensions reduce boundaries by keeping scoping (brainstorm) and results extraction (export) inside Clay's own interface, where the work already happens.

---

## Why this matters strategically

| Priority | What it means |
|----------|---------------|
| **Collaborative** | DealOps must serve GTMEs, SEs, Deal Desk, *and* Finance — not just reps |
| **Correctness** | Completeness of data points, accurate enrichment costs (averages), correct data |
| **Ease of Use** | DealOps should guide reps on *how to price*, not just enable them — built around best practices |
| **Maintenance** | Rules, data points, templates, and slides must be easy to update and always accurate |
| **Enablement** | How to price ≠ how to use the tool — both need support |

The extensions address **Correctness** (structured, programmatic data instead of manual transcription), **Ease of Use** (visual scoping instead of spreadsheets), and **Collaborative** (giving SEs a tool that feeds into the same pipeline as GTMEs).

---

## Timeline and context

- **April 10, 2026** — DealOps Beta release (to reps already familiar, no live support from GTM Ops)
- **May 6, 2026** — Scheduled enablement session, official rollout
- **Goal** — 100% of deal desk proposals from GTME + GS teams through DealOps by end of rollout

The Chrome extensions are **supplementary tools** demo-ed to reps and SEs as prototypes. They fill the gap that DealOps doesn't cover — the upstream scoping and POC extraction work — and are positioned to eventually connect to DealOps via its API.

---

## Two tools, one pipeline

| Extension | Persona | Job | Future state |
|-----------|---------|-----|-------------|
| **Brainstorm** (canvas) | GTMEs | Turn a customer conversation into a structured scope — enrichments, waterfalls, credit estimates — visually, inside Clay | Feeds scoping data into DealOps |
| **Export** (JSON snapshot) | SEs | Extract POC results — enrichments, fill rates, credit costs — from a live Clay workbook in one click | Pushes results directly to DealOps |

Both are **internal Chrome extensions** (no Chrome Web Store approval needed), injected into Clay's toolbar. They're designed to feel native to the platform and coexist in the same toolbar location.

---

## The bigger picture

DealOps has the potential to be the **collaborative tool** GTMEs, SEs, and Finance use to get from scoping to quote as efficiently as possible. But multiple trade-offs remain:

- **What should live in Clay's product long-term vs. in DealOps?**
- **DealOps leans toward standardization while the GTM team wants flexibility upstream**
- **DealOps → MonetizeNow is not directly integrated** — pricing must be manually transferred for quoting
- **Should DealOps handle renewals, expansions, and amendments — or keep those in MonetizeNow?**

The extensions are a pragmatic bet: rather than waiting for DealOps to solve the full pipeline, **build thin tools that attack the upstream bottleneck now** and connect downstream later.
