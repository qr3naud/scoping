#!/usr/bin/env node
// Standalone Salesforce JWT Bearer Flow connection tester.
//
// Reads credentials from a per-environment dotenv file under
// `apps/mono-calculator/scripts/sfdc/`, builds a signed JWT, exchanges it for
// an access token, and runs a sample SOQL query against the Opportunity object
// to confirm end-to-end auth + read access.
//
// Usage:
//   # Default: prod
//   node apps/mono-calculator/scripts/sfdc/test-connection.mjs
//   # Explicit environment select (loads .env.prod or .env.uat):
//   SFDC_ENV=prod node apps/mono-calculator/scripts/sfdc/test-connection.mjs
//   SFDC_ENV=uat  node apps/mono-calculator/scripts/sfdc/test-connection.mjs
//
// Env-file resolution order (first existing wins):
//   1. scripts/sfdc/.env.${SFDC_ENV}    (preferred)
//   2. scripts/sfdc/.env                (legacy fallback, prints a warning)
//
// Required keys in the dotenv file (see .env.example):
//   SFDC_CLIENT_ID, SFDC_USERNAME, SFDC_LOGIN_URL, SFDC_PRIVATE_KEY_PATH

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const VALID_ENVS = new Set(['prod', 'uat']);

function resolveTargetEnv() {
  const raw = (process.env.SFDC_ENV || 'prod').toLowerCase();
  if (!VALID_ENVS.has(raw)) {
    console.error(`Invalid SFDC_ENV='${raw}'. Use 'prod' or 'uat'.`);
    process.exit(1);
  }
  return raw;
}

function loadDotenv(targetEnv) {
  const candidate = resolve(SCRIPT_DIR, `.env.${targetEnv}`);
  const legacy = resolve(SCRIPT_DIR, '.env');
  let envPath = null;
  if (existsSync(candidate)) {
    envPath = candidate;
  } else if (existsSync(legacy)) {
    envPath = legacy;
    console.warn(`WARN: ${candidate} not found; falling back to legacy ${legacy}.`);
    console.warn(`      Rename it to .env.${targetEnv} so future runs are unambiguous.`);
  } else {
    return null;
  }
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
  return envPath;
}

function warnOnLoginUrlMismatch(targetEnv, loginUrl) {
  if (!loginUrl) return;
  const isSandboxUrl = loginUrl.includes('test.salesforce.com');
  const isProdUrl = loginUrl.includes('login.salesforce.com');
  if (targetEnv === 'prod' && isSandboxUrl) {
    console.warn('WARN: SFDC_ENV=prod but SFDC_LOGIN_URL points at the sandbox endpoint.');
    console.warn('      Production should use https://login.salesforce.com.');
  } else if (targetEnv === 'uat' && isProdUrl) {
    console.warn('WARN: SFDC_ENV=uat but SFDC_LOGIN_URL points at the production endpoint.');
    console.warn('      Sandboxes should use https://test.salesforce.com.');
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildJwt({ clientId, username, audience, privateKeyPem }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientId,
    sub: username,
    aud: audience,
    exp: now + 180,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(privateKeyPem)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signingInput}.${signature}`;
}

async function exchangeJwtForToken({ jwt, loginUrl }) {
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
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Token exchange failed (${res.status})`);
    err.detail = json;
    throw err;
  }
  return json;
}

async function runSampleQuery({ instanceUrl, accessToken }) {
  const soql = 'SELECT Id, Name, StageName, CloseDate, Account.Name FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 3';
  const url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`SOQL query failed (${res.status})`);
    err.detail = json;
    throw err;
  }
  return json;
}

function explainTokenError(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const { error, error_description } = detail;
  const hints = {
    invalid_grant: {
      'user hasn\'t approved this consumer': 'The integration user is not pre-authorized for this app. Add a permission set with this app under "Selected Permission Sets" in the External Client App > Policies, AND assign that same permission set to the integration user.',
      'invalid assertion': 'The JWT signature did not verify. Common causes: wrong private key, the wrong cert was uploaded to the External Client App, or "Enable JWT Bearer Flow" is not actually checked.',
      'audience': 'The "aud" claim does not match. For sandboxes use https://test.salesforce.com, for production use https://login.salesforce.com.',
      'user does not exist': 'SFDC_USERNAME is not a valid user in this org. Sandbox usernames usually need a suffix like .fulluat or .sandbox.',
      'inactive user': 'The integration user account is deactivated. Reactivate it in Setup > Users.',
    },
    invalid_client_id: {
      '': 'The Consumer Key (SFDC_CLIENT_ID) does not match any app in this org. Double-check it from the External Client App > Settings > OAuth Settings.',
    },
    invalid_app_access: {
      '': 'The user is not authorized to use this app. Re-check the permission set assignment to the integration user.',
    },
  };
  const branch = hints[error];
  if (!branch) return null;
  for (const [needle, msg] of Object.entries(branch)) {
    if (!needle || (error_description || '').toLowerCase().includes(needle)) {
      return msg;
    }
  }
  return null;
}

async function main() {
  const targetEnv = resolveTargetEnv();
  console.log(`Target org: ${targetEnv.toUpperCase()}`);
  const envPath = loadDotenv(targetEnv);
  if (envPath) console.log(`Loaded env: ${envPath}`);

  const clientId = process.env.SFDC_CLIENT_ID;
  const username = process.env.SFDC_USERNAME;
  const loginUrl = process.env.SFDC_LOGIN_URL;
  const keyPath = process.env.SFDC_PRIVATE_KEY_PATH;

  const missing = Object.entries({ SFDC_CLIENT_ID: clientId, SFDC_USERNAME: username, SFDC_LOGIN_URL: loginUrl, SFDC_PRIVATE_KEY_PATH: keyPath })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error(`Copy scripts/sfdc/.env.example to scripts/sfdc/.env.${targetEnv} and fill in values.`);
    process.exit(1);
  }

  warnOnLoginUrlMismatch(targetEnv, loginUrl);

  const resolvedKeyPath = resolve(process.cwd(), keyPath);
  if (!existsSync(resolvedKeyPath)) {
    console.error(`Private key not found at: ${resolvedKeyPath}`);
    process.exit(1);
  }
  const privateKeyPem = readFileSync(resolvedKeyPath, 'utf8');

  console.log('Building JWT...');
  console.log(`  iss (Consumer Key): ${clientId.slice(0, 12)}...`);
  console.log(`  sub (Username):     ${username}`);
  console.log(`  aud (Login URL):    ${loginUrl}`);
  console.log(`  Private key:        ${resolvedKeyPath}`);

  const jwt = buildJwt({ clientId, username, audience: loginUrl, privateKeyPem });

  console.log('\nExchanging JWT for access token...');
  let tokenResponse;
  try {
    tokenResponse = await exchangeJwtForToken({ jwt, loginUrl });
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    if (err.detail) {
      console.error('Salesforce response:', JSON.stringify(err.detail, null, 2));
      const hint = explainTokenError(err.detail);
      if (hint) console.error(`\nHint: ${hint}`);
    }
    process.exit(1);
  }
  const { access_token, instance_url, scope, token_type } = tokenResponse;
  console.log('  Access token received.');
  console.log(`  Instance URL: ${instance_url}`);
  console.log(`  Token type:   ${token_type}`);
  console.log(`  Scopes:       ${scope}`);

  console.log('\nRunning sample SOQL query against Opportunity...');
  let queryResult;
  try {
    queryResult = await runSampleQuery({ instanceUrl: instance_url, accessToken: access_token });
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    if (err.detail) console.error('Salesforce response:', JSON.stringify(err.detail, null, 2));
    process.exit(1);
  }

  console.log(`  Total opportunities found: ${queryResult.totalSize}`);
  if (queryResult.records?.length) {
    console.log('  Sample records:');
    for (const opp of queryResult.records) {
      console.log(`    - ${opp.Id}  ${opp.Name}  [${opp.StageName}]  account=${opp.Account?.Name ?? 'n/a'}`);
    }
  } else {
    console.log('  (no opportunities visible to this user — fine for a fresh sandbox; for prod, check the integration user has Read on Opportunity)');
  }

  console.log('\nSUCCESS: Salesforce connection works end-to-end.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
