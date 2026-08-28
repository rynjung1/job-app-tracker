import type { JobPageParser, JobPostingData } from './types'

// Deliberately broad rather than enumerating known path segments (view,
// search-results, collections, ...) — a prior version enumerated
// "search" and missed the real "/jobs/search-results/" split-pane path,
// so detect() silently never fired there.
const JOB_PAGE_PATH = /^\/jobs\//

interface JobPostingJsonLd {
  '@type'?: string
  title?: string
  hiringOrganization?: { name?: string }
  jobLocation?: {
    address?: {
      addressLocality?: string | null
      addressRegion?: string | null
      addressCountry?: string | null
    }
  }
}

// LinkedIn embeds schema.org/JobPosting JSON-LD for SEO on the LOGGED-OUT
// guest template only — confirmed absent (0 script tags) on the real
// authenticated SPA page, which is the only page this content script ever
// runs on. This path is effectively dead in practice; kept as free
// insurance in case a future LinkedIn build reintroduces it, not because
// it's expected to fire. extractFromDom() below is the real primary path.
function readJobPostingJsonLd(): JobPostingJsonLd | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]')
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? '') as JobPostingJsonLd
      if (data && data['@type'] === 'JobPosting') return data
    } catch {
      // Not valid JSON, or not the JobPosting block (LinkedIn also emits an
      // ItemList block on some pages) — try the next script tag.
    }
  }
  return null
}

function formatLocation(jsonLd: JobPostingJsonLd): string | null {
  const address = jsonLd.jobLocation?.address
  if (!address) return null
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  )
  return parts.length > 0 ? parts.join(', ') : null
}

// document.title carries title/company on the authenticated SPA — confirmed
// it DOES update on client-side job navigation (not a given for an SPA).
// Format confirmed on one real posting: "{Title} | {Company} | LinkedIn".
// Anchored from the END rather than a naive 3-way split, since a job title
// can itself contain " | " (e.g. "Engineer | Backend Team"), which would
// corrupt a left-to-right split — the trailing "LinkedIn" literal and the
// company segment right before it are far less likely to contain a pipe.
// Only confirmed against one real posting so far — needs 2-3 more before
// this pattern counts as settled, per the working agreement.
function parseDocumentTitle(): { title?: string; company?: string } {
  const parts = document.title.split(' | ')
  if (parts.length < 3 || parts[parts.length - 1] !== 'LinkedIn') return {}
  const company = parts[parts.length - 2]?.trim()
  const title = parts
    .slice(0, parts.length - 2)
    .join(' | ')
    .trim()
  return { title: title || undefined, company: company || undefined }
}

const AGO_PATTERN = /\bago$/i
const APPLICANTS_PATTERN = /applicant/i

// The authenticated page has NO stable attribute for location — no class,
// id, aria-*, data-*, or title attribute distinguishes it from its two
// siblings (date-posted, applicant-count), which all share the exact same
// two hashed classes (confirmed via direct DOM inspection on a real
// posting). This is the most fragile piece of this parser: it depends on
// DOM structure and text shape in a purely decorative metadata row with no
// accessibility or SEO reason to stay stable. Most likely thing to
// silently break on a future LinkedIn redesign — if location extraction
// stops working, look here first.
//
// Anchored on the company-profile link (a[href*="/company/"]) rather than
// a fixed number of parentElement hops, since exact nesting depth isn't
// guaranteed to stay fixed either — searches outward from it, level by
// level, for the first ancestor containing a "X ago" text node, which is
// what actually identifies the metadata row.
function findLocationSiblingSpans(companyLink: Element): Element[] | null {
  let ancestor: Element | null = companyLink.parentElement
  for (let i = 0; i < 6 && ancestor; i++, ancestor = ancestor.parentElement) {
    const agoSpan = Array.from(ancestor.querySelectorAll('span')).find((span) =>
      AGO_PATTERN.test(span.textContent?.trim() ?? ''),
    )
    if (agoSpan?.parentElement) {
      return Array.from(agoSpan.parentElement.children).filter((el) => el.tagName === 'SPAN')
    }
  }
  return null
}

// Content-shape validation, not pure position: rejects candidates that
// look like the two known non-location siblings, rather than blindly
// trusting "first span" — degrades to null (not a wrong guess) if the
// order ever changes or location is absent (e.g. some remote postings).
function extractLocationFromDom(companyLink: Element | null): string | null {
  if (!companyLink) return null
  const spans = findLocationSiblingSpans(companyLink)
  if (!spans) return null
  const location = spans
    .map((el) => el.textContent?.trim() ?? '')
    .find((text) => text.length > 0 && !AGO_PATTERN.test(text) && !APPLICANTS_PATTERN.test(text))
  return location || null
}

// No stable class/id/aria/data attribute exists anywhere on the
// authenticated SPA (confirmed via direct DOM inspection) — h1 count is 0,
// every class is hashed/atomic CSS, JSON-LD doesn't exist here at all (see
// readJobPostingJsonLd comment above). Every field below comes from a
// signal that isn't DOM styling: document.title for title, with the
// company-profile link preferred over document.title's company segment
// when both are available (a single clean string beats depending on the
// pipe-split heuristic holding), and structural/content-shape inference
// for location (see findLocationSiblingSpans — the most fragile piece of
// this parser).
function extractFromDom(): { title?: string; company?: string; location?: string | null } {
  const { title, company: titleCompany } = parseDocumentTitle()
  const companyLink = document.querySelector('a[href*="/company/"]')
  const company = companyLink?.textContent?.trim() || titleCompany
  const location = extractLocationFromDom(companyLink)
  return { title, company, location }
}

// Split-pane search results carry the job ID only in ?currentJobId=, not
// the path — naively stripping query params (as this used to do
// unconditionally) collapsed every split-pane application to the same
// generic /jobs/search-results/ URL, a real confirmed bug, not
// hypothetical. Reconstruct the canonical per-job URL from the ID in that
// case; direct /jobs/view/{id}/ pages already carry the ID in the path
// and are untouched by this branch.
function resolveCanonicalJobUrl(): string {
  const currentJobId = new URLSearchParams(window.location.search).get('currentJobId')
  if (currentJobId) {
    return `https://www.linkedin.com/jobs/view/${currentJobId}/`
  }
  return window.location.href.split('?')[0]
}

export const linkedinParser: JobPageParser = {
  siteId: 'linkedin',

  // No container-class check — this page's classes are hashed/atomic CSS
  // with no stable or semantic names (confirmed via real DOM inspection,
  // not assumed). The only call site (content/linkedin.ts, gating the
  // apply-button bind attempt) already fails safe when no Apply anchor is
  // found, so a coarser URL-only check here doesn't create a correctness
  // risk — it just means the bind attempt is tried on more /jobs/ pages,
  // which is cheap and self-limiting.
  detect() {
    return JOB_PAGE_PATH.test(window.location.pathname)
  },

  extract() {
    const jsonLd = readJobPostingJsonLd()

    let title = typeof jsonLd?.title === 'string' ? jsonLd.title.trim() : undefined
    let company =
      typeof jsonLd?.hiringOrganization?.name === 'string'
        ? jsonLd.hiringOrganization.name.trim()
        : undefined
    let location = jsonLd ? formatLocation(jsonLd) : null

    if (!title || !company || !location) {
      const domFallback = extractFromDom()
      title = title ?? domFallback.title
      company = company ?? domFallback.company
      location = location ?? domFallback.location ?? null
    }

    if (!title || !company) return null

    const data: JobPostingData = {
      title,
      company,
      location,
      url: resolveCanonicalJobUrl(),
    }
    return data
  },

  getApplyButtonSelector() {
    // Confirmed via real DOM inspection across 4 live authenticated
    // postings (3 Easy Apply, 1 off-site): it's an <a>, not a <button>,
    // aria-label="LinkedIn Apply to this job" and href into
    // /jobs/view/{id}/apply/ — consistent across all 3 Easy Apply cases,
    // hence the prefix match rather than requiring an exact string.
    //
    // This also turned out to self-scope to Easy-Apply-only with zero
    // extra logic: the one off-site posting checked has a completely
    // different label ("Apply on company website") and its href routes
    // through LinkedIn's own /safety/go/?url=... redirect wrapper rather
    // than pointing at /jobs/view/.../apply/ directly — so no separate
    // href check is needed to enforce the Easy-Apply-only scope boundary
    // documented in CLAUDE.md.
    return 'a[aria-label^="LinkedIn Apply"]'
  },
}
