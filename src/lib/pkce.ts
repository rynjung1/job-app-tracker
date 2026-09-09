// PKCE (RFC 7636) helpers for the hand-rolled Microsoft authorization-code
// flow — see CLAUDE.md's ExcelProvider notes for why this is hand-rolled
// rather than @azure/msal-browser (that SDK's browser detection assumes a
// `window` global and doesn't run inside an MV3 service worker).

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64UrlEncode(bytes)
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}
