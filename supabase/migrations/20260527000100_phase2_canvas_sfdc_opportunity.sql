-- Phase 2: anchor each brainstorm canvas to a Salesforce Opportunity.
--
-- Mirrors the calculator's `customer_accounts.sfdc_opportunity_{id, name, url}`
-- shape from monorepo/apps/mono-calculator. A canvas with a linked opportunity
-- displays a "Acme Inc - Q3 Expansion" pill in the toolbar with a click-through
-- to the SFDC record; canvases without a link show a "Link opportunity"
-- button that opens the typeahead picker (see src/sfdc.js).
--
-- All three columns are nullable — most canvases will not have a linked opp.
-- The Phase-1 RLS policy on `canvases` (canvases_member_only) covers these
-- columns automatically by virtue of being a FOR ALL policy, so no new
-- policies are needed.

BEGIN;

ALTER TABLE public.canvases
  ADD COLUMN IF NOT EXISTS sfdc_opportunity_id   text,
  ADD COLUMN IF NOT EXISTS sfdc_opportunity_name text,
  ADD COLUMN IF NOT EXISTS sfdc_opportunity_url  text;

-- Index for "show me all canvases linked to opportunity 006..." reverse
-- lookups. Partial index keeps it tiny — the vast majority of canvases
-- will have NULL sfdc_opportunity_id and don't need to take up B-tree
-- pages.
CREATE INDEX IF NOT EXISTS canvases_sfdc_opportunity_id_idx
  ON public.canvases (sfdc_opportunity_id)
  WHERE sfdc_opportunity_id IS NOT NULL;

COMMIT;
