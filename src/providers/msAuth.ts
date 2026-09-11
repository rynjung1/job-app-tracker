import { generateCodeChallenge, generateCodeVerifier } from '../lib/pkce'
import { MS_TOKEN_KEY } from '../lib/storageKeys'
import { fetchWithTimeout } from '../lib/fetchWithTimeout'
import { withMsTokenLock } from '../lib/msTokenLock'

// Hand-rolled PKCE authorization-code flow — not @azure/msal-browser. That
// SDK's browser-feature-detection assumes a `window` global and does not
// run inside an MV3 background service worker (real, open issue against
// the library confirms this). Mirrors googleSheets.ts's own pattern: a
// small, auditable, fetch-based client, not a new SDK dependency.

const CLIENT_ID = '7e19a8d9-4bcc-4c8f-b0b4-67ac4f4b53e1'
// "Personal Microsoft accounts only" registration — MUST use the literal
// `consumers` authority, not the Directory (tenant) ID shown in the Azure
// portal's Overview blade. A tenant-ID authority explicitly does not
// support personal accounts (confirmed against Microsoft's own docs).
const AUTHORITY = 'https://login.microsoftonline.com/consumers'
// offline_access is required to receive a refresh_token at all — omitting
// it doesn't error, the token response just silently has no refresh_token.
// Not a Graph resource permission, so it does not need to be (and does
// not) appear under API permissions in the Azure portal.
const SCOPES = 'offline_access Files.ReadWrite.AppFolder'

interface StoredMsToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(`${AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Token endpoint ${res.status}: ${text}`)
  }
  return JSON.parse(text) as TokenResponse
}

async function storeToken(response: TokenResponse, previousRefreshToken?: string): Promise<string> {
  const stored: StoredMsToken = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken ?? '',
    expiresAt: Date.now() + response.expires_in * 1000,
  }
  await chrome.storage.local.set({ [MS_TOKEN_KEY]: stored })
  return stored.accessToken
}

// The actual refresh_token exchange, extracted so it can be invoked either
// proactively (getValidExcelToken, on a timer) or reactively (excel.ts's
// withAuth, on a real 401 Graph returns before the local clock expected
// one) — same HTTP call either way, just a different trigger for it.
async function refreshExcelToken(refreshToken: string): Promise<string> {
  const response = await requestToken({
    client_id: CLIENT_ID,
    scope: SCOPES,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  return storeToken(response, refreshToken)
}

// Interactive — drives a real Microsoft sign-in/consent screen via
// chrome.identity.launchWebAuthFlow. There is no Microsoft equivalent of
// chrome.identity.getAuthToken()'s built-in Google support, so this has to
// be driven manually, unlike GoogleSheetsProvider.authenticate().
export async function authenticateExcel(): Promise<string> {
  const redirectUri = chrome.identity.getRedirectURL()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = generateCodeVerifier()

  const authorizeUrl = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`)
  authorizeUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString()

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  })
  if (!resultUrl) {
    throw new Error('launchWebAuthFlow returned no redirect URL')
  }

  const params = new URL(resultUrl).searchParams
  const error = params.get('error')
  if (error) {
    throw new Error(`Authorize endpoint error: ${error} — ${params.get('error_description')}`)
  }
  if (params.get('state') !== state) {
    throw new Error('OAuth state mismatch on redirect — aborting')
  }
  const code = params.get('code')
  if (!code) {
    throw new Error('No authorization code in redirect URL')
  }

  const tokenResponse = await requestToken({
    client_id: CLIENT_ID,
    scope: SCOPES,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  })
  return storeToken(tokenResponse)
}

// Fixed 2026-09-10 (cross-realm race): both functions below wrap their
// ENTIRE body in withMsTokenLock, including the fast path (cached token
// still valid, no refresh needed) — not just the refresh-and-write
// branch. This is a real, reviewer-caught distinction, not an arbitrary
// choice: the race here is two concurrent callers each *deciding* whether
// a refresh is needed from their own independent read of MS_TOKEN_KEY,
// not just an unsynchronized write — real repro confirmed two concurrent
// calls both reading the same soon-to-be-stale refreshToken and both
// successfully exchanging it (Microsoft doesn't invalidate a refresh
// token on reuse), silently orphaning one of the two newly-issued
// refresh tokens. Locking only the refresh branch would still let a
// second caller read a not-yet-expired token *outside* the lock while a
// concurrent caller is mid-refresh — harmless in that specific instant,
// but it misses the actual point: every caller needs to go through one
// serialized queue and re-read the (possibly just-refreshed) token once
// it acquires the lock, rather than two callers each deciding from
// whatever they independently happened to read first. Centralizing every
// provider call into the background worker's single realm (see
// background/messageRouter.ts) made this lock meaningful in the first
// place — it only actually closes the race now that every caller
// (drainOfflineQueue, appendRow, the popup's CANCEL_APPLICATION/
// SAVE_RESUME_VERSION messages, options's CONNECT_PROVIDER/
// RECONNECT_PROVIDER) runs in that one realm; before centralization, a
// same-realm-only lock like this would have done nothing for the
// original cross-realm version of this race.

// Non-interactive, proactive — used once a refresh_token exists. Mirrors
// googleSheets.ts's non-interactive getToken() path. Refreshes ahead of
// the local clock's expiresAt so the common case never even risks a 401.
export async function getValidExcelToken(): Promise<string> {
  return withMsTokenLock(async () => {
    const stored = await chrome.storage.local.get(MS_TOKEN_KEY)
    const token = stored[MS_TOKEN_KEY] as StoredMsToken | undefined
    if (!token) {
      throw new Error('No Microsoft token stored — call authenticateExcel() first')
    }
    if (Date.now() < token.expiresAt - 60_000) {
      return token.accessToken
    }
    if (!token.refreshToken) {
      throw new Error('Access token expired and no refresh token was ever stored')
    }
    return refreshExcelToken(token.refreshToken)
  })
}

// Non-interactive, reactive — used by excel.ts's withAuth when a Graph
// call itself returns a real 401, e.g. the user revoked this app's access
// server-side before the local expiresAt clock had any way to know. Skips
// the expiry check entirely and forces the exchange regardless, since a
// 401 means the access token is already known-bad right now. If the
// refresh token itself has been revoked too, this throws the real
// invalid_grant error from Microsoft's token endpoint — deliberately not
// caught here, so it propagates out of withAuth's retry and the row fails
// into the offline queue with a real, visible error rather than looping.
export async function forceRefreshExcelToken(): Promise<string> {
  return withMsTokenLock(async () => {
    const stored = await chrome.storage.local.get(MS_TOKEN_KEY)
    const token = stored[MS_TOKEN_KEY] as StoredMsToken | undefined
    if (!token?.refreshToken) {
      throw new Error('No refresh token stored — call authenticateExcel() first')
    }
    return refreshExcelToken(token.refreshToken)
  })
}
