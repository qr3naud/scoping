-- Phase 3: remember the Dust "Generate POC" run on each brainstorm canvas.
--
-- The Generate POC flow (see src/dust-poc.js) creates a Dust conversation
-- that auto-generates a POC scoping doc from the customer's Gong calls,
-- emails, etc. — a 5-10 minute job. These columns let the run survive a
-- page reload and be visible to other collaborators on the same canvas:
-- a poller resumes from `dust_conversation_id` while `dust_poc_status` is
-- "generating", and the finished Google Doc link is cached in
-- `dust_poc_doc_url` so reopening the popover shows it instantly.
--
-- All columns are nullable — most canvases will never trigger a POC.
-- The Phase-1 RLS policy on `canvases` (canvases_member_only) is FOR ALL,
-- so it covers these columns automatically; no new policies are needed.
--
-- `dust_poc_status` is a plain text status rather than an enum so we can
-- add states without a type migration. Current values:
--   'generating' — conversation created, agent still working
--   'done'       — agent finished, dust_poc_doc_url populated
--   'error'      — agent failed or the poller timed out

BEGIN;

ALTER TABLE public.canvases
  ADD COLUMN IF NOT EXISTS dust_conversation_id  text,
  ADD COLUMN IF NOT EXISTS dust_conversation_url text,
  ADD COLUMN IF NOT EXISTS dust_poc_status       text,
  ADD COLUMN IF NOT EXISTS dust_poc_doc_url       text,
  ADD COLUMN IF NOT EXISTS dust_poc_started_at   timestamptz;

COMMIT;
