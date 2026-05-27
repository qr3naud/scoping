// Supabase Edge Function: sfdc-search-opportunities
// Searches Salesforce for Opportunities matching a query string.
// Returns up to 10 results, ordered by most-recently-modified.
//
// Direct port of the calculator's sfdc-search-opportunities function with
// two changes: auth uses Clay's JWT via requireClayAuth (instead of
// Supabase Auth's getUser), and the RecordType field projection (calc-
// specific for renewal gating) is dropped — brainstorm doesn't need it.
//
// Uses SOSL `FIND {q*} IN NAME FIELDS RETURNING Opportunity(...)` against
// /services/data/v60.0/search. SOSL hits SFDC's full-text search index,
// avoiding the SOQL `LIKE '%q%'` full-table scan we'd otherwise need.
//
// Caching: a 30-second module-level LRU dedupes identical queries hitting
// the same warm Edge Function instance, collapsing keystroke storms into
// a single SFDC call.
//
// Request body: { q: string }
// Response:     { records: SearchedOpportunity[], instanceUrl: string }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  callSalesforce,
  corsHeaders,
  getSalesforceCredentials,
  SalesforceAuthError,
} from "../_shared/sfdcAuth.ts";
import { requireClayAuth, ClayAuthError } from "../_shared/requireClayAuth.ts";

interface SearchedOpportunity {
  id: string;
  name: string;
  stageName: string | null;
  closeDate: string | null;
  accountName: string | null;
  ownerEmail: string | null;
  amount: number | null;
  url: string;
}

interface SoslOpportunityRecord {
  Id: string;
  Name: string;
  StageName: string | null;
  CloseDate: string | null;
  Amount: number | null;
  Account: { Name: string | null } | null;
  Owner: { Email: string | null } | null;
}

interface SoslSearchResponse {
  searchRecords: SoslOpportunityRecord[];
}

// SOSL reserves more characters than SOQL `LIKE`: any of these need to be
// backslash-escaped when embedded in a FIND clause, otherwise SFDC returns
// MALFORMED_SEARCH. Order matters: backslash first so we don't double-escape
// the escapes we just inserted.
const SOSL_RESERVED = /[\\?&|!{}()\[\]^~*:"'+\-]/g;
function escapeSoslReserved(input: string): string {
  return input.replace(SOSL_RESERVED, "\\$&");
}

// Module-level LRU. Edge Function instances persist across invocations until
// the runtime evicts them, so a small cache keyed on the trimmed lowercase
// query collapses bursts of identical searches into a single SFDC call.
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX = 64;
interface SearchCacheEntry {
  expires: number;
  payload: { records: SearchedOpportunity[]; instanceUrl: string };
}
const searchCache = new Map<string, SearchCacheEntry>();

function getCachedSearch(key: string): SearchCacheEntry["payload"] | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    searchCache.delete(key);
    return null;
  }
  // Touch for LRU recency.
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.payload;
}

function setCachedSearch(key: string, payload: SearchCacheEntry["payload"]): void {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { expires: Date.now() + SEARCH_CACHE_TTL_MS, payload });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Phase-1 JWT + internal-workspace gate. requireClayAuth throws on
    // 401/403; the catch below renders the right response.
    const claims = await requireClayAuth(req);
    console.log(`[sfdc-search] user=${claims.sub} email=${claims.email}`);

    const body = await req.json().catch(() => null);
    const q = typeof body?.q === "string" ? body.q.trim() : "";
    // SOSL requires terms of at least 2 characters. The picker UI also gates
    // at this length, but re-check here to short-circuit cheaply when a
    // direct caller passes a single character.
    if (q.length < 2) {
      return new Response(JSON.stringify({ records: [], instanceUrl: "" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cacheKey = q.toLowerCase();
    const cachedPayload = getCachedSearch(cacheKey);
    if (cachedPayload) {
      return new Response(JSON.stringify(cachedPayload), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // SOSL `FIND {term*} IN NAME FIELDS RETURNING Opportunity(...)` uses
    // SFDC's search index (cheap) instead of a full-table scan with leading
    // wildcards. Trailing `*` enables prefix matching for the as-you-type
    // experience. The inner `WHERE IsClosed = false` filters out Closed Won
    // and Closed Lost stages so reps only see active deals.
    const escaped = escapeSoslReserved(q);
    const sosl = [
      `FIND {${escaped}*} IN NAME FIELDS`,
      "RETURNING Opportunity(",
      "Id, Name, StageName, CloseDate, Amount, Account.Name, Owner.Email",
      "WHERE IsClosed = false",
      "ORDER BY LastModifiedDate DESC",
      "LIMIT 10",
      ")",
    ].join(" ");

    const { instanceUrl } = await getSalesforceCredentials();
    const queryPath = `/services/data/v60.0/search?q=${encodeURIComponent(sosl)}`;
    const queryResult = await callSalesforce<SoslSearchResponse>(queryPath);

    const records: SearchedOpportunity[] = (queryResult.searchRecords ?? []).map((r) => ({
      id: r.Id,
      name: r.Name,
      stageName: r.StageName,
      closeDate: r.CloseDate,
      accountName: r.Account?.Name ?? null,
      ownerEmail: r.Owner?.Email ?? null,
      amount: r.Amount,
      url: `${instanceUrl.replace(/\/$/, "")}/lightning/r/Opportunity/${r.Id}/view`,
    }));

    const payload = { records, instanceUrl };
    setCachedSearch(cacheKey, payload);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof ClayAuthError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("sfdc-search-opportunities error:", err);
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
