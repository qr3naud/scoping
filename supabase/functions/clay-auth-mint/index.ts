// Supabase Edge Function: clay-auth-mint
//
// Converts a Clay session cookie into a Supabase-signed JWT scoped to the
// caller's actual workspace memberships in Clay.
//
// The cookie travels in the `x-clay-cookie` header (not raw `Cookie`, so
// Supabase's edge layer doesn't try to interpret it). The function:
//
//   1. Forwards the cookie to api.clay.com/v3/me to verify identity. Only
//      Clay's server can issue valid session cookies, so this is the trust
//      anchor — an attacker cannot forge or guess one.
//
//   2. Forwards the cookie to api.clay.com/v3/users/:id/workspaces to read
//      the authoritative workspace membership list. Clay's API enforces
//      `userId === current user` (see apps/api/v3/workspaces/routes/
//      workspaces.routes.ts:262), so an attacker cannot ask for someone
//      else's workspaces.
//
//   3. Signs a JWT with CB_JWT_SECRET (HS256, set to the project's JWT
//      secret from the Supabase dashboard). PostgREST and every Phase-2
//      Edge Function then verify the signature and read claims via
//      `auth.jwt()` (RLS) or `requireClayAuth` (proxies).
//
// The cookie is never logged, persisted, or forwarded to non-Clay hosts;
// `credentials: "omit"` on every outbound fetch is defense-in-depth against
// any accidental cookie propagation.

import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

// Custom env var name (NOT SUPABASE_JWT_SECRET): Supabase reserves the
// `SUPABASE_*` prefix, so you can't set that as a function secret. Copy the
// project's JWT secret from Supabase Dashboard → Settings → API → JWT Settings
// and `supabase secrets set CB_JWT_SECRET=<value>`.
const JWT_SECRET = Deno.env.get("CB_JWT_SECRET");
const CLAY_API = "https://api.clay.com";

// Workspaces whose members get the internal feature set. Mirrors the
// INTERNAL_WORKSPACES gate that requireClayAuth.ts uses for the SFDC/Dust
// proxies — same env var, same semantics. Default `4515` is Clay's own
// workspace.
const INTERNAL_WORKSPACES = (Deno.env.get("INTERNAL_WORKSPACES") ?? "4515")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Feature flags handed to extension users who belong to an internal workspace.
// Drives `__cb.hasFeature(...)` gating in the extension; NOT a security
// boundary (the Edge Function proxies independently verify INTERNAL_WORKSPACES
// via requireClayAuth). When adding a new internal-only feature, add its
// flag name here AND the matching `__cb.hasFeature("...")` check at the
// extension call site.
const INTERNAL_FEATURES = [
  "sfdc",
  "dust",
  "pricing_comparison",
  "gtme_export",
  "internal_branding",
] as const;

// Allow-list of origins that may invoke this function. The extension gets a
// fresh chrome-extension ID per install, so we accept any chrome-extension://
// origin AND any moz-extension:// origin (in case anyone runs the source in
// Firefox dev mode). The `null` origin (no Origin header) is rejected — every
// legitimate caller is a browser extension that sends one.
const ALLOWED_ORIGIN_PREFIXES = ["chrome-extension://", "moz-extension://"];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PREFIXES.some((p) => origin.startsWith(p));
}

function corsHeadersFor(origin: string | null): HeadersInit {
  // Echo back the allowed origin so the browser accepts the response.
  // We only get here if isAllowedOrigin already returned true.
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-clay-cookie",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "3600",
    Vary: "Origin",
  };
}

async function signKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

interface ClayMeResponse {
  id: number | string;
  email?: string | null;
  fullName?: string | null;
}

interface ClayWorkspace {
  id: number | string;
}

interface ClayWorkspacesResponse {
  results: ClayWorkspace[];
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeadersFor(origin);

  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }

  if (!isAllowedOrigin(origin)) {
    return new Response("forbidden origin", { status: 403 });
  }

  if (!JWT_SECRET) {
    console.error("[clay-auth-mint] missing CB_JWT_SECRET env var");
    return new Response("server misconfigured (CB_JWT_SECRET not set)", { status: 500, headers: cors });
  }

  // The extension SW puts the user's Clay session cookie(s) in this header.
  // It is intentionally NOT the standard `Cookie` header so Supabase's edge
  // doesn't strip / interpret it.
  const cookie = req.headers.get("x-clay-cookie");
  if (!cookie) {
    return new Response("missing x-clay-cookie", { status: 401, headers: cors });
  }

  // 1) Identity proof. Only a valid Clay session cookie gets a 200 here.
  let me: ClayMeResponse;
  try {
    const res = await fetch(`${CLAY_API}/v3/me`, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json" },
      credentials: "omit",
    });
    if (!res.ok) {
      return new Response("invalid clay session", { status: 401, headers: cors });
    }
    me = (await res.json()) as ClayMeResponse;
    if (me?.id == null) {
      return new Response("clay /v3/me returned no id", { status: 502, headers: cors });
    }
  } catch (err) {
    console.error("[clay-auth-mint] /v3/me fetch failed:", (err as Error).message);
    return new Response("clay /v3/me unreachable", { status: 502, headers: cors });
  }

  const userId = String(me.id);

  // 2) Authoritative workspace membership. Clay's route enforces that the
  //    caller can only ask for their own workspaces — attacker can't lie
  //    about which workspaces they belong to.
  let workspaces: string[];
  try {
    const res = await fetch(`${CLAY_API}/v3/users/${encodeURIComponent(userId)}/workspaces`, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json" },
      credentials: "omit",
    });
    if (!res.ok) {
      return new Response("clay workspace lookup failed", { status: 502, headers: cors });
    }
    const body = (await res.json()) as ClayWorkspacesResponse;
    workspaces = (body.results ?? []).map((w) => String(w.id));
  } catch (err) {
    console.error("[clay-auth-mint] workspaces fetch failed:", (err as Error).message);
    return new Response("clay workspaces unreachable", { status: 502, headers: cors });
  }

  // Derive the feature list from workspace membership. Internal users
  // (members of any INTERNAL_WORKSPACES) get the full internal set;
  // everyone else gets an empty list. The extension reads this off the
  // JWT via __cb.hasFeature(...) to decide which UI to render. The
  // SFDC/Dust proxies do NOT trust this claim — they re-check
  // INTERNAL_WORKSPACES server-side in requireClayAuth.
  const isInternal = workspaces.some((w) => INTERNAL_WORKSPACES.includes(w));
  const features: string[] = isInternal ? [...INTERNAL_FEATURES] : [];

  // 3) Sign the JWT with Supabase's project JWT secret. Supabase verifies
  //    the signature automatically; RLS sees the payload via auth.jwt().
  const key = await signKey(JWT_SECRET);
  const issuedAt = getNumericDate(0);
  const expiresAt = getNumericDate(60 * 60); // 1 hour
  const jwt = await create(
    { alg: "HS256", typ: "JWT" },
    {
      sub: userId,
      email: me.email ?? null,
      name: me.fullName ?? null,
      role: "authenticated",
      workspaces,
      features,
      iat: issuedAt,
      exp: expiresAt,
    },
    key,
  );

  // Audit. Never log the cookie itself; log just the user we minted for.
  console.log(
    `[clay-auth-mint] user=${userId} workspaces=${workspaces.length} features=${features.length}`,
  );

  return new Response(
    JSON.stringify({
      jwt,
      expiresAt: expiresAt * 1000,
      userId,
      email: me.email ?? null,
      workspaces,
      features,
    }),
    {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    },
  );
});
