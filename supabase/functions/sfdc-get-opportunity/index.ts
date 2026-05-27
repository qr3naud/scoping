// Supabase Edge Function: sfdc-get-opportunity
// Fetches a single Salesforce Opportunity by ID.
//
// Auth: Phase-1 Clay JWT + internal-workspace gate (see requireClayAuth).
//
// Strict ID validation (`^006[A-Za-z0-9]{12,15}$`) prevents this endpoint
// from being abused as a generic SObject fetcher — Opportunity IDs always
// start with the prefix `006`. Without this gate an attacker with a valid
// JWT could request `/sobjects/User/{id}` or `/sobjects/Account/{id}` etc.
// through this endpoint (well, no — `callSalesforce` injects the path
// fragment `/sobjects/Opportunity/...` literally — but defense in depth
// against a future bug that lets the ID flow into the path elsewhere).
//
// Request: GET ?id=006xxxxxxxxxxxxx
// Response: { id, name, stageName, closeDate, accountName, ownerEmail, amount, url }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  callSalesforce,
  corsHeaders,
  getSalesforceCredentials,
  SalesforceAuthError,
} from "../_shared/sfdcAuth.ts";
import { requireClayAuth, ClayAuthError } from "../_shared/requireClayAuth.ts";

interface SfdcOpportunityResponse {
  Id: string;
  Name: string;
  StageName: string | null;
  CloseDate: string | null;
  Amount: number | null;
  Account: { Name: string | null } | null;
  Owner: { Email: string | null } | null;
}

// Salesforce Object IDs are 15 (case-sensitive) or 18 (case-insensitive)
// characters. Opportunities use the `006` prefix. We accept 15..18 char
// payloads after the prefix, which covers the [15, 18] total range.
const OPP_ID_RE = /^006[A-Za-z0-9]{12,15}$/;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const claims = await requireClayAuth(req);

    const url = new URL(req.url);
    const id = url.searchParams.get("id") ?? "";
    if (!OPP_ID_RE.test(id)) {
      return new Response(JSON.stringify({ error: "invalid opportunity id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[sfdc-get-opp] user=${claims.sub} id=${id}`);

    // Use the SOQL composite query endpoint so we can request the relationship
    // fields (Account.Name, Owner.Email) in one round trip. The REST single-
    // record endpoint /sobjects/Opportunity/{id} doesn't traverse relationships
    // via the `?fields=` syntax.
    const soql = [
      "SELECT Id, Name, StageName, CloseDate, Amount, Account.Name, Owner.Email",
      "FROM Opportunity",
      `WHERE Id = '${id}'`,
      "LIMIT 1",
    ].join(" ");
    const queryPath = `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
    const result = await callSalesforce<{ records: SfdcOpportunityResponse[] }>(queryPath);
    const rec = result.records?.[0];
    if (!rec) {
      return new Response(JSON.stringify({ error: "opportunity not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { instanceUrl } = await getSalesforceCredentials();

    return new Response(
      JSON.stringify({
        id: rec.Id,
        name: rec.Name,
        stageName: rec.StageName,
        closeDate: rec.CloseDate,
        accountName: rec.Account?.Name ?? null,
        ownerEmail: rec.Owner?.Email ?? null,
        amount: rec.Amount,
        url: `${instanceUrl.replace(/\/$/, "")}/lightning/r/Opportunity/${rec.Id}/view`,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof ClayAuthError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("sfdc-get-opportunity error:", err);
    const detail = err instanceof SalesforceAuthError ? err.detail : null;
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Unknown error",
        detail,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
