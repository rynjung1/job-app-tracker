// A job posting URL from the recent list, for the popup's company link and
// "Open job posting", only if it's http(s). The URL comes from the page the
// user applied on and the sanitizer only caps length (lib/sanitize.ts), so a
// link is never built from any other scheme (javascript:, data:, ...).
export function safeJobUrl(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}
