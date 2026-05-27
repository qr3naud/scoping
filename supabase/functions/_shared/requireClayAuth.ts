// Shared helper: verify the Phase-1 Clay JWT presented by an extension caller
// and gate access to internal-only endpoints (sfdc-*, dust-proxy) on
// workspace membership.
//
// The JWT is minted by the clay-auth-mint Edge Function after Clay vouches
// for the caller's identity + workspaces. It's signed with the project's
// SUPABASE_JWT_SECRET (HS256), so any function with that env var can verify
// it without a network round trip.
//
// Every SFDC / Dust endpoint starts with:
//   const claims = await requireClayAuth(req);
//   console.log(`[fn-name] user=${claims.sub}`);
//
// Errors are thrown as ClayAuthError with a status code so the caller can
// produce a tidy 401 or 403 response and uniform CORS headers.

import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET");

// Comma-separated workspace IDs that are allowed to invoke SFDC / Dust
// endpoints. Defaults to Clay's internal workspace ("4515") so a stale or
// missing env var still fails closed for non-Clay users. Configure via:
//   supabase secrets set INTERNAL_WORKSPACES=4515,1234
const INTERNAL_WORKSPACES_RAW = Deno.env.get("INTERNAL_WORKSPACES") ?? "4515";
const INTERNAL_WORKSPACES = INTERNAL_WORKSPACES_RAW.split(",").map((s) => s.trim()).filter(Boolean);

export interface ClayClaims {
  sub: string;
  email: string | null;
  name?: string | null;
  role: "authenticated";
  workspaces: string[];
  iat: number;
  exp: number;
}

export class ClayAuthError extends Error {
  status: 401 | 403 | 500;
  constructor(status: 401 | 403 | 500, message: string) {
    super(message);
    this.name = "ClayAuthError";
    this.status = status;
  }
}

let cachedKey: CryptoKey | null = null;
async function getVerifyKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!JWT_SECRET) {
    throw new ClayAuthError(500, "server missing SUPABASE_JWT_SECRET");
  }
  cachedKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return cachedKey;
}

/**
 * Verifies the JWT in the request's Authorization header and additionally
 * checks that the caller is a member of at least one INTERNAL_WORKSPACES
 * value. Throws ClayAuthError on any failure; returns the parsed claims
 * on success.
 *
 * Defense-in-depth gate: even if a public-extension user somehow obtains a
 * valid JWT for their own workspace, they cannot invoke internal endpoints
 * unless they're a member of (e.g.) workspace 4515.
 */
export async function requireClayAuth(req: Request): Promise<ClayClaims> {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ClayAuthError(401, "missing or malformed Authorization header");
  }
  const token = match[1].trim();
  if (!token) throw new ClayAuthError(401, "empty bearer token");

  const key = await getVerifyKey();
  let claims: ClayClaims;
  try {
    claims = (await verify(token, key)) as ClayClaims;
  } catch {
    throw new ClayAuthError(401, "invalid JWT signature or expired token");
  }

  if (!claims || typeof claims.sub !== "string" || !Array.isArray(claims.workspaces)) {
    throw new ClayAuthError(401, "malformed JWT payload");
  }

  // Workspace membership gate. A public-extension user with a valid JWT for
  // their own workspace gets 403'd here — they can only reach the database
  // via RLS, not the proxy endpoints.
  const isInternal = claims.workspaces.some((w) => INTERNAL_WORKSPACES.includes(String(w)));
  if (!isInternal) {
    throw new ClayAuthError(403, "caller is not a member of an internal workspace");
  }

  return claims;
}

/**
 * Convenience: produces a Response from a ClayAuthError (or a generic 500
 * from any other exception). Pairs with `corsHeaders` from sfdcAuth.ts so
 * the response carries the right preflight headers.
 */
export function authErrorResponse(err: unknown, extraHeaders: HeadersInit = {}): Response {
  if (err instanceof ClayAuthError) {
    return new Response(err.message, {
      status: err.status,
      headers: { ...extraHeaders, "Content-Type": "text/plain" },
    });
  }
  console.error("[requireClayAuth] unexpected error:", err);
  return new Response("internal error", {
    status: 500,
    headers: { ...extraHeaders, "Content-Type": "text/plain" },
  });
}
