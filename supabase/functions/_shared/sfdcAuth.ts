// Shared helper: authenticate to Salesforce via the JWT Bearer Flow.
//
// Returns an access token + the SFDC instance URL the token is bound to.
// Tokens are cached in module memory so consecutive invocations of the
// same warm edge function instance reuse the same token until ~30 minutes
// before its (assumed) hourly expiry.
//
// Required env vars:
//   SFDC_CLIENT_ID         Consumer Key of the External Client App.
//   SFDC_USERNAME          Integration user's username.
//   SFDC_LOGIN_URL         https://test.salesforce.com (sandbox) or https://login.salesforce.com.
//   SFDC_PRIVATE_KEY       The PEM-encoded RSA private key, full text including headers.

interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  token_type: string;
  scope?: string;
  id?: string;
  issued_at?: string;
}

interface CachedToken {
  accessToken: string;
  instanceUrl: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

const TOKEN_TTL_MS = 30 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const stripped = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8Bytes(pem);
  return await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function buildJwt(params: {
  clientId: string;
  username: string;
  audience: string;
  privateKeyPem: string;
}): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: params.clientId,
    sub: params.username,
    aud: params.audience,
    exp: now + 180,
  };
  const encoder = new TextEncoder();
  const encodedHeader = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importPrivateKey(params.privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export class SalesforceAuthError extends Error {
  detail: unknown;
  constructor(message: string, detail: unknown) {
    super(message);
    this.name = 'SalesforceAuthError';
    this.detail = detail;
  }
}

export interface SalesforceCredentials {
  accessToken: string;
  instanceUrl: string;
}

/**
 * Returns a valid Salesforce access token + instance URL, minting a new
 * one via JWT Bearer Flow when the cache is empty or stale.
 */
export async function getSalesforceCredentials(): Promise<SalesforceCredentials> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl };
  }

  const clientId = Deno.env.get('SFDC_CLIENT_ID');
  const username = Deno.env.get('SFDC_USERNAME');
  const loginUrl = Deno.env.get('SFDC_LOGIN_URL');
  const privateKeyPem = Deno.env.get('SFDC_PRIVATE_KEY');

  if (!clientId || !username || !loginUrl || !privateKeyPem) {
    throw new SalesforceAuthError(
      'Missing SFDC_* env vars on the edge function. Required: SFDC_CLIENT_ID, SFDC_USERNAME, SFDC_LOGIN_URL, SFDC_PRIVATE_KEY.',
      null,
    );
  }

  const jwt = await buildJwt({ clientId, username, audience: loginUrl, privateKeyPem });
  const tokenUrl = `${loginUrl.replace(/\/$/, '')}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) {
    throw new SalesforceAuthError(`Salesforce token exchange failed (${res.status})`, parsed);
  }
  const tokenResponse = parsed as SalesforceTokenResponse;
  cachedToken = {
    accessToken: tokenResponse.access_token,
    instanceUrl: tokenResponse.instance_url,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  return { accessToken: tokenResponse.access_token, instanceUrl: tokenResponse.instance_url };
}

/**
 * Convenience wrapper: makes an authenticated call to a Salesforce REST
 * endpoint and returns the parsed JSON. Automatically retries once with
 * a fresh token if Salesforce returns 401 (token expired mid-flight).
 */
export async function callSalesforce<T = unknown>(
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { accessToken, instanceUrl } = await getSalesforceCredentials();
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${instanceUrl.replace(/\/$/, '')}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && attempt === 0) {
      cachedToken = null;
      continue;
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!res.ok) {
      throw new SalesforceAuthError(`Salesforce API call failed (${res.status})`, parsed);
    }
    return parsed as T;
  }
  throw new SalesforceAuthError('Salesforce API call failed after retry', null);
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform',
};
