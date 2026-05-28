// Supabase Edge Function: dust-proxy
//
// Server-side proxy that holds the shared Dust API key and forwards
// allow-listed requests to https://dust.tt. Replaces the previous client-
// side flow where every rep pasted their own Dust API key into the
// extension popover (src/dust-poc.js's renderKeyPrompt) — that flow
// distributed a shared workspace key to every rep and stored it in
// localStorage, which is now both unnecessary and a UX tax.
//
// Auth: Phase-1 Clay JWT + internal-workspace gate via requireClayAuth.
// Even with a valid JWT the agent must be on the AGENT_ALLOWLIST so a
// stolen extension bundle can't pivot the shared Dust key into arbitrary
// agent invocations.
//
// Routes (path suffix dispatch):
//   POST /dust-proxy/conversations
//     Body: { body: <DustConversationPayload> }
//     → POST https://dust.tt/api/v1/w/{wId}/assistant/conversations
//
//   GET  /dust-proxy/conversations?id={cId}
//     → GET https://dust.tt/api/v1/w/{wId}/assistant/conversations/{cId}
//        (poll an in-flight POC conversation for completion; read-only so
//         no agent allow-list check — requireClayAuth's internal-workspace
//         gate is sufficient)
//
//   GET  /dust-proxy/agents
//     → GET https://dust.tt/api/v1/w/{wId}/assistant/agent_configurations
//        (health-check / probe endpoint, mirrors the old probeKey call)

import { requireClayAuth, ClayAuthError } from "../_shared/requireClayAuth.ts";

const DUST_API_KEY = Deno.env.get("DUST_API_KEY");
const DUST_WORKSPACE_ID = Deno.env.get("DUST_WORKSPACE_ID");

// Only these agent IDs may be invoked through the proxy. Maps directly to
// the values src/dust-poc.js used to hard-code on the client. Extend as
// new agents come online; do NOT widen to "any agent in the workspace" —
// that turns this endpoint into a generic LLM gateway.
const AGENT_ALLOWLIST = new Set(
  (Deno.env.get("DUST_AGENT_ALLOWLIST") ?? "4CEcga0fGM")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const DUST_BASE_URL = "https://dust.tt";

// CORS mirrors what sfdcAuth.ts exposes for SFDC endpoints. Browsers
// preflight the Authorization header on every cross-origin POST.
const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function authErrorResponse(err: unknown): Response {
  if (err instanceof ClayAuthError) {
    return jsonResponse({ error: err.message }, err.status);
  }
  console.error("[dust-proxy] unexpected error:", err);
  return jsonResponse({ error: "internal error" }, 500);
}

// Walks the conversation payload looking for `configurationId` mentions and
// rejects any that aren't on the allow-list. Dust's create-conversation
// payload places agent mentions inside `message.mentions[]` of the inner
// message envelope. We accept that anywhere it appears in the tree — the
// extension may shape the envelope slightly differently in future and we
// don't want a typo in the proxy to bypass the gate.
function extractAgentIds(payload: unknown): string[] {
  const ids: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.configurationId === "string") {
      ids.push(obj.configurationId);
    }
    for (const v of Object.values(obj)) walk(v);
  }
  walk(payload);
  return ids;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!DUST_API_KEY || !DUST_WORKSPACE_ID) {
    console.error("[dust-proxy] missing DUST_API_KEY or DUST_WORKSPACE_ID");
    return jsonResponse({ error: "server misconfigured" }, 500);
  }

  let claims;
  try {
    claims = await requireClayAuth(req);
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const route = url.pathname.split("/").filter(Boolean).pop() ?? "";

  // ----- GET /agents — health check -----------------------------------------
  if (req.method === "GET" && route === "agents") {
    console.log(`[dust-proxy:agents] user=${claims.sub}`);
    try {
      const endpoint = `${DUST_BASE_URL}/api/v1/w/${DUST_WORKSPACE_ID}/assistant/agent_configurations`;
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${DUST_API_KEY}` },
        credentials: "omit",
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) {
        console.warn(`[dust-proxy:agents] non-OK ${res.status} ${res.statusText}`);
      }
      return new Response(JSON.stringify({ ok: res.ok, status: res.status, data }), {
        status: res.ok ? 200 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[dust-proxy:agents] fetch failed:", err);
      return jsonResponse({ error: "dust unreachable" }, 502);
    }
  }

  // ----- GET /conversations?id={cId} — poll an in-flight POC ----------------
  // Read-only fetch of an existing conversation so the client can poll for
  // the agent's reply (and the generated Google Doc link). No agent
  // allow-list gate here — reading a conversation can't pivot the shared
  // key into a new agent invocation, and requireClayAuth already restricts
  // this to internal-workspace users.
  if (req.method === "GET" && route === "conversations") {
    const conversationId = (url.searchParams.get("id") ?? "").trim();
    if (!conversationId) {
      return jsonResponse({ error: "missing `id` query param" }, 400);
    }
    console.log(
      `[dust-proxy:conversations:get] user=${claims.sub} id=${conversationId}`,
    );
    try {
      const endpoint = `${DUST_BASE_URL}/api/v1/w/${DUST_WORKSPACE_ID}/assistant/conversations/${encodeURIComponent(conversationId)}`;
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${DUST_API_KEY}` },
        credentials: "omit",
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) {
        console.warn(
          `[dust-proxy:conversations:get] non-OK ${res.status} ${res.statusText}`,
        );
      }
      return new Response(
        JSON.stringify({
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          data,
          rawText: text || undefined,
        }),
        {
          status: res.ok ? 200 : (res.status >= 400 && res.status < 600 ? res.status : 502),
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (err) {
      console.error("[dust-proxy:conversations:get] fetch failed:", err);
      return jsonResponse({ error: "dust unreachable" }, 502);
    }
  }

  // ----- POST /conversations — create a Dust conversation -------------------
  if (req.method === "POST" && route === "conversations") {
    let body: { body?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body.body !== "object" || body.body === null) {
      return jsonResponse({ error: "missing or invalid `body` field" }, 400);
    }

    // Agent allow-list check. Reject if any mentioned agent isn't allowed.
    const referencedAgents = extractAgentIds(body.body);
    if (referencedAgents.length === 0) {
      return jsonResponse({ error: "no agent mentioned in payload" }, 400);
    }
    const disallowed = referencedAgents.filter((id) => !AGENT_ALLOWLIST.has(id));
    if (disallowed.length > 0) {
      return jsonResponse(
        { error: `disallowed agent(s): ${disallowed.join(", ")}` },
        403,
      );
    }

    console.log(
      `[dust-proxy:conversations] user=${claims.sub} agents=${referencedAgents.join(",")}`,
    );

    try {
      const endpoint = `${DUST_BASE_URL}/api/v1/w/${DUST_WORKSPACE_ID}/assistant/conversations`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DUST_API_KEY}`,
          "Content-Type": "application/json",
        },
        // Never send the proxy's own cookies (or anyone else's) to Dust.
        credentials: "omit",
        body: JSON.stringify(body.body),
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) {
        console.warn(
          `[dust-proxy:conversations] non-OK ${res.status} ${res.statusText}`,
          text ? text.slice(0, 500) : "(empty body)",
        );
      }
      return new Response(
        JSON.stringify({
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          data,
          rawText: text || undefined,
        }),
        {
          // Pass through SFDC-style status codes so the client SW can decide
          // whether to surface or retry without re-parsing the body.
          status: res.ok ? 200 : (res.status >= 400 && res.status < 600 ? res.status : 502),
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (err) {
      console.error("[dust-proxy:conversations] fetch failed:", err);
      return jsonResponse({ error: "dust unreachable" }, 502);
    }
  }

  return jsonResponse({ error: "not found" }, 404);
});
