-- Phase 1: lock down the brainstorm-extension Supabase project with RLS scoped
-- to Clay workspace membership (per the JWT minted by clay-auth-mint).
--
-- Before this migration: every table had a `USING (true) WITH CHECK (true)`
-- policy granted to `public`, so the hardcoded anon key shipped in the
-- extension granted full read/write/delete across every workspace's canvases.
-- The public-spin-off extension on GitHub made that effectively a public
-- leak of every customer's scoping data.
--
-- After this migration: only `authenticated` callers (those carrying a JWT
-- from clay-auth-mint) can touch any row, and only for workspace_ids in
-- their JWT's `workspaces` claim. Anon is revoked entirely.
--
-- See apps/clay-brainstorm-extension/supabase/functions/clay-auth-mint/index.ts
-- for the JWT structure: { sub, email, role: 'authenticated', workspaces[], iat, exp }.

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Drop the existing wide-open permissive policies. They were always going
--    to be a misnomer — RLS was "on" but did nothing.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow all access to canvases" ON public.canvases;
DROP POLICY IF EXISTS "Allow all access to canvas_tabs" ON public.canvas_tabs;
DROP POLICY IF EXISTS "Allow all access to contributors" ON public.canvas_contributors;
DROP POLICY IF EXISTS "Allow all access to users" ON public.users;

-- ----------------------------------------------------------------------------
-- 2) Ensure RLS is enabled on every table the extension touches. Idempotent.
-- ----------------------------------------------------------------------------
ALTER TABLE public.canvases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvas_tabs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvas_contributors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 3) Revoke anon entirely. With the wide-open policies gone above, anon
--    wouldn't match any rows; revoking the table grant is belt-and-braces
--    against any future policy regression that accidentally re-permits anon.
-- ----------------------------------------------------------------------------
REVOKE ALL ON public.canvases             FROM anon;
REVOKE ALL ON public.canvas_tabs          FROM anon;
REVOKE ALL ON public.canvas_contributors  FROM anon;
REVOKE ALL ON public.users                FROM anon;

-- Reaffirm `authenticated`'s table grants. These are project-default but
-- making them explicit here means this migration is self-contained.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvases            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_tabs         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvas_contributors TO authenticated;
GRANT SELECT, INSERT, UPDATE          ON public.users              TO authenticated;
-- Note: users is intentionally non-DELETE — extension never deletes user rows.

-- ----------------------------------------------------------------------------
-- 4) Helper: extracts the JWT's workspaces[] claim as a text array. Keeps
--    every policy below readable, and centralizes the JSONB-to-text-array
--    coercion in one place we can update if the claim shape ever changes.
--
--    auth.jwt() returns the JSONB payload of the JWT presented by the caller.
--    `workspaces` is a JSON array of workspace IDs (stringified, per the
--    clay-auth-mint signing code). We turn it into a text[] for `= ANY`
--    comparisons against text-typed columns like canvases.workspace_id.
--
--    Marked STABLE + SECURITY INVOKER. It reads no tables; it just unpacks
--    the request-scoped JWT. Safe to use in every policy below without
--    triggering planning loops.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cb_caller_workspaces()
  RETURNS text[]
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
  -- Pin search_path so a malicious schema can't shadow jsonb_array_elements_text.
  -- Recommended by the Supabase database linter (lint 0011_function_search_path_mutable).
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(auth.jwt() -> 'workspaces')),
    ARRAY[]::text[]
  );
$$;

REVOKE ALL ON FUNCTION public.cb_caller_workspaces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cb_caller_workspaces() TO authenticated;

-- ----------------------------------------------------------------------------
-- 5) canvases — a row is visible/mutable iff its workspace_id is in the
--    caller's JWT workspaces claim. Rows with NULL workspace_id are
--    intentionally unreachable: the extension always supplies one, so a
--    NULL would indicate corruption (or an old test row from before the
--    workspace_id column was populated).
-- ----------------------------------------------------------------------------
CREATE POLICY canvases_member_only
  ON public.canvases
  FOR ALL
  TO authenticated
  USING (
    workspace_id IS NOT NULL
    AND workspace_id = ANY (public.cb_caller_workspaces())
  )
  WITH CHECK (
    workspace_id IS NOT NULL
    AND workspace_id = ANY (public.cb_caller_workspaces())
  );

-- ----------------------------------------------------------------------------
-- 6) canvas_tabs — piggyback on the parent canvases row. A tab is accessible
--    iff the user can access the parent canvas. INSERT/UPDATE/DELETE check
--    the same precondition. We don't need to denormalize workspace_id onto
--    canvas_tabs because every tab has at most one parent canvas (workbook_id
--    is the FK), so the join is bounded to 1 row.
-- ----------------------------------------------------------------------------
CREATE POLICY canvas_tabs_member_only
  ON public.canvas_tabs
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_tabs.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_tabs.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  );

-- ----------------------------------------------------------------------------
-- 7) canvas_contributors — split policies by command so we can apply different
--    rules:
--
--    - SELECT: anyone with workspace access to the parent canvas can read all
--      contributor rows on that canvas (the collaborators widget needs this
--      to render avatars + names).
--    - INSERT/UPDATE/DELETE: only the calling user can mutate their own row.
--      You can't INSERT a contributor row for someone else, can't update
--      their last_accessed_at, can't delete them.
--
--    The auth.jwt() ->> 'sub' claim is the Clay user ID (stringified), set
--    by clay-auth-mint from the /v3/me response. Matches the user_id column
--    semantically (both are stringified Clay user ids).
-- ----------------------------------------------------------------------------
CREATE POLICY canvas_contributors_select
  ON public.canvas_contributors
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_contributors.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  );

CREATE POLICY canvas_contributors_insert_self
  ON public.canvas_contributors
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.jwt() ->> 'sub'
    AND EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_contributors.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  );

CREATE POLICY canvas_contributors_update_self
  ON public.canvas_contributors
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.jwt() ->> 'sub'
    AND EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_contributors.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  )
  WITH CHECK (
    user_id = auth.jwt() ->> 'sub'
    AND EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_contributors.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  );

CREATE POLICY canvas_contributors_delete_self
  ON public.canvas_contributors
  FOR DELETE
  TO authenticated
  USING (
    user_id = auth.jwt() ->> 'sub'
    AND EXISTS (
      SELECT 1 FROM public.canvases c
      WHERE c.workbook_id = canvas_contributors.workbook_id
        AND c.workspace_id IS NOT NULL
        AND c.workspace_id = ANY (public.cb_caller_workspaces())
    )
  );

-- ----------------------------------------------------------------------------
-- 8) users — split policies:
--
--    - SELECT: own row, OR any user who is a contributor on a canvas the
--      caller can see. canvas_contributors RLS does the workspace filtering
--      inside the EXISTS subquery (Postgres applies RLS to subqueries the
--      same way it applies to top-level queries), so we don't have to
--      re-encode the workspace check here.
--    - INSERT: self only. Matches the user-upsert behavior in src/user.js.
--    - UPDATE: self only. Matches the user-upsert behavior in src/user.js.
--
--    Why not "select any authenticated user" — that would let any Clay rep
--    enumerate every user who's ever used the extension, including Clay
--    employees across workspaces they have no business knowing about. The
--    EXISTS join keeps the surface tight while still letting the
--    collaborators widget paint avatars.
-- ----------------------------------------------------------------------------
CREATE POLICY users_self_or_shared_workspace
  ON public.users
  FOR SELECT
  TO authenticated
  USING (
    id = auth.jwt() ->> 'sub'
    OR EXISTS (
      SELECT 1 FROM public.canvas_contributors cc
      WHERE cc.user_id = users.id
    )
  );

CREATE POLICY users_insert_self
  ON public.users
  FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.jwt() ->> 'sub');

CREATE POLICY users_update_self
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (id = auth.jwt() ->> 'sub')
  WITH CHECK (id = auth.jwt() ->> 'sub');

COMMIT;
